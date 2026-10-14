// @ts-check

/**
 * Frame boundaries in a zstd object (RFC 8878 frame format): magic + frame
 * header + blocks + optional content checksum; skippable frames pass through.
 * Node's zlib stops decoding after the first frame of a concatenated object,
 * so callers feed each frame to a fresh decompressor. `eat` reports how much
 * of a chunk the current frame used and whether it ended the frame.
 */
export class ZstdFramer {
  /**
   * @param {string} [label] what the byte stream is called in error messages
   */
  constructor(label = 'input') {
    this.label = label;
    /** @type {'magic' | 'skiplen' | 'skip' | 'fhd' | 'extra' | 'blockhead' | 'blockdata' | 'checksum'} */
    this.stage = 'magic';
    /** @type {number[]} */
    this.bytes = [];
    this.left = 0;
    this.lastBlock = false;
    this.checksum = false;
  }

  /** True while a frame is partially consumed. */
  get inFrame() {
    return this.stage !== 'magic';
  }

  /**
   * @param {Uint8Array} c
   * @returns {{ consumed: number, ended: boolean }}
   */
  eat(c) {
    let i = 0;
    while (i < c.length) {
      switch (this.stage) {
        case 'magic': {
          while (i < c.length && this.bytes.length < 4) this.bytes.push(/** @type {number} */ (c[i++]));
          if (this.bytes.length < 4) return { consumed: i, ended: false };
          const [a, b, d, e] = /** @type {[number, number, number, number]} */ (this.bytes);
          this.bytes = [];
          if (a === 0x28 && b === 0xb5 && d === 0x2f && e === 0xfd) this.stage = 'fhd';
          else if ((a & 0xf0) === 0x50 && b === 0x2a && d === 0x4d && e === 0x18) this.stage = 'skiplen';
          else throw new Error(`${this.label} is not a zstd object`);
          break;
        }
        case 'skiplen': {
          while (i < c.length && this.bytes.length < 4) this.bytes.push(/** @type {number} */ (c[i++]));
          if (this.bytes.length < 4) return { consumed: i, ended: false };
          const [a, b, d, e] = /** @type {[number, number, number, number]} */ (this.bytes);
          this.bytes = [];
          this.left = (a | (b << 8) | (d << 16) | (e << 24)) >>> 0;
          this.stage = 'skip';
          break;
        }
        case 'skip': {
          const k = Math.min(this.left, c.length - i);
          i += k;
          this.left -= k;
          if (this.left === 0) {
            this.stage = 'magic';
            return { consumed: i, ended: true };
          }
          break;
        }
        case 'fhd': {
          const fhd = /** @type {number} */ (c[i++]);
          const single = (fhd >> 5) & 1;
          const fcs = fhd >> 6;
          this.checksum = ((fhd >> 2) & 1) === 1;
          const fcsLen = fcs === 0 ? (single ? 1 : 0) : fcs === 1 ? 2 : fcs === 2 ? 4 : 8;
          this.left = (single ? 0 : 1) + /** @type {number} */ ([0, 1, 2, 4][fhd & 3]) + fcsLen;
          this.stage = this.left > 0 ? 'extra' : 'blockhead';
          break;
        }
        case 'extra': {
          const k = Math.min(this.left, c.length - i);
          i += k;
          this.left -= k;
          if (this.left === 0) this.stage = 'blockhead';
          break;
        }
        case 'blockhead': {
          while (i < c.length && this.bytes.length < 3) this.bytes.push(/** @type {number} */ (c[i++]));
          if (this.bytes.length < 3) return { consumed: i, ended: false };
          const bh = /** @type {number} */ (this.bytes[0]) | (/** @type {number} */ (this.bytes[1]) << 8) | (/** @type {number} */ (this.bytes[2]) << 16);
          this.bytes = [];
          const type = (bh >> 1) & 3;
          if (type === 3) throw new Error('reserved zstd block type');
          this.lastBlock = (bh & 1) === 1;
          this.left = type === 1 ? 1 : bh >> 3;
          this.stage = 'blockdata';
          break;
        }
        case 'blockdata': {
          const k = Math.min(this.left, c.length - i);
          i += k;
          this.left -= k;
          if (this.left > 0) break;
          if (!this.lastBlock) {
            this.stage = 'blockhead';
            break;
          }
          if (!this.checksum) {
            this.stage = 'magic';
            return { consumed: i, ended: true };
          }
          this.left = 4;
          this.stage = 'checksum';
          break;
        }
        case 'checksum': {
          const k = Math.min(this.left, c.length - i);
          i += k;
          this.left -= k;
          if (this.left === 0) {
            this.stage = 'magic';
            return { consumed: i, ended: true };
          }
          break;
        }
      }
    }
    return { consumed: i, ended: false };
  }
}

/**
 * Whether the first bytes of a complete frame name a skippable frame (magic
 * 0x184D2A50..0x184D2A5F) — the same acceptance ZstdFramer applies.
 * @param {Uint8Array} head
 * @returns {boolean}
 */
export function isSkippableZstdFrame(head) {
  return (
    head.length >= 4 &&
    (/** @type {number} */ (head[0]) & 0xf0) === 0x50 &&
    head[1] === 0x2a &&
    head[2] === 0x4d &&
    head[3] === 0x18
  );
}
