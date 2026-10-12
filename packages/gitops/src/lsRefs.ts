/**
 * Protocol v2 `ls-refs`: resolve a handful of ref names in one upload-pack
 * round trip, filtered server-side by `ref-prefix`, so repos with thousands
 * of workspace refs never ship a full advertisement.
 */

import { DELIM_PKT, FLUSH_PKT, concat, decode, pktLine, readPktLines } from './index';

export interface LsRef {
  oid: string;
  name: string;
  /** For annotated tags: the object the tag points at (requested with `peel`). */
  peeled?: string;
  symrefTarget?: string;
}

const OID_RE = /^[0-9a-f]{40}$/;

/** Body for `POST git-upload-pack` with `Git-Protocol: version=2`. */
export function lsRefsRequest(prefixes: string[]): Uint8Array {
  const unique = [...new Set(prefixes)];
  return concat(
    pktLine('command=ls-refs\n'),
    pktLine('agent=kvarm\n'),
    DELIM_PKT,
    pktLine('peel\n'),
    pktLine('symrefs\n'),
    ...unique.map((p) => pktLine(`ref-prefix ${p}\n`)),
    FLUSH_PKT,
  );
}

/** Parses an ls-refs response; throws when it is not one. */
export function parseLsRefs(body: Uint8Array): LsRef[] {
  const pkts = readPktLines(body);
  if (pkts.length === 0 || !pkts[pkts.length - 1]!.flush) throw new Error('ls-refs: missing flush');
  const out: LsRef[] = [];
  for (const pkt of pkts) {
    if (pkt.flush) break;
    if (pkt.delim || pkt.responseEnd) throw new Error('ls-refs: unexpected special packet');
    const line = decode(pkt.data).replace(/\n$/, '');
    const [oid, name, ...attrs] = line.split(' ');
    if (!oid || !OID_RE.test(oid) || !name) throw new Error('ls-refs: malformed line');
    const ref: LsRef = { oid, name };
    for (const attr of attrs) {
      if (attr.startsWith('peeled:')) ref.peeled = attr.slice('peeled:'.length);
      else if (attr.startsWith('symref-target:')) ref.symrefTarget = attr.slice('symref-target:'.length);
    }
    out.push(ref);
  }
  return out;
}

/**
 * Full ref names a short name may mean, in git's precedence order (a subset
 * of `git rev-parse` dwim rules: tags win over branches).
 */
export function refCandidates(name: string): string[] {
  if (name === 'HEAD' || name.startsWith('refs/')) return [name];
  return [`refs/tags/${name}`, `refs/heads/${name}`];
}

/** The commit-ish a name resolves to among listed refs (peeled), or null. */
export function pickRef(refs: LsRef[], name: string): string | null {
  for (const candidate of refCandidates(name)) {
    const ref = refs.find((r) => r.name === candidate);
    if (ref) return ref.peeled ?? ref.oid;
  }
  return null;
}
