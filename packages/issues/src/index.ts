/**
 * Issue references in change text and branch names, and issue fingerprints.
 *
 * Everything here is pure and bounded: the platform calls it on change
 * titles, bodies and head branches (services/issues.ts) and stores the
 * result as issue links, which the merge record then honors.
 */

export const ISSUE_REF_LIMITS = {
  /** Characters of one text that are scanned; the rest is ignored. */
  inputMax: 65_536,
  /** References kept from one text. */
  refsMax: 50,
  fingerprintMax: 200,
} as const;

export type IssueRefKind = 'closes' | 'refs';

export interface IssueRef {
  number: number;
  /** `owner/name` when the reference was qualified, null for the repository itself. */
  repo: string | null;
  kind: IssueRefKind;
}

// A reference must not be glued to a word, path, URL fragment or another hash: `a#3`, `page#2` and `x/y/z#1` are not references.
const REF = String.raw`(?<![\w/#.\-])(?:([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}))?#([1-9][0-9]{0,8})(?!\w)`;
const KEYWORD = /(?:(not|never|partially|partly|n't)\s+)?(?<!\w)(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?!\w)\s*:?\s*/gi;
const LIST_ITEM = new RegExp(String.raw`(?:\s*(?:,|\band\b|&)\s*)?${REF}`, 'y');
const ANY_REF = new RegExp(REF, 'g');
const FENCE = /^\s*(```|~~~)/;
const INLINE_CODE = /`[^`\n]*`/g;

function withoutCode(text: string): string {
  let fence: string | null = null;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = FENCE.exec(line);
    if (fence !== null) {
      if (m && m[1] === fence) fence = null;
      out.push('');
      continue;
    }
    if (m) {
      fence = m[1]!;
      out.push('');
      continue;
    }
    out.push(line.replace(INLINE_CODE, ' '));
  }
  return out.join('\n');
}

const keyOf = (r: Pick<IssueRef, 'number' | 'repo'>) => `${r.repo ?? ''}#${r.number}`;

/** Folds references into one entry per issue in first-seen order; `closes` wins over `refs`. */
export function mergeIssueRefs(lists: readonly (readonly IssueRef[])[]): IssueRef[] {
  const seen = new Map<string, IssueRef>();
  for (const list of lists) {
    for (const r of list) {
      const prev = seen.get(keyOf(r));
      if (!prev) {
        if (seen.size < ISSUE_REF_LIMITS.refsMax) seen.set(keyOf(r), { ...r });
      } else if (r.kind === 'closes') prev.kind = 'closes';
    }
  }
  return [...seen.values()];
}

/**
 * The issues a text refers to. `fixes #12`, `Closes: #4`, `resolves acme/web#9`
 * and lists after one keyword (`fixes #1, #2 and #3`) close; a negated or
 * partial fix (`does not fix #5`, `partially fixes #6`) and every other `#N`
 * only refer. Code spans and fenced blocks are skipped.
 */
export function issueRefsIn(text: string): IssueRef[] {
  if (!text) return [];
  const src = withoutCode(text.slice(0, ISSUE_REF_LIMITS.inputMax));
  const closing = new Map<number, IssueRefKind>();
  for (const k of src.matchAll(KEYWORD)) {
    const kind: IssueRefKind = k[1] ? 'refs' : 'closes';
    LIST_ITEM.lastIndex = k.index + k[0].length;
    let item: RegExpExecArray | null;
    while ((item = LIST_ITEM.exec(src)) !== null) {
      // Keyed by where the reference itself starts, which is where ANY_REF finds it below.
      const refLength = (item[1] ? item[1].length + item[2]!.length + 1 : 0) + 1 + item[3]!.length;
      closing.set(item.index + item[0].length - refLength, kind);
    }
  }
  const found: IssueRef[] = [];
  for (const m of src.matchAll(ANY_REF)) {
    const repo = m[1] && m[2] ? `${m[1]}/${m[2]}` : null;
    found.push({ number: Number(m[3]), repo, kind: closing.get(m.index) ?? 'refs' });
  }
  return mergeIssueRefs([found]);
}

const BRANCH_SEGMENT = /^(?:(?:issues?|gh|bug|fix)[-_]?)?#?([1-9][0-9]{0,8})(?:[-_].*)?$/i;

/**
 * The issue number a conventional branch name carries (`fix/123-login`,
 * `issue-45`, `gh-47-flaky`), or null. Only a segment that starts with the
 * number (optionally after `issue`, `gh`, `bug`, `fix` or `#`) counts, so
 * version strings and numbers inside words never match. For an agent
 * workspace ref only the slug is considered, never the workspace id.
 */
export function branchIssueNumber(branch: string): number | null {
  const name = branch.replace(/^refs\/heads\//, '');
  const segments = name.split('/');
  const candidates = segments[0] === 'agents' ? segments.slice(-1) : segments;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const m = BRANCH_SEGMENT.exec(candidates[i]!);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * A fingerprint as stored: trimmed, with ASCII letters lower-cased; null when
 * empty or too long. Only ASCII is folded so SQL can build the same value with
 * `lower()` (SQLite folds ASCII only) inside the batch that raises a signal.
 */
export function normalizeFingerprint(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  return s.length > 0 && s.length <= ISSUE_REF_LIMITS.fingerprintMax ? s : null;
}

/**
 * The one fingerprint of a check by name. A failing default-branch run, a
 * flake (pass on retry) and a quarantine of the same check all land on the
 * same open issue. SQL builds it as `'check:' || lower(name)` from a stored
 * (already trimmed) check name.
 */
export function checkFingerprint(name: string): string {
  return normalizeFingerprint(`check:${name.trim()}`) ?? 'check:';
}
