#!/usr/bin/env node
/**
 * Validation probe: attempt one receive-pack ref update through the git gate
 * with a chosen principal, parse report-status, and read the ref back with
 * the owner. HTTP 200 alone is never treated as success.
 *
 * Usage (tokens come from env vars by NAME; they are never printed):
 *   node scripts/receive-pack-probe.mjs --repo cynthia/<name> --ref refs/heads/authz-probe \
 *     --workdir /path/to/local/clone --new <sha> --as KVARM_PAT_BOT --owner KVARM_PAT
 *
 * The local workdir must contain the <new> commit and the current remote <old>
 * commit so `git pack-objects` can build a thin pack of old..new.
 * Exit code: 0 when the observed outcome is printed (denied or accepted),
 * 2 on usage/transport errors.
 */

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({
  options: {
    repo: { type: 'string' },
    ref: { type: 'string' },
    workdir: { type: 'string' },
    new: { type: 'string' },
    as: { type: 'string' },
    owner: { type: 'string', default: 'KVARM_PAT' },
  },
});

function fail(msg) {
  console.error(`receive-pack-probe: ${msg}`);
  process.exit(2);
}

const base = process.env.KVARM_BASE_URL ?? fail('KVARM_BASE_URL is not set');
for (const k of ['repo', 'ref', 'workdir', 'new', 'as']) if (!a[k]) fail(`--${k} is required`);
const actorToken = process.env[a.as] ?? fail(`env ${a.as} is not set`);
const ownerToken = process.env[a.owner] ?? fail(`env ${a.owner} is not set`);
const gitUrl = `${base}/${a.repo}.git`;
const auth = (t) => `Basic ${Buffer.from(`x:${t}`).toString('base64')}`;

function pkt(line) {
  return Buffer.concat([Buffer.from((line.length + 4).toString(16).padStart(4, '0')), Buffer.from(line)]);
}

/** Splits a pkt-line stream; side-band channel 1 payloads are unwrapped. */
function pktLines(buf) {
  const out = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString(), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      i += 4;
      continue;
    }
    out.push(buf.subarray(i + 4, i + len));
    i += len;
  }
  return out;
}

async function advertisedRefs(token, service) {
  const res = await fetch(`${gitUrl}/info/refs?service=${service}`, { headers: { Authorization: auth(token) } });
  const body = Buffer.from(await res.arrayBuffer());
  const refs = {};
  if (res.status === 200) {
    for (const line of pktLines(body)) {
      const s = line.toString().replace(/\0.*$/s, '').trim();
      const m = s.match(/^([0-9a-f]{40}) (\S+)$/);
      if (m) refs[m[2]] = m[1];
    }
  }
  return { status: res.status, refs };
}

// Owner readback uses the receive-pack advertisement: it requires write access
// and is never edge-cached, so it reflects the current ref.
const before = await advertisedRefs(ownerToken, 'git-receive-pack');
const oldSha = before.refs[a.ref] ?? fail(`owner readback has no ${a.ref} (status ${before.status})`);
console.log(`owner readback before: ${a.ref} ${oldSha}`);

const adv = await advertisedRefs(actorToken, 'git-receive-pack');
console.log(`actor receive-pack advertisement: HTTP ${adv.status}, refs disclosed: ${Object.keys(adv.refs).length}`);

const pack = spawnSync('git', ['-C', a.workdir, 'pack-objects', '--stdout', '--revs', '--thin', '-q'], {
  input: `${a.new}\n^${oldSha}\n`,
  maxBuffer: 64 * 1024 * 1024,
});
if (pack.status !== 0) fail(`git pack-objects failed: ${pack.stderr.toString()}`);

const body = Buffer.concat([
  pkt(`${oldSha} ${a.new} ${a.ref}\0 report-status agent=receive-pack-probe\n`),
  Buffer.from('0000'),
  pack.stdout,
]);
const res = await fetch(`${gitUrl}/git-receive-pack`, {
  method: 'POST',
  headers: {
    Authorization: auth(actorToken),
    'content-type': 'application/x-git-receive-pack-request',
    accept: 'application/x-git-receive-pack-result',
  },
  body,
});
const resBody = Buffer.from(await res.arrayBuffer());
const status = res.status === 200 ? pktLines(resBody).map((l) => l.toString().trim()) : [];
const refStatus = status.find((l) => l.endsWith(a.ref) || l.includes(` ${a.ref} `) || l.includes(` ${a.ref}`));
console.log(`actor receive-pack POST: HTTP ${res.status}`);
if (res.status === 200) console.log(`report-status: ${JSON.stringify(status)}`);
else console.log(`response body: ${JSON.stringify(resBody.toString().slice(0, 120))}`);
const accepted = res.status === 200 && status.includes('unpack ok') && refStatus?.startsWith(`ok ${a.ref}`) === true;

const after = await advertisedRefs(ownerToken, 'git-receive-pack');
const afterSha = after.refs[a.ref];
console.log(`owner readback after: ${a.ref} ${afterSha}`);
console.log(
  JSON.stringify({
    accepted,
    refMoved: afterSha !== oldSha,
    refNow: afterSha,
    expectedIfAccepted: a.new,
  }),
);
