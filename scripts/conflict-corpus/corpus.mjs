/**
 * Materializes the conflict corpus (cases.mjs) as git trees in a bare
 * repository and records what real git does with each case:
 * `git merge-tree --write-tree -z --merge-base=<base> <ours> <theirs>`.
 *
 * Only blobs and trees are written (`hash-object`, `mktree`), so no commit
 * identity or date is involved and the corpus is byte-for-byte reproducible.
 * Global and system git config are ignored so user settings cannot change
 * the expected results; rename and directory-rename handling are pinned to
 * git's defaults.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export { allCases, HAND_CASES, textCases, treeCases } from './cases.mjs';

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' };
const MARKER = '.conflict-corpus';
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(repo, args, input) {
  const r = spawnSync('git', ['--git-dir', repo, ...args], { input, env: GIT_ENV, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r;
}

function gitOk(repo, args, input) {
  const r = git(repo, args, input);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr.toString()}`);
  return r.stdout;
}

/** Applies a patch to a flat path -> spec map. */
function applyPatch(base, patch) {
  const out = { ...base };
  for (const [path, spec] of Object.entries(patch)) {
    if (spec === null) delete out[path];
    else if (typeof spec === 'object' && 'from' in spec) {
      if (!(spec.from in base)) throw new Error(`corpus: {from: ${spec.from}} is not in the base`);
      out[path] = base[spec.from];
    } else out[path] = spec;
  }
  return out;
}

function leaf(spec) {
  if (typeof spec === 'string') return { mode: '100644', type: 'blob', content: Buffer.from(spec, 'utf8') };
  if ('symlink' in spec) return { mode: '120000', type: 'blob', content: Buffer.from(spec.symlink, 'utf8') };
  if ('gitlink' in spec) return { mode: '160000', type: 'commit', oid: spec.gitlink };
  return { mode: spec.mode ?? '100644', type: 'blob', content: Buffer.from(spec.content, 'utf8') };
}

/** Writes every distinct blob once; returns content(latin1) -> oid. */
function writeBlobs(repo, contents) {
  const unique = [...new Set(contents.map((c) => c.toString('latin1')))];
  const oids = new Map();
  if (unique.length === 0) return oids;
  const dir = join(repo, 'corpus-blobs');
  mkdirSync(dir, { recursive: true });
  const paths = unique.map((c, i) => {
    const p = join(dir, String(i));
    writeFileSync(p, Buffer.from(c, 'latin1'));
    return p;
  });
  const out = gitOk(repo, ['hash-object', '-w', '--no-filters', '--stdin-paths'], paths.join('\n') + '\n').toString().trim().split('\n');
  unique.forEach((c, i) => oids.set(c, out[i]));
  rmSync(dir, { recursive: true, force: true });
  return oids;
}

/**
 * Builds the tree for a flat map with `git mktree`, deepest directories
 * first, one batched mktree call per depth. Returns the root tree oid.
 */
function writeTrees(repo, trees, blobOids) {
  // node: dir path -> Map(name -> {mode, type, oid} | {dir: path})
  const all = [];
  for (const files of trees) {
    const dirs = new Map([['', new Map()]]);
    for (const [path, spec] of Object.entries(files)) {
      const parts = path.split('/');
      let dir = '';
      for (let i = 0; i < parts.length - 1; i++) {
        const child = dir ? `${dir}/${parts[i]}` : parts[i];
        if (!dirs.has(child)) {
          dirs.set(child, new Map());
          dirs.get(dir).set(parts[i], { dir: child });
        }
        dir = child;
      }
      const l = leaf(spec);
      const oid = l.oid ?? blobOids.get(l.content.toString('latin1'));
      dirs.get(dir).set(parts[parts.length - 1], { mode: l.mode, type: l.type, oid });
    }
    all.push(dirs);
  }

  const depth = (d) => (d === '' ? 0 : d.split('/').length);
  const maxDepth = Math.max(0, ...all.flatMap((dirs) => [...dirs.keys()].map(depth)));
  const resolved = all.map(() => new Map());
  for (let d = maxDepth; d >= 0; d--) {
    const batch = [];
    const owners = [];
    all.forEach((dirs, ti) => {
      for (const [path, entries] of dirs) {
        if (depth(path) !== d) continue;
        const lines = [...entries].map(([name, e]) => {
          if ('dir' in e) return `040000 tree ${resolved[ti].get(e.dir)}\t${name}`;
          return `${e.mode} ${e.type} ${e.oid}\t${name}`;
        });
        if (lines.length === 0) {
          resolved[ti].set(path, EMPTY_TREE);
          continue;
        }
        batch.push(lines.join('\n'));
        owners.push([ti, path]);
      }
    });
    if (batch.length === 0) continue;
    const out = gitOk(repo, ['mktree', '--missing', '--batch'], batch.join('\n\n') + '\n').toString().trim().split('\n');
    owners.forEach(([ti, path], i) => resolved[ti].set(path, out[i]));
  }
  return resolved.map((r) => r.get(''));
}

const KIND_BY_TITLE = {
  content: 'content',
  'add/add': 'add-add',
  'modify/delete': 'modify-delete',
  'rename/delete': 'rename',
  'rename/rename': 'rename',
  'rename/add': 'rename',
  'file location': 'rename',
  'directory rename split': 'rename',
  'file/directory': 'file-directory',
  'distinct types': 'typechange',
  submodule: 'content',
};

/** `kind:path1,path2` with paths sorted: the comparable form of one conflict. */
export function conflictKey(kind, paths) {
  return `${kind}:${[...new Set(paths)].sort().join(',')}`;
}

/**
 * Parses `merge-tree --write-tree -z` output into the tree oid and the
 * normalized conflict set. Paths git moved aside for a file/directory or
 * distinct-types conflict (`path~<label>`) are reported under their
 * original path; a binary warning makes that path's content conflict
 * `binary`; an add/add conflict stays `add-add` even for binary content.
 */
export function parseMergeTree(stdout, labels) {
  const tokens = stdout.toString('utf8').split('\0');
  const tree = tokens[0];
  let i = 1;
  while (i < tokens.length && /^\d{6} [0-9a-f]{40} \d\t/.test(tokens[i])) i++;
  if (tokens[i] === '') i++;
  const messages = [];
  while (i < tokens.length) {
    const count = Number(tokens[i]);
    if (!Number.isInteger(count) || tokens[i] === '') break;
    const paths = tokens.slice(i + 1, i + 1 + count);
    const type = tokens[i + 1 + count];
    const message = tokens[i + 2 + count] ?? '';
    messages.push({ paths, type, message });
    i += count + 3;
  }

  const strip = (p) => {
    for (const label of labels) if (p.endsWith(`~${label}`)) return p.slice(0, -label.length - 1);
    return p;
  };
  const byPath = new Map();
  const add = (kind, paths) => {
    const ps = [...new Set(paths.map(strip))].sort();
    const key = ps.join(',');
    const kinds = byPath.get(key) ?? new Set();
    kinds.add(kind);
    byPath.set(key, kinds);
  };
  for (const m of messages) {
    if (m.type === 'Auto-merging') continue;
    if (m.type === 'CONFLICT (binary)') {
      add('binary', m.paths);
      continue;
    }
    // A submodule that cannot be merged has its own types (`CONFLICT (submodule …)`) and a non-CONFLICT message.
    const title = m.type.startsWith('CONFLICT (submodule') ? 'submodule' : /^CONFLICT \(([^)]+)\)/.exec(m.message)?.[1];
    const kind = title ? KIND_BY_TITLE[title] : undefined;
    if (!kind) throw new Error(`merge-tree: unmapped conflict message ${JSON.stringify(m)}`);
    add(kind, m.paths);
  }
  const conflicts = [];
  for (const [key, kinds] of byPath) {
    if (kinds.has('add-add')) kinds.delete('binary');
    if (kinds.has('binary')) kinds.delete('content');
    if (kinds.has('add-add')) kinds.delete('content');
    for (const kind of kinds) conflicts.push(conflictKey(kind, key.split(',')));
  }
  return { tree, conflicts: conflicts.sort(), messages };
}

/**
 * Builds the corpus in `dir` (recreated; only a directory this module made,
 * marked by `.conflict-corpus`, is ever removed) and returns one record per
 * case with git's result.
 */
export function buildCorpus(dir, cases) {
  if (existsSync(dir)) {
    if (!existsSync(join(dir, MARKER))) throw new Error(`${dir} exists and is not a conflict corpus; refusing to replace it`);
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MARKER), 'generated by scripts/conflict-corpus\n');
  const repo = join(dir, 'corpus.git');
  const init = spawnSync('git', ['init', '-q', '--bare', repo], { env: GIT_ENV });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`);
  gitOk(repo, ['mktree'], '');

  const sides = cases.map((c) => {
    const ours = applyPatch(c.base, c.ours);
    const theirs = applyPatch(c.base, c.theirs);
    return [c.base, ours, theirs];
  });
  const blobs = sides.flatMap((s) => s.flatMap((files) => Object.values(files).map(leaf).filter((l) => l.content)));
  const blobOids = writeBlobs(
    repo,
    blobs.map((l) => l.content),
  );
  const treeOids = writeTrees(repo, sides.flat(), blobOids);

  return cases.map((c, i) => {
    const [base, ours, theirs] = treeOids.slice(i * 3, i * 3 + 3);
    const r = git(repo, ['merge-tree', '--write-tree', '-z', `--merge-base=${base}`, ours, theirs]);
    if (r.status !== 0 && r.status !== 1) throw new Error(`merge-tree failed for ${c.name} (${r.status}): ${r.stderr.toString()}`);
    const parsed = parseMergeTree(r.stdout, [ours, theirs]);
    const clean = r.status === 0;
    if (c.expect && (c.expect === 'clean') !== clean) {
      throw new Error(`corpus case ${c.name} expected ${c.expect} but git says ${clean ? 'clean' : 'conflict'}: ${JSON.stringify(parsed.messages)}`);
    }
    return { name: c.name, base, ours, theirs, expected: { clean, tree: parsed.tree, conflicts: clean ? [] : parsed.conflicts } };
  });
}

/** Every object in the corpus repository: oid -> {type, content}. */
export function loadObjects(dir) {
  const repo = join(dir, 'corpus.git');
  const out = gitOk(repo, ['cat-file', '--batch-all-objects', '--batch', '--unordered']);
  const objects = new Map();
  let off = 0;
  while (off < out.length) {
    const nl = out.indexOf(0x0a, off);
    const [oid, type, size] = out.subarray(off, nl).toString('latin1').split(' ');
    const start = nl + 1;
    const end = start + Number(size);
    objects.set(oid, { type, content: new Uint8Array(out.subarray(start, end)) });
    off = end + 1;
  }
  return objects;
}
