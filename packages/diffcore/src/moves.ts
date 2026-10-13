import type { Hunk } from './index';

export interface MoveLocation {
  path: string;
  start: number;
  end: number;
}

export interface DetectedMove {
  from: MoveLocation;
  to: MoveLocation;
  lines: number;
}

interface Run {
  location: MoveLocation;
  lines: string[];
  hash: string;
}

function hashLines(lines: readonly string[]): string {
  const content = lines.join('\n');
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${hash >>> 0}:${content}`;
}

function compareLocation(a: MoveLocation, b: MoveLocation): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.start - b.start || a.end - b.end;
}

function runsFor(
  path: string,
  hunk: Hunk,
  minLines: number,
  remaining: number,
): { deletions: Run[]; insertions: Run[] } {
  const deletions: Run[] = [];
  const insertions: Run[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  let kind: 'del' | 'ins' | null = null;
  let current: Array<{ number: number; text: string }> = [];

  const flush = () => {
    if (!kind || current.length < minLines) {
      current = [];
      kind = null;
      return;
    }
    const normalized = current.map(({ text }) => text.replace(/\s+/g, ' ').trim());
    if (!normalized.some((line) => line !== '' && !/^[{}]+$/.test(line))) {
      current = [];
      kind = null;
      return;
    }
    const run: Run = {
      location: { path, start: current[0]!.number, end: current.at(-1)!.number },
      lines: normalized,
      hash: hashLines(normalized),
    };
    (kind === 'del' ? deletions : insertions).push(run);
    current = [];
    kind = null;
  };

  for (const line of hunk.lines) {
    if (line.type === 'eq') {
      flush();
      oldLine = (line.oldNo ?? oldLine) + 1;
      newLine = (line.newNo ?? newLine) + 1;
      continue;
    }
    const number = line.type === 'del' ? (line.oldNo ?? oldLine) : (line.newNo ?? newLine);
    if (kind !== line.type) flush();
    kind = line.type;
    current.push({ number, text: line.text });
    if (line.type === 'del') oldLine = number + 1;
    else newLine = number + 1;
  }
  flush();
  return {
    deletions: deletions.slice(0, remaining),
    insertions: insertions.slice(0, remaining),
  };
}

export function detectMoves(
  files: Array<{ path: string; hunks: Hunk[] }>,
  opts: { minLines?: number; maxBlocks?: number } = {},
): DetectedMove[] {
  const minLines = Math.max(1, Math.floor(opts.minLines ?? 3));
  const maxBlocks = Math.max(0, Math.floor(opts.maxBlocks ?? 2000));
  const deletions: Run[] = [];
  const insertions: Run[] = [];
  const orderedFiles = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of orderedFiles) {
    for (const hunk of file.hunks) {
      if (deletions.length >= maxBlocks && insertions.length >= maxBlocks) break;
      const runs = runsFor(file.path, hunk, minLines, maxBlocks);
      deletions.push(...runs.deletions.slice(0, Math.max(0, maxBlocks - deletions.length)));
      insertions.push(...runs.insertions.slice(0, Math.max(0, maxBlocks - insertions.length)));
    }
  }
  deletions.sort((a, b) => compareLocation(a.location, b.location));
  insertions.sort((a, b) => compareLocation(a.location, b.location));
  const insertionsByHash = new Map<string, Run[]>();
  for (const run of insertions) {
    const group = insertionsByHash.get(run.hash) ?? [];
    group.push(run);
    insertionsByHash.set(run.hash, group);
  }
  const used = new Set<Run>();
  const moves: DetectedMove[] = [];
  for (const from of deletions) {
    const match = insertionsByHash.get(from.hash)?.find((to) =>
      !used.has(to) &&
      (from.location.path !== to.location.path ||
        from.location.start !== to.location.start ||
        from.location.end !== to.location.end));
    if (!match) continue;
    used.add(match);
    moves.push({ from: from.location, to: match.location, lines: from.lines.length });
  }
  return moves.sort((a, b) => compareLocation(a.from, b.from) || compareLocation(a.to, b.to));
}
