/**
 * Markdown rendering for READMEs and comments.
 *
 * Security posture: markdown-it with `html: false` (raw HTML is escaped,
 * never passed through) and the default `validateLink`, which blocks
 * javascript:/vbscript:/data: URLs. Rendered HTML is cached content-addressed
 * by blob SHA in the Cache API, so a README renders once ever per content.
 */

import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});

/** Render markdown to HTML. Trusted only to the extent markdown-it is. */
export function renderMarkdown(text: string): string {
  return md.render(text);
}

export function plainExcerpt(text: string, max = 140): string {
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}
