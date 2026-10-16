import { DurableObject } from 'cloudflare:workers';
import { decode, readPktLines } from '@kvarm/gitops';
import { getGitToken } from '../artifacts/tokens';

const ZERO = '0'.repeat(40);
const FRESH_MS = 15 * 60_000;
const OID = /^[0-9a-f]{40}$/;
const HEX = '0123456789abcdef';
const OID_HEX = Array.from({ length: 256 }, (_, value) => HEX[value >>> 4]! + HEX[value & 15]!);
const NON_ASCII = /\P{ASCII}/u;
const TEXT_ENCODER = new TextEncoder();

export interface MirrorUpdate { ref: string; oldOid: string; newOid: string }
export interface LsRefsOptions { peel?: boolean; symrefs?: boolean; unborn?: boolean; prefixes: string[] }
export interface MirrorReadRequest {
  kind: 'v0' | 'v2' | 'ls-refs';
  options?: LsRefsOptions;
}
export interface MirrorReadResult { seq: number; bytes: Uint8Array }

interface Meta {
  repo_id: string; seq: number; seeded_at: number | null; verified_at: number | null;
  dirty: number; destroyed: number; caps_v0: string; v0_service: number;
  adv_v2: Uint8Array | ArrayBuffer | null; head_symref: string | null;
}
interface RefRow { name: string; oid: Uint8Array | ArrayBuffer; peeled: Uint8Array | ArrayBuffer | null }
export interface MirrorRenderRef { name: string; oid: string; peeled: string | null }
export interface MirrorRenderMeta { caps_v0: string; v0_service?: number; head_symref: string | null }

function oidBytes(oid: string): Uint8Array { return Uint8Array.from(oid.match(/../g)!.map((x) => parseInt(x, 16))); }
function oidHex(value: Uint8Array | ArrayBuffer): string {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  let result = '';
  for (const byte of bytes) result += OID_HEX[byte]!;
  return result;
}
function same(a: Uint8Array | ArrayBuffer, b: string): boolean { return oidHex(a) === b; }
function compareRefNames(a: string, b: string): number {
  if (!NON_ASCII.test(a) && !NON_ASCII.test(b)) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    const ac = a.codePointAt(i)!;
    const bc = b.codePointAt(j)!;
    if (ac !== bc) return ac - bc;
    i += ac > 0xffff ? 2 : 1;
    j += bc > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}
function utf8ByteLength(value: string): number {
  let length = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) length++;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { length += 4; i++; }
      else length += 3;
    } else length += 3;
  }
  return length;
}
function encodePacketBodies(bodies: readonly string[]): Uint8Array {
  const packets: string[] = [];
  packets.length = bodies.length;
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i]!;
    if (!body) packets[i] = '0000';
    else {
      const bodyLength = NON_ASCII.test(body) ? utf8ByteLength(body) : body.length;
      const packetLength = bodyLength + 4;
      packets[i] = `${HEX[(packetLength >>> 12) & 15]}${HEX[(packetLength >>> 8) & 15]}${HEX[(packetLength >>> 4) & 15]}${HEX[packetLength & 15]}${body}`;
    }
  }
  return TEXT_ENCODER.encode(packets.join(''));
}

function parseV0(body: Uint8Array): { caps: string; headSymref: string | null; refs: RefRow[]; serviceBanner: boolean } | null {
  try {
    const packets = readPktLines(body);
    if (packets.length === 1 && packets[0]!.flush) {
      return { caps: '', headSymref: null, refs: [], serviceBanner: false };
    }
    const serviceBanner = decode(packets[0]!.data) === '# service=git-upload-pack\n';
    const start = serviceBanner ? 2 : 0;
    if ((serviceBanner && !packets[1]!.flush) || packets.length <= start ||
        packets.findIndex((p, i) => i >= start && p.flush) !== packets.length - 1) return null;
    const refs = new Map<string, RefRow>();
    let caps = '';
    let sawCapabilities = false;
    let sawEnd = false;
    let capabilitiesOnly = false;
    for (const packet of packets.slice(start)) {
      if (packet.flush) { sawEnd = true; break; }
      if (packet.delim || packet.responseEnd) return null;
      if (capabilitiesOnly) return null;
      const line = decode(packet.data).replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const left = nul < 0 ? line : line.slice(0, nul);
      if (nul >= 0) {
        if (sawCapabilities || refs.size > 0) return null;
        sawCapabilities = true;
        caps = line.slice(nul + 1);
      }
      const split = left.indexOf(' ');
      if (split < 1) return null;
      const hash = left.slice(0, split);
      const name = left.slice(split + 1);
      if (!OID.test(hash) || (!name.startsWith('refs/') && name !== 'HEAD' && name !== 'capabilities^{}')) return null;
      if (name === 'capabilities^{}') {
        if (hash !== ZERO || refs.size !== 0 || !caps) return null;
        capabilitiesOnly = true;
        continue;
      }
      if (name.endsWith('^{}')) {
        const target = name.slice(0, -3);
        const row = refs.get(target);
        if (!row || !target.startsWith('refs/tags/')) return null;
        row.peeled = oidBytes(hash);
      } else {
        if (refs.has(name)) return null;
        refs.set(name, { name, oid: oidBytes(hash), peeled: null });
      }
    }
    if (!sawEnd || !caps) return null;
    const symPrefix = 'symref=HEAD:';
    const sym = caps.split(' ').find((x) => x.startsWith(symPrefix))?.slice(symPrefix.length) ?? null;
    return { caps, headSymref: sym, refs: [...refs.values()], serviceBanner };
  } catch { return null; }
}

function validV2(body: Uint8Array): boolean {
  try {
    const p = readPktLines(body);
    if (p.length < 2 || !p[p.length - 1]!.flush) return false;
    const hasVersion = p.some((x) => !x.flush && decode(x.data).trim() === 'version 2');
    const hasServiceBanner = decode(p[0]!.data) === '# service=git-upload-pack\n' && p[1]!.flush;
    return hasVersion && (hasServiceBanner || decode(p[0]!.data).trim() === 'version 2');
  } catch { return false; }
}

export function renderV0(meta: MirrorRenderMeta, refs: MirrorRenderRef[]): Uint8Array {
  const serviceBanner = meta.v0_service !== 0;
  if (refs.length === 0 && !meta.caps_v0 && !serviceBanner) return encodePacketBodies(['']);
  const lines = serviceBanner ? ['# service=git-upload-pack\n', ''] : [];
  const head = refs.find((r) => r.name === 'HEAD');
  if (head) lines.push(`${head.oid} HEAD${meta.caps_v0 ? `\0${meta.caps_v0}` : ''}\n`);
  else if (refs.length === 0) lines.push(`${ZERO} capabilities^{}${meta.caps_v0 ? `\0${meta.caps_v0}` : ''}\n`);
  let first = head === undefined;
  for (const ref of refs) {
    if (ref.name === 'HEAD') continue;
    lines.push(`${ref.oid} ${ref.name}${first && meta.caps_v0 ? `\0${meta.caps_v0}` : ''}\n`);
    first = false;
    if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
  }
  lines.push('');
  return encodePacketBodies(lines);
}

export function renderLsRefs(meta: MirrorRenderMeta, refs: MirrorRenderRef[], options: LsRefsOptions): Uint8Array {
  const lines: string[] = [];
  let hasHead = false;
  const append = (ref: MirrorRenderRef) => {
    if (ref.name === 'HEAD') hasHead = true;
    let line = `${ref.oid} ${ref.name}`;
    if (options.symrefs && ref.name === 'HEAD' && meta.head_symref) line += ` symref-target:${meta.head_symref}`;
    if (options.peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    line += '\n';
    lines.push(line);
  };
  if (options.prefixes.length === 0) {
    for (const ref of refs) append(ref);
  } else {
    const ranges: Array<[number, number]> = [];
    for (const prefix of options.prefixes) {
      let low = 0;
      let high = refs.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (compareRefNames(refs[mid]!.name, prefix) < 0) low = mid + 1;
        else high = mid;
      }
      const start = low;
      high = refs.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (refs[mid]!.name.startsWith(prefix)) low = mid + 1;
        else high = mid;
      }
      if (low > start) ranges.push([start, low]);
    }
    ranges.sort(([a], [b]) => a - b);
    let copiedThrough = -1;
    for (const [start, end] of ranges) {
      for (let i = Math.max(start, copiedThrough + 1); i < end; i++) append(refs[i]!);
      copiedThrough = Math.max(copiedThrough, end - 1);
    }
  }
  const unbornMatchesPrefix = options.prefixes.length === 0 || options.prefixes.some((p) => 'HEAD'.startsWith(p));
  if (options.unborn && !hasHead && meta.head_symref && unbornMatchesPrefix) {
    lines.unshift(`unborn HEAD symref-target:${meta.head_symref}\n`);
  }
  lines.push('');
  return encodePacketBodies(lines);
}

export function parseLsRefsRequest(body: Uint8Array): LsRefsOptions | null {
  try {
    const packets = readPktLines(body);
    if (!packets[0] || decode(packets[0].data) !== 'command=ls-refs\n') return null;
    const delimiter = packets.findIndex((p) => p.delim);
    if (delimiter < 0 || packets.findIndex((p, i) => i > delimiter && p.flush) !== packets.length - 1) return null;
    for (const p of packets.slice(1, delimiter)) {
      const value = decode(p.data);
      if (!value.endsWith('\n')) return null;
      const line = value.slice(0, -1);
      if (!(line.startsWith('agent=') || line === 'object-format=sha1')) return null;
    }
    const out: LsRefsOptions = { prefixes: [] };
    for (const p of packets.slice(delimiter + 1)) {
      if (p.flush) break;
      const value = decode(p.data);
      if (!value.endsWith('\n')) return null;
      const line = value.slice(0, -1);
      if (line === 'peel') out.peel = true;
      else if (line === 'symrefs') out.symrefs = true;
      else if (line === 'unborn') out.unborn = true;
      else if (line.startsWith('ref-prefix ')) {
        const prefix = line.slice(11);
        if (/\s/.test(prefix)) return null;
        out.prefixes.push(prefix);
      }
      else return null;
    }
    return out;
  } catch { return null; }
}

export class RepoMirror extends DurableObject<Env> {
  private ready: Promise<void>;
  private seedFlight: Promise<void> | null = null;
  private destroyed = false;
  private seedVersion = 0;
  private renderCache: { seq: number; meta: Meta; refs: MirrorRenderRef[]; v0: Uint8Array } | null = null;
  private lsRefsCache = new Map<string, Uint8Array>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (
        repo_id TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0, seeded_at INTEGER,
        verified_at INTEGER, dirty INTEGER NOT NULL DEFAULT 1, destroyed INTEGER NOT NULL DEFAULT 0,
        caps_v0 TEXT NOT NULL DEFAULT '', v0_service INTEGER NOT NULL DEFAULT 1,
        adv_v2 BLOB, head_symref TEXT)`);
      const metaColumns = ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(meta)').toArray();
      if (!metaColumns.some((column) => column.name === 'v0_service')) {
        ctx.storage.sql.exec('ALTER TABLE meta ADD COLUMN v0_service INTEGER NOT NULL DEFAULT 1');
      }
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, oid BLOB NOT NULL, peeled BLOB) WITHOUT ROWID');
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS ring (name TEXT NOT NULL, oid BLOB NOT NULL, seq INTEGER NOT NULL)');
      ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS ring_name_seq ON ring(name, seq DESC)');
      const row = ctx.storage.sql.exec<{ destroyed: number }>('SELECT destroyed FROM meta LIMIT 1').toArray()[0];
      this.destroyed = row?.destroyed === 1;
    });
  }
  private rows<T>(sql: string, ...values: unknown[]): T[] { return this.ctx.storage.sql.exec(sql, ...values).toArray() as unknown as T[]; }
  private meta(): Meta | null { return this.rows<Meta>('SELECT * FROM meta LIMIT 1')[0] ?? null; }
  private prepared(meta: Meta): { seq: number; meta: Meta; refs: MirrorRenderRef[]; v0: Uint8Array } {
    if (this.renderCache?.seq === meta.seq) return this.renderCache;
    const refs = this.rowsForRender();
    this.renderCache = { seq: meta.seq, meta, refs, v0: renderV0(meta, refs) };
    this.lsRefsCache.clear();
    return this.renderCache;
  }
  private dirty(repoId: string): void {
    const m = this.meta();
    if (m?.destroyed) return;
    if (m && !m.repo_id && repoId) this.ctx.storage.sql.exec('UPDATE meta SET repo_id=? WHERE repo_id=?', repoId, '');
    const id = m?.repo_id || repoId || '';
    this.ctx.storage.sql.exec(
      `INSERT INTO meta(repo_id,seq,dirty,destroyed,caps_v0) VALUES(?,0,1,0,'')
       ON CONFLICT(repo_id) DO UPDATE SET dirty=1`, id,
    );
  }
  private rowsForRender(): MirrorRenderRef[] {
    return this.rows<MirrorRenderRef>(
      `SELECT name,lower(hex(oid)) AS oid,
              CASE WHEN peeled IS NULL THEN NULL ELSE lower(hex(peeled)) END AS peeled
         FROM refs ORDER BY name COLLATE BINARY`,
    );
  }

  async markDirty(repoId?: string): Promise<void> {
    await this.ready;
    if (!this.destroyed) {
      this.seedVersion++;
      this.dirty(this.meta()?.repo_id || repoId || '');
    }
  }

  async apply(seq: number, updates: MirrorUpdate[], repoId?: string): Promise<void> {
    await this.ready;
    if (this.destroyed) return;
    const m = this.meta();
    if (!m) { this.seedVersion++; this.dirty(repoId ?? ''); return; }
    if (!m.repo_id && repoId) this.ctx.storage.sql.exec('UPDATE meta SET repo_id=? WHERE repo_id=?', repoId, '');
    if (seq <= m.seq) {
      const inconsistent = updates.some((u) => {
        const current = this.rows<RefRow>('SELECT name,oid,peeled FROM refs WHERE name=?', u.ref)[0];
        return u.newOid === ZERO ? current !== undefined : !current || !same(current.oid, u.newOid);
      });
      if (inconsistent) {
        this.seedVersion++;
        this.dirty(m.repo_id || repoId || '');
      }
      return;
    }
    this.seedVersion++;
    if (!m.seeded_at || seq !== m.seq + 1 || updates.some((u) => u.ref.startsWith('refs/tags/'))) { this.dirty(m.repo_id); return; }
    try {
      this.ctx.storage.transactionSync(() => {
        for (const u of updates) {
          const current = this.rows<RefRow>('SELECT name,oid,peeled FROM refs WHERE name=?', u.ref)[0];
          const casMismatch = u.oldOid === ZERO ? current !== undefined : !current || !same(current.oid, u.oldOid);
          if (casMismatch) throw new Error('mirror CAS mismatch');
        }
        for (const u of updates) {
          if (u.newOid === ZERO) this.ctx.storage.sql.exec('DELETE FROM refs WHERE name=?', u.ref);
          else this.ctx.storage.sql.exec('INSERT INTO refs(name,oid,peeled) VALUES(?,?,NULL) ON CONFLICT(name) DO UPDATE SET oid=excluded.oid,peeled=NULL', u.ref, oidBytes(u.newOid));
          if (m.head_symref === u.ref) {
            if (u.newOid === ZERO) this.ctx.storage.sql.exec('DELETE FROM refs WHERE name=?', 'HEAD');
            else this.ctx.storage.sql.exec('INSERT INTO refs(name,oid,peeled) VALUES(?,?,NULL) ON CONFLICT(name) DO UPDATE SET oid=excluded.oid', 'HEAD', oidBytes(u.newOid));
          }
          if (u.newOid !== ZERO) {
            this.ctx.storage.sql.exec('INSERT INTO ring(name,oid,seq) VALUES(?,?,?)', u.ref, oidBytes(u.newOid), seq);
            this.ctx.storage.sql.exec('DELETE FROM ring WHERE name=? AND seq NOT IN (SELECT seq FROM ring WHERE name=? ORDER BY seq DESC LIMIT 16)', u.ref, u.ref);
          }
        }
        this.ctx.storage.sql.exec('UPDATE meta SET seq=?,dirty=0,verified_at=?', seq, Date.now());
      });
      this.renderCache = null;
      this.lsRefsCache.clear();
    } catch { this.dirty(m.repo_id); }
  }

  async reconcile(ref: string, after: string, repoId?: string): Promise<void> {
    await this.ready;
    if (this.destroyed) return;
    const row = this.rows<RefRow>('SELECT oid FROM refs WHERE name=?', ref)[0];
    if ((after === ZERO && !row) || (row && same(row.oid, after)) ||
      this.rows<{ ok: number }>('SELECT 1 AS ok FROM ring WHERE name=? AND oid=? LIMIT 1', ref, oidBytes(after)).length > 0) return;
    this.seedVersion++;
    this.dirty(this.meta()?.repo_id || repoId || '');
  }

  private async seed(rowSeq: number, artifactsName: string, remote: string, repoId?: string): Promise<void> {
    const start = this.meta()?.seq ?? 0;
    const version = this.seedVersion;
    const token = await getGitToken(this.env, artifactsName, 'read');
    const auth = { Authorization: `Basic ${btoa(`kvarm:${token}`)}` };
    const [v0, v2] = await Promise.all([
      fetch(`${remote}/info/refs?service=git-upload-pack`, { headers: auth }),
      fetch(`${remote}/info/refs?service=git-upload-pack`, { headers: { ...auth, 'Git-Protocol': 'version=2' } }),
    ]);
    const v0body = new Uint8Array(await v0.arrayBuffer());
    const v2body = new Uint8Array(await v2.arrayBuffer());
    const parsed = parseV0(v0body);
    if (!v0.ok || !v2.ok || !parsed || !validV2(v2body)) { this.dirty(this.meta()?.repo_id || repoId || ''); return; }
    if (this.destroyed) return;
    const current = this.meta();
    if (current?.destroyed) return;
    if ((current?.seq ?? 0) !== start || this.seedVersion !== version) {
      this.dirty(current?.repo_id || repoId || '');
      return;
    }
    this.ctx.storage.transactionSync(() => {
      if (current && !current.repo_id && repoId) this.ctx.storage.sql.exec('UPDATE meta SET repo_id=? WHERE repo_id=?', repoId, '');
      this.ctx.storage.sql.exec('DELETE FROM refs');
      this.ctx.storage.sql.exec('DELETE FROM ring');
      for (const r of parsed.refs) this.ctx.storage.sql.exec('INSERT INTO refs(name,oid,peeled) VALUES(?,?,?)', r.name, r.oid, r.peeled);
      this.ctx.storage.sql.exec(
        `INSERT INTO meta(repo_id,seq,seeded_at,verified_at,dirty,destroyed,caps_v0,v0_service,adv_v2,head_symref)
         VALUES(?,?,?,?,0,0,?,?,?,?) ON CONFLICT(repo_id) DO UPDATE SET seq=?,seeded_at=?,verified_at=?,dirty=0,destroyed=0,caps_v0=?,v0_service=?,adv_v2=?,head_symref=?`,
        current?.repo_id || repoId || '', Math.max(rowSeq, current?.seq ?? 0), Date.now(), Date.now(), parsed.caps, parsed.serviceBanner ? 1 : 0, v2body, parsed.headSymref,
        Math.max(rowSeq, current?.seq ?? 0), Date.now(), Date.now(), parsed.caps, parsed.serviceBanner ? 1 : 0, v2body, parsed.headSymref,
      );
    });
    this.renderCache = null;
    this.lsRefsCache.clear();
  }

  async read(rowSeq: number, artifactsName: string, remote: string, request: MirrorReadRequest = { kind: 'v0' }, repoId?: string): Promise<MirrorReadResult | null> {
    await this.ready;
    if (this.destroyed) return null;
    let m = this.meta();
    for (let attempt = 0; !m || m.dirty || !m.seeded_at || !m.verified_at || m.seq < rowSeq || Date.now() - m.verified_at >= FRESH_MS; attempt++) {
      if (attempt > 1) return null;
      if (!this.seedFlight) {
        this.seedFlight = this.seed(rowSeq, artifactsName, remote, repoId).finally(() => { this.seedFlight = null; });
      }
      try { await this.seedFlight; } catch { this.dirty(this.meta()?.repo_id || repoId || ''); return null; }
      m = this.meta();
      if (m && !m.dirty && m.seeded_at && m.verified_at && m.seq >= rowSeq && Date.now() - m.verified_at < FRESH_MS) break;
      if (!m || m.dirty || !m.seeded_at || !m.verified_at || m.seq >= rowSeq || Date.now() - m.verified_at >= FRESH_MS) return null;
    }
    if (!m || m.destroyed || m.dirty || !m.seeded_at || m.seq < rowSeq) return null;
    const prepared = this.prepared(m);
    let bytes: Uint8Array;
    if (request.kind === 'v0') bytes = prepared.v0;
    else if (request.kind === 'v2') bytes = new Uint8Array(m.adv_v2 instanceof ArrayBuffer ? m.adv_v2 : m.adv_v2 ?? new Uint8Array());
    else {
      const options = request.options ?? { prefixes: [] };
      const cacheKey = JSON.stringify(options);
      let rendered = this.lsRefsCache.get(cacheKey);
      if (!rendered) {
        rendered = renderLsRefs(m, prepared.refs, options);
        this.lsRefsCache.set(cacheKey, rendered);
      }
      bytes = rendered;
    }
    return { seq: m.seq, bytes };
  }

  async destroy(repoId?: string): Promise<void> {
    await this.ready;
    this.seedVersion++;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM refs');
      this.ctx.storage.sql.exec('DELETE FROM ring');
      const existing = this.meta();
      if (existing && !existing.repo_id && repoId) this.ctx.storage.sql.exec('UPDATE meta SET repo_id=? WHERE repo_id=?', repoId, '');
      const id = existing?.repo_id || repoId || '';
      this.ctx.storage.sql.exec(`INSERT INTO meta(repo_id,seq,seeded_at,verified_at,dirty,destroyed,caps_v0,adv_v2,head_symref)
        VALUES(?,0,NULL,NULL,1,1,'',NULL,NULL)
        ON CONFLICT(repo_id) DO UPDATE SET seq=0,seeded_at=NULL,verified_at=NULL,dirty=1,destroyed=1,caps_v0='',adv_v2=NULL,head_symref=NULL`, id);
    });
    this.renderCache = null;
    this.lsRefsCache.clear();
    this.destroyed = true;
  }
}
