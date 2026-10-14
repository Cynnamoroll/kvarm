/**
 * The body's bytes, or null once more than `max` bytes have arrived. A
 * declared Content-Length past the cap fails before any read; otherwise
 * incoming bytes are counted as they stream in, so a body without
 * Content-Length (or with a false one) is never buffered past the cap and
 * the rest is cancelled unread.
 */
export async function readBodyCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
