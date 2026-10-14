/**
 * The pagination-cursor wire format. A `nextCursor` is handed back verbatim
 * through the `?cursor=` query parameter, so the encoding must stay
 * URL-safe: raw base64 can emit `+`, which an under-encoding client decodes
 * as a space. Payload shape and validation stay with each resource; only
 * the codec is shared.
 */

/** Encodes a cursor payload string as unpadded base64url. */
export function encodeCursorPayload(payload: string): string {
  return btoa(payload).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Decodes an encodeCursorPayload cursor, or null on malformed input.
 * Cursors written by the old raw-base64 codec decode too: they carry no
 * `-`/`_` to restore.
 */
export function decodeCursorPayload(raw: string): string | null {
  try {
    return atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
}
