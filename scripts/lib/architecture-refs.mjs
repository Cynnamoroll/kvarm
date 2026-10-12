/**
 * Numbered architecture citations ("architecture §11.4", "invariant 5") and
 * their resolution against numbered markdown headings.
 */

export const DEFAULT_TARGET = 'docs/architecture.md';

const HEADING = /^#{1,6}\s+(\d+(?:\.\d+)*)\.?\s/;
const FENCE = /^\s*(```|~~~)/;
// A `.md` path directly before a section sign names the cited document.
const CITATION = /(?:([\w./-]+\.md)\s+)?§(\d+(?:\.\d+)*)|\binvariant (\d+)\b/g;

/** Section numbers of every numbered heading outside code fences. */
export function collectSections(markdown) {
  const sections = new Set();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = HEADING.exec(line);
    if (m?.[1]) sections.add(m[1]);
  }
  return sections;
}

/** Citations in a text, one per section sign or numbered invariant; invariant N is §2.N. */
export function findCitations(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(CITATION)) {
      if (m[3] !== undefined) out.push({ line: i + 1, section: `2.${m[3]}`, target: DEFAULT_TARGET, text: m[0] });
      else out.push({ line: i + 1, section: m[2], target: m[1] ?? DEFAULT_TARGET, text: m[0] });
    }
  }
  return out;
}

/**
 * Checks every citation of `files` against `docs` (path -> markdown). A
 * citation of a document missing from `docs` is `missing-document`; one whose
 * section has no numbered heading there is `missing-section`.
 */
export function checkCitations(files, docs) {
  const sectionsOf = new Map();
  const resolved = [];
  const unresolved = [];
  for (const file of files) {
    for (const c of findCitations(file.text)) {
      const entry = { path: file.path, ...c };
      const doc = docs.get(c.target);
      if (doc === undefined) {
        unresolved.push({ ...entry, reason: 'missing-document' });
        continue;
      }
      if (!sectionsOf.has(c.target)) sectionsOf.set(c.target, collectSections(doc));
      if (sectionsOf.get(c.target).has(c.section)) resolved.push(entry);
      else unresolved.push({ ...entry, reason: 'missing-section' });
    }
  }
  return { resolved, unresolved };
}
