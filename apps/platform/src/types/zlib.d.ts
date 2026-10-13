// Minimal declaration for the nodejs_compat zlib the snapshot pipeline uses;
// the platform tsconfig deliberately excludes @types/node.
declare module 'node:zlib' {
  export const constants: { ZSTD_c_compressionLevel: number; ZSTD_c_checksumFlag: number };
  /**
   * A zlib transform in workerd: output arrives through 'data' listeners and
   * the write/end callbacks fire once the input is processed. read() yields
   * nothing — the stream is effectively flowing once listened to.
   */
  export interface ZstdTransform {
    write(chunk: Uint8Array, callback?: (err?: Error | null) => void): boolean;
    end(callback?: (err?: Error | null) => void): void;
    on(event: 'data', listener: (chunk: Uint8Array) => void): void;
    on(event: 'error' | 'end', listener: (err?: Error) => void): void;
    once(event: 'drain' | 'error' | 'end', listener: (err?: Error) => void): void;
  }
  export function createZstdCompress(options?: { params?: Record<number, number> }): ZstdTransform;
  export function createZstdDecompress(): ZstdTransform;
  export function zstdDecompressSync(buf: Uint8Array): Uint8Array;
}
