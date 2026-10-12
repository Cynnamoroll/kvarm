/**
 * One entry per library/cost.md table row for scripts/cost-sweep.mjs.
 *
 * A live entry names the probe tag the sweep records samples under and the
 * row's budget as a spec (`d1<=2;art=0;cache=hit`; a function when the row's
 * budget is a formula or depends on the sample's variant; '' for a row that is
 * reported only). A non-live entry names why the sweep cannot exercise the row
 * against the live worker (a fault path covered by workerd tests, a heavy
 * fixture, a per-call component of a row checked live, a CPU microbenchmark,
 * a deferred surface, or a row without a budget).
 *
 * `section` matches a substring of the row's nearest heading and `row` a
 * prefix of its first cell (both normalized by cost-sweep.mjs normalizeCell);
 * `state` a prefix of the State column where the table has one.
 *
 * Every live HTTP entry names the intended `status` of its samples (expected
 * denials included), so a transport failure, a 5xx or a wrong answer cannot
 * pass on its counters. Entries checked against recorded or logged counters
 * name their `format` instead (`stored`, `log` or `build`, see COUNTER_SETS in
 * cost-sweep.mjs); their samples carry no HTTP status.
 */

import { requireKinds, smallVsMany } from './cost-sweep.mjs';

const PUBLICATION = 'd1<=3;rr<=12;rw<=8;art<=4;do=2;sub<=2';
const byKind = (specs) => (s) => {
  const spec = specs[s.extra?.kind];
  if (spec === undefined) throw new Error(`no budget for sample kind ${s.extra?.kind}`);
  return spec;
};
const formulaArt = (plus) => (s) => `d1<=2;art<=${(s.extra?.treeReads ?? 0) + (s.extra?.blobReads ?? 0) + plus};sub<=1`;
const sameAsRest = (s) => {
  const r = s.extra?.rest ?? {};
  return ['d1', 'art', 'do', 'r2b', 'sub'].map((k) => `${k}=${r[k] ?? 0}`).join(';');
};
const p50Below = (limitMs) => (samples) => {
  const xs = samples.map((s) => s.extra?.ms).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const p50 = xs[Math.ceil(xs.length / 2) - 1];
  return xs.length < 10 ? [`${xs.length} timed runs < 10`] : p50 >= limitMs ? [`p50 ${p50} ms >= ${limitMs} ms`] : [];
};

// Intended HTTP status of a sample when one probe tag collects two kinds of answer.
const statusByKind = (statuses) => (s) => {
  const status = statuses[s.extra?.kind];
  if (status === undefined) throw new Error(`no intended status for sample kind ${s.extra?.kind}`);
  return status;
};
/** git.any also collects the anonymous receive-pack advertisement, which is refused with 401. */
const gitAnyStatus = (s) => (s.extra?.denied ? 401 : 200);
/** branch-rules POST creates (201); PATCH and DELETE answer 200. */
const createdOr200 = (s) => (s.extra?.created ? 201 : 200);

const L = (id, section, row, probe, budget, more = {}) => ({ id, section, row, kind: 'live', probe, budget, ...more });
const N = (id, section, row, category, reason, more = {}) => ({ id, section, row, kind: 'nonlive', category, reason, ...more });

const AUTH = 'authority component vs total';
const BASE = 'baseline budgets';
const PER = 'per-endpoint budgets';
const EXP = 'expanded measurement rules';
const CMP = 'compare and diff';
const EVT = 'push event consumer';
const SNAP = 'snapshots (m4-snapshot-builder)';
const CHK = 'kvarm checkout';
const GW = 'server-side git writes';
const ME = 'merge engine';
const CR = 'change requests';
const WS = 'agent workspaces';
const NX = 'nexus intents';
const CAND = 'candidates, arenas';
const GUARD = 'change guard';
const MCP = 'mcp server';
const ATTR = 'attribution notes';
const MQ = 'merge queue and integration train';
const CONF = 'conflict resolution';
const TASK = 'agent task dispatch';
const REV = 'review approvals';
const DEP = 'pinned dependencies';
const R2 = 'scrutiny repair round 2';
const R3 = 'scrutiny repair round 3';
const CI = 'ci runner (m5';
const FLEET = 'fleet run';
const CONT = 'container ci runner route';
const PERF = 'performance audit';
const TWO = 'two-pin publication read';

export const CATALOG = [
  // Authority component vs total request D1 (contract-pinned warm/read totals)
  L('auth-warm-meta', AUTH, 'Warm authenticated public-repo metadata GET', 'repo.get.pat.warm', 'd1<=1;rw=0;do=0', { minSamples: 5, status: 200 }),
  L('auth-warm-compare', AUTH, 'Warm compare / per-file diff', 'compare.warm.any', 'd1<=1;art=0;do=0;sub=0;cache=hit', { minSamples: 5, status: 200 }),
  L('auth-cold-compare', AUTH, 'Cold compare', 'compare.bypass', formulaArt(3), { status: 200 }),
  L('auth-snap-meta', AUTH, 'Warm snapshot metadata', 'snap.meta.warm', 'd1<=2;art=0', { status: 200 }),
  L('auth-snap-download', AUTH, 'Snapshot download', 'snap.download.miss', 'd1<=2;r2b=1;r2a=0;art=0', { status: 200 }),
  L('auth-ws-list', AUTH, 'Workspace list', 'ws.list', 'd1<=2;do=0', { status: 200 }),
  L('auth-queue', AUTH, 'Queue read', 'queue.get', 'd1<=2', { status: 200 }),
  L('auth-deps', AUTH, 'Warm dependency list', 'deps.list', 'd1<=3;art=0;do=0', { status: 200 }),
  N('auth-audit', AUTH, 'Audit export', 'deferred', 'no audit export route exists: the audit export feature (m6b-audit-export) is deferred past submission'),
  L('auth-cand', AUTH, 'Warm candidates', 'cand.warm', 'd1=3;art=0;do=0;sub=0', { status: 200 }),
  L('auth-arena-cand', AUTH, 'Warm arena candidates', 'arena.cand.warm', 'd1=4;art=0;do=0;sub=0', { status: 200 }),

  // Baseline budgets
  L('base-cached', BASE, 'Warm cached repo GET with a fully cached body', 'warm.cachedBody', 'd1<=1;art=0;do=0', { status: 200 }),
  L('base-service-row', BASE, 'Warm repo GET that also does a service-row lookup', 'warm.serviceRow', 'd1<=2;art=0;do=0', { status: 200 }),
  L('base-auth', BASE, 'Warm authenticated repo GET', 'repo.get.pat.warm', 'd1<=1', { status: 200 }),
  L('base-cold-compare', BASE, 'Cold compare', 'compare.bypass', formulaArt(3), { status: 200 }),
  L('base-git', BASE, 'Git gate request', 'git.any', 'do=0', { status: gitAnyStatus }),
  N('base-write', BASE, 'Write endpoints', 'guideline', 'a batching guideline ("where possible"), not a counter budget; every write endpoint has its own row, checked by its entry'),
  L('base-consumer', BASE, 'Queue consumer', 'consumer.push.initial', 'd1<=2', { format: 'log' }),
  L('base-workflows', BASE, 'Workflows', 'snapbuild.any', (s) => `steps<=${Math.ceil((s.extra?.files ?? 0) / 500) + 2}`, { format: 'build' }),
  L('base-mcp', BASE, 'MCP tool call', 'mcp.call', sameAsRest, { status: 200 }),

  // Per-endpoint budgets
  L('per-authority', PER, 'Authority component on every repo metadata', 'auth.component', 'd1<=1;rr<=8;do=0', { minSamples: 10, status: 200 }),
  L('per-git-any', PER, 'git gate (any subpath)', 'git.anonWrite', 'd1=0;do=0;art=0;sub=0', { status: 401 }),
  L('per-rest-user', PER, 'REST GET/PATCH/DELETE /repos/:o/:r, /user', 'user.get', 'd1<=1;do=0', { status: 200 }),
  L('per-healthz', PER, 'GET /healthz', 'healthz', 'd1=0;rr=0;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0;cache=none', { status: 200 }),
  L('per-inforefs-warm', PER, 'git gate info/refs?service=git-upload-pack, public, anonymous', 'git.inforefs.anon.warm', 'd1<=1;art=0;do=0;sub=0;cache=hit', { state: 'warm', minSamples: 2, status: 200 }),
  L('per-inforefs-cold', PER, 'same', 'git.inforefs.anon.cold', 'd1<=1;art<=2;do=0;sub=1;cache=miss', { state: 'cold (info/refs miss)', status: 200 }),
  L('per-uploadpack', PER, 'git gate git-upload-pack POST, public, anonymous', 'git.uploadpack', 'd1<=1;art=0;do=0;sub=1', { status: 200 }),
  L('per-git-pat', PER, 'git gate, private read or any write (PAT basic auth)', 'git.pat', 'd1=1;rw<=1;do=0;sub=1', { status: 200 }),
  L('per-git-ratelimit', PER, 'git gate rate limit', 'git.any', 'do=0', { status: gitAnyStatus }),
  L('per-rest-public-warm', PER, 'REST GET /api/v1/repos/:o/:r, public, PAT', 'repo.get.pat.warm', 'd1<=1;rr<=8;rw=0;do=0', { state: 'warm', status: 200 }),
  L('per-rest-public-cold', PER, 'same', 'repo.get.pat.cold', 'd1<=1', { state: 'cold', exactState: true, status: 200 }),
  L('per-rest-private', PER, 'REST GET /api/v1/repos/:o/:r, private, PAT', 'repo.get.private', 'd1=1;rw<=1;do=0', { status: 200 }),
  L('per-patch', PER, 'REST PATCH /api/v1/repos/:o/:r', 'repo.patch', 'd1=2;rw<=2', { status: 200 }),
  L('per-delete', PER, 'REST DELETE /api/v1/repos/:o/:r', 'repo.delete', 'd1=2;art=1;r2a=0;r2b=0', { status: 200 }),
  L('per-create', PER, 'REST POST /api/v1/repos', 'repo.create', 'd1<=3;art=1', { status: 201 }),
  L('per-token-delete', PER, 'REST DELETE /api/v1/user/tokens/:id', 'token.delete', 'd1<=2', { status: 200 }),
  L('per-failed-auth', PER, 'Failed auth (unknown well-formed PAT)', 'auth.unknownPat', byKind({ first: 'd1<=1;do=0', repeat: 'd1=0;do=0' }), { status: 401 }),
  L('per-page', PER, 'repo page GET /:o/:r (public, anonymous)', 'page.plain', byKind({ cold: 'art<=3;cache=miss', warm: 'd1<=1;art=0;do=0;cache=hit' }), { status: 200 }),
  L('per-page-after-push', PER, 'repo page GET /:o/:r and info/refs', 'page.afterPush', byKind({ page: 'd1<=1;art<=5;do=0;sub=0;cache=miss', inforefs: 'd1<=1;art=0;do=0;sub=1;cache=miss' }), { status: 200 }),
  L('per-rejected-bearer', PER, 'repo page / raw file', 'page.rejectedBearer', byKind({ public: 'd1<=1;rw=0;art=0;do=0;sub=0;cache=hit', private: 'd1<=1;cache=none' }), { status: statusByKind({ public: 200, private: 404 }) }),
  L('per-private-personal', PER, 'REST GET /api/v1/repos/:o/:r, private personal repo', 'repo.get.private', 'd1=1;rr<=8;rw=0;do=0;art=0', { status: 200 }),
  L('per-private-org', PER, 'REST GET /api/v1/repos/:o/:r, private org repo, member with grant', 'repo.get.orgMember', 'd1=1;rr<=8;rw=0;do=0;art=0', { status: 200 }),
  L('per-after-revoke', PER, 'same, first request after grant revoke / member removal', 'denied.afterRevoke', 'd1<=1;rr<=8;do=0;art=0;sub=0', { status: [401, 404] }),
  L('per-raw-sha-private', PER, 'repo raw file / blob page at a commit SHA', 'raw.private.sha', byKind({ cold: 'd1=1;art<=2;cache=miss', warm: 'd1<=2;rr<=8;rw=0;art=0;sub=0;do=0;cache=hit' }), { status: 200 }),
  L('per-raw-sha-denied', PER, 'same, first request after grant revoke / PAT revocation', 'raw.private.denied', 'd1<=1;rr<=8;art=0;sub=0;do=0;cache=none', { status: 404 }),
  L('per-git-org-member', PER, 'git gate private read (info/refs?service=git-upload-pack), member with grant', 'git.inforefs.orgMember', 'd1=1;rr<=8;do=0;sub=1', { status: 200 }),
  L('per-org-create', PER, 'REST POST /api/v1/orgs', 'org.create', 'd1=2', { exact: true, status: 201 }),
  L('per-org-members', PER, 'REST PUT/DELETE /api/v1/orgs/:org/members/:login', 'org.member.write', 'd1=2;do=0', { status: 200 }),
  L('per-org-read', PER, 'REST GET /api/v1/orgs/:org', 'org.read', 'd1<=2', { status: 200 }),
  L('per-org-repo', PER, 'REST POST /api/v1/orgs/:org/repos', 'org.repo.create', 'd1<=4;art=1', { status: 201 }),
  L('per-grants', PER, 'REST PUT/DELETE/GET /api/v1/repos/:o/:r/grants', 'grants', 'd1=2', { status: 200 }),

  // Agent credentials and branch rules (under "Expanded measurement rules")
  L('exp-agent-read', EXP, 'REST GET /api/v1/repos/:o/:r (or any repo route), agent token', 'agent.repo.get', 'd1=1;rr<=8;do=0;art=0', { status: 200 }),
  L('exp-agent-revoked', EXP, 'same, first request after token revoke', 'agent.revoked', 'd1<=1;rr<=8;do=0;art=0;sub=0', { status: 401 }),
  L('exp-agent-denied-ref', EXP, 'git gate POST git-receive-pack, agent token, denied ref', 'git.agentDenied', 'd1=1;rr<=8;art=0;do=0;sub=0', { status: 200 }),
  L('exp-agents-create', EXP, 'REST POST /api/v1/agents', 'agents.create', 'd1=2', { exact: true, status: 201 }),
  L('exp-agents-read', EXP, 'REST GET /api/v1/agents', 'agents.read', 'd1=2', { status: 200 }),
  L('exp-agents-token', EXP, 'REST POST /api/v1/agents/:id/tokens', 'agents.token.create', 'd1<=4', { status: 201 }),
  L('exp-agents-delete', EXP, 'REST DELETE /api/v1/agents/:id', 'agents.delete', 'd1=2', { status: 200 }),
  L('exp-rule-denied', EXP, 'git gate POST git-receive-pack, human PAT, repo with branch rules', 'git.ruleDenied', 'd1=1;rr<=9;art=0;do=0;sub=0', { status: 200 }),
  L('exp-rule-allowed', EXP, 'same, unprotected ref', 'git.ruleAllowed', 'd1=1;art<=2;do=0;sub=1', { status: 200 }),
  L('exp-rules-write', EXP, 'REST POST/PATCH/DELETE /repos/:o/:r/branch-rules', 'rules.write', 'd1=2', { status: createdOr200 }),
  L('exp-rules-read', EXP, 'REST GET /repos/:o/:r/branch-rules', 'rules.read', 'd1<=2', { status: 200 }),

  // Compare and diff
  L('cmp-warm', CMP, 'GET …/compare/:base…:head, …/commits/:sha/diff', 'compare.warm', 'd1<=1;art=0;do=0;sub=0;cache=hit', { minSamples: 5, status: 200 }),
  L('cmp-file-warm', CMP, 'GET …/compare/:base…:head/file', 'filediff.warm', 'd1<=1;art=0;do=0;sub=0;cache=hit', { minSamples: 5, status: 200 }),
  L('cmp-bypass', CMP, 'compare, cold via admin', 'compare.bypass', (s) => `${formulaArt(3)(s)};cache=bypass`, { status: 200 }),
  L('cmp-first', CMP, 'compare, first-ever', 'compare.first', formulaArt(3), { status: 200 }),
  L('cmp-1m', CMP, 'compare, 1M-line bench pair', 'compare.fixture1m', (s) => `d1<=2;art<=${(s.extra?.treeReads ?? 0) + 3};cache=bypass`, { aggregate: p50Below(500), status: 200 }),
  L('cmp-wide', CMP, 'compare, wide tree', 'compare.wide', 'treeReads<=2000;art<=2004', { status: 200 }),
  L('cmp-file-cold', CMP, 'file diff, cold', 'filediff.cold', 'd1<=2;art<=3', { status: 200 }),
  L('cmp-denied', CMP, 'compare / file diff, denied', 'compare.denied', 'd1=1;art=0;do=0;sub=0;cache=none', { status: 404 }),
  L('cmp-receive-pack', CMP, 'git-receive-pack POST (any)', 'git.receivepack.ng', 'd1<=1;rw=0;art=0;do=0;sub<=1', { status: 200 }),

  // Push event consumer and events API
  L('evt-initial', EVT, 'forge-events consumer, per message, known repo', 'consumer.push.initial', 'd1=2;do=0;art=0;wf<=1', { state: 'first', format: 'log' }),
  N('evt-duplicate', EVT, 'same', 'workerd-only', 'a redelivery of a completed message cannot be requested from the live queue; workerd consumer tests pin d1=1', { state: 'duplicate' }),
  N('evt-unknown', EVT, 'same', 'not-triggerable', 'needs an Artifacts repo outside the registry or another namespace; the sweep creates only registered repos (workerd tests pin unknown-repo d1=1, other namespace d1=0)', { state: 'unknown' }),
  L('evt-list', EVT, 'REST GET /api/v1/repos/:o/:r/events', 'events.list', 'd1<=2;art=0;do=0;sub=0', { status: 200 }),

  // Snapshots
  L('snap-meta-warm', SNAP, 'GET /api/v1/repos/:o/:r/snapshots/:ref', 'snap.meta.warm', 'd1<=2;art=0;r2a=0;r2b=0;do=0;sub=0', { state: 'warm', status: 200 }),
  L('snap-meta-first', SNAP, 'same', 'snap.meta.first', 'd1<=2;art<=1;sub<=1', { state: 'first', status: 200 }),
  L('snap-download', SNAP, 'GET …/snapshots/:ref/download', 'snap.download.miss', 'd1<=2;r2b=1;r2a=0;art=0;do=0', { status: 200 }),
  L('snap-denied', SNAP, 'same / metadata', 'snap.denied', 'd1=1;r2b=0;art=0', { status: 404 }),
  L('snap-demand', SNAP, 'POST …/snapshots/:ref (demand)', 'snap.demand', 'd1=2;sub<=1;art=0', { state: 'new', status: 202 }),
  N('snap-start-failure', SNAP, 'same', 'workerd-only', 'needs a Workflows outage (create and get both failing); covered by the workerd seam test', { state: 'workflow' }),
  L('snap-build-small', SNAP, 'Initial build, small tree', 'snapbuild.small', 'steps<=3;d1<=3;r2a<=1', { format: 'build' }),
  L('snap-build-demanded', SNAP, 'Initial build, demanded 20-file workspace tree', 'snapbuild.demanded', 'steps<=3;d1<=3;r2a<=1', { format: 'build' }),
  L('snap-build-1200', SNAP, 'Initial build, 1,200 files', 'snapbuild.many', 'steps<=5;d1<=3;r2a<=1', { format: 'build' }),
  N('snap-build-9mib', SNAP, 'Initial build, sixteen 9 MiB blobs', 'heavy-fixture', 'a 151 MB tree upload per sweep; the multipart path is exercised live by the 502-file fixture build (row "fixture-1m bench-head", 4 parts) checked by its entry'),
  L('snap-build-1m', SNAP, 'Initial build, fixture-1m bench-head', 'snapbuild.fixture1m', 'steps<=4;d1<=3', { format: 'build' }),
  L('snap-build-reuse', SNAP, 'Tree reuse', 'snapbuild.reuse', 'steps=1;d1<=2;art<=2;r2a=0', { format: 'build' }),
  N('snap-build-replay', SNAP, 'Replay of a finished build', 'workerd-only', 'replaying a finished Workflow instance is not requestable live; workerd test "replaying a finished build does nothing"'),
  N('snap-build-retry', SNAP, 'Interrupted batch retried', 'workerd-only', 'needs an injected batch failure; workerd test "retries an interrupted batch…"'),
  N('snap-build-failed', SNAP, 'Failed build', 'workerd-only', 'needs a failing build input or binding fault; workerd snapshot tests'),

  // kvarm checkout
  L('chk-ready', CHK, 'Snapshot ready', 'checkout.ready', byKind({ demand: 'd1=2;sub<=1;art=0;r2a=0;r2b=0', download: 'd1<=2;r2a=0;art=0;r2b<=1' }), { status: 200 }),
  L('chk-not-ready', CHK, 'Snapshot not ready', 'snap.demand', 'd1=2;sub<=1;art=0', { status: 202 }),
  L('chk-no-token', CHK, 'No token', 'snap.meta.anon', 'd1<=2;art=0', { status: 200 }),
  L('chk-no-api', CHK, 'Token without api scope', 'snap.demand.noApi', 'd1<=1;art=0;sub=0', { status: 401 }),

  // Server-side git writes and the merge engine: per-call components of endpoint rows
  N('gw-updateref', GW, 'updateRef', 'component', 'per-call work inside POST workspaces, merge and abandon (sub=2 there includes this receive-pack); those rows are checked live'),
  N('gw-listrefs', GW, 'listRefs', 'component', 'per-call work of the callers that list refs; their rows are checked live'),
  N('gw-mergebase', GW, 'mergeBase', 'component', 'per-call commit reads inside merge/dependency rows checked live'),
  N('me-mergeability', ME, 'computeMergeability', 'component', 'per-call work inside GET mergeability, change detail and merge, checked live'),
  N('me-gate', ME, 'checks-gate requiredChecksFor', 'component', 'one coalesced batch inside change detail (d1=3), candidates (d1=3) and merge rows, checked live'),
  N('me-publish', ME, 'publishMerge', 'component', 'the gate plus one updateRef inside POST merge, checked live'),

  // Change requests
  L('cr-list', CR, 'GET …/changes (list)', 'changes.list', 'd1=2;art=0;sub=0;do=0', { status: 200 }),
  L('cr-detail', CR, 'GET …/changes/:n (detail, open)', 'changes.detail.open', 'd1=3;art=0;sub=0;do=0', { minSamples: 5, status: 200 }),
  L('cr-detail-closed', CR, 'GET …/changes/:n (closed/merged)', 'changes.detail.closed', 'd1=2;art=0;sub=0', { status: 200 }),
  L('cr-checks', CR, 'GET …/changes/:n/checks', 'changes.checks', 'd1=2', { status: 200 }),
  L('cr-mergeability', CR, 'GET …/changes/:n/mergeability', 'changes.mergeability', byKind({ cold: 'd1=3;sub<=1', warm: 'd1=3;art=0;sub=0' }), { status: 200 }),
  L('cr-create', CR, 'POST …/changes', 'changes.create', 'd1=2;sub=1;do=0', { exact: true, status: 201 }),
  L('cr-create-missing', CR, 'POST …/changes refused (missing branch)', 'changes.create.missing', 'd1=1;sub=1;rw=0', { status: 422 }),
  // "create + merge row": a two-parent merge adds its attribution note (Attribution notes: d1 +2, sub +2); a fast-forward adds nothing
  L('cr-create-auto', CR, 'POST …/changes with mergePolicy: auto that merges', 'changes.create.autoMerged', byKind({ 'fast-forward': 'd1<=8;sub<=3;do=0', 'two-parent': 'd1<=10;sub<=5;do=0' }), { status: 201 }),
  L('cr-create-auto-conflict', CR, 'POST …/changes with mergePolicy: auto whose merge attempt conflicts', 'changes.create.autoConflict', 'd1=2;sub<=2;do=0', { status: 201 }),
  L('cr-patch', CR, 'PATCH …/changes/:n', 'changes.patch', 'd1=2;rw<=4', { status: 200 }),
  L('cr-merge', CR, 'POST …/changes/:n/merge', 'changes.merge.ff', 'd1<=6;sub<=2;do=0', { status: 200 }),
  L('cr-merge-draft', CR, 'POST …/merge refused before planning', 'changes.merge.draft', 'd1=2;art=0;sub=0', { status: 409 }),
  L('cr-head-moved', CR, 'Live head confirmation on merge', 'changes.merge.headMoved', 'd1=2;sub=1;art=0;rw=0', { status: 409 }),
  L('cr-hooks', CR, 'Push event, change-hooks effect', 'consumer.changeHooks', 'd1<=7;do=0', { format: 'log' }),
  N('cr-it-repair', CR, 'Integration-train repair', 'no-budget', 'records where statements ride (no budget moved); the caps it names (publication d1<=3, enqueue <=2, dependency create/repin <=3, task completion <=6) are checked live by their own rows'),
  N('cr-auto-selection', CR, 'Auto-merge selection', 'workerd-only', 'paging past 20 auto changes on one push needs 21 auto changes; workerd test pins the second page'),
  N('cr-checkrun-index', CR, 'Detail check-run lookup', 'workerd-only', 'equal rows read at 150 and 1,650 runs needs 1,650 check runs on one change; workerd test pins it'),

  // Agent workspaces
  L('ws-create', WS, 'POST …/workspaces', 'ws.create', 'd1<=3;sub=2;do=0', { exact: true, status: 201 }),
  L('ws-get', WS, 'GET …/workspaces/:id', 'ws.get', 'd1=2;sub<=1', { status: 200 }),
  L('ws-list', WS, 'GET …/workspaces (list)', 'ws.list', 'd1=2;do=0;art=0;sub=0', { status: 200 }),
  L('ws-change-set', WS, 'POST …/workspaces/:id/change-set', 'ws.changeSet', 'd1=4;sub<=1', { status: 201 }),
  L('ws-abandon', WS, 'POST …/workspaces/:id/abandon', 'ws.abandon', 'd1<=4;sub=2', { status: 200 }),
  L('ws-merge', WS, 'Change merge with a linked workspace', 'ws.merge', 'd1<=6;sub<=2;do=0', { status: 200 }),
  L('ws-agent-push', WS, 'git gate, agent push touching refs/heads/agents/', 'git.agentWorkspacePush', 'd1<=2;do=0', { status: 200 }),

  // Nexus intents, forecast and overlap
  L('nx-create-intent', NX, 'POST …/workspaces with intent', 'ws.create.intent', 'd1<=3;sub=2', { status: 201 }),
  L('nx-intent-get', NX, 'GET …/workspaces/:id/intent', 'intent.get', 'd1=2;art=0;do=0;sub=0', { status: 200 }),
  L('nx-intent-post', NX, 'POST …/workspaces/:id/intent', 'intent.post', byKind({ person: 'd1=2;art=0;do=0', agent: 'd1=3;art=0;do=0' }), { status: 200 }),
  L('nx-forecast', NX, 'GET …/forecast', 'forecast', 'd1=2;art=0;do=0;sub=0', { status: 200 }),
  L('nx-overlap', NX, 'GET …/workspaces/overlap', 'overlap', 'd1=2;art=0;do=0', { status: 200 }),
  L('nx-consumer', NX, 'push consumer, workspace ref', 'consumer.push.workspace', 'd1=2;do=0', { format: 'log' }),
  L('nx-abandon', NX, 'abandon / merge / repo delete', 'ws.abandon', 'd1<=4', { status: 200 }),

  // Candidates, arenas and composition
  L('cand-warm', CAND, 'GET …/candidates warm', 'cand.warm', 'd1=3;art=0;do=0;sub=0', { minSamples: 5, status: 200 }),
  L('cand-cold', CAND, 'GET …/candidates cold', 'cand.cold', 'd1=3;sub<=1', { status: 200 }),
  L('cand-over-cap', CAND, 'GET …/candidates over the cap', 'cand.overCap', 'd1=1;art=0', { status: 422 }),
  L('cand-arena', CAND, 'GET …/arenas/:id/candidates', 'arena.cand.warm', 'd1=4;art=0;do=0', { status: 200 }),
  L('cand-arena-create', CAND, 'POST …/arenas', 'arena.create', (s) => `d1=${s.extra.n + 2};sub=${s.extra.n + 1}`, { exact: true, status: 201 }),
  L('cand-arena-read', CAND, 'GET …/arenas/:id, GET …/arenas', 'arena.read', 'd1=2', { status: 200 }),
  L('cand-arena-select', CAND, 'POST …/arenas/:id/select', 'arena.select', 'd1=3', { status: 200 }),
  L('cand-compose', CAND, 'POST …/candidates/compose (clean)', 'compose.clean', 'd1<=8;sub<=3', { status: 201 }),
  L('cand-compose-refused', CAND, 'POST …/candidates/compose (refused', 'compose.refused', 'd1=2;rw=0', { status: [409, 422] }),
  L('cand-composition', CAND, 'GET …/compositions/:id', 'composition.get', 'd1=2', { status: 200 }),
  L('cand-compositions', CAND, 'GET …/compositions?limit=', 'composition.list', 'd1=2;rw=0;art=0;do=0;sub=0', { status: 200 }),

  // Change guard and check runs
  L('guard-create', GUARD, 'POST …/changes (guard recorded with the row)', 'changes.create', 'd1=2;sub=1', { status: 201 }),
  L('guard-refresh', GUARD, 'Guard on head refresh', 'consumer.changeHooks', 'd1<=7;do=0', { format: 'log' }),
  L('guard-status', GUARD, 'GET …/commits/:sha/status', 'commit.status', 'd1=2;rw=0;art=0;do=0;sub=0', { status: 200 }),
  L('guard-checkrun', GUARD, 'POST …/check-runs', 'checkruns.post', 'd1=2;sub=0;art=0', { status: 201 }),
  L('guard-gate', GUARD, 'Checks-gate question', 'cand.warm', 'd1=3', { status: 200 }),

  // MCP server and content reads
  L('mcp-call', MCP, 'POST /mcp tools/call', 'mcp.call', sameAsRest, { minSamples: 5, status: 200 }),
  L('mcp-init', MCP, 'POST /mcp initialize', 'mcp.init', 'd1<=1;art=0;do=0;sub=0', { status: 200 }),
  L('mcp-unauth', MCP, 'POST /mcp without or with an invalid token', 'mcp.unauth', 'd1<=1;art=0;do=0', { status: 401 }),
  L('mcp-tree', MCP, 'GET …/tree', 'tree.get', (s) => `d1<=1;do=0;sub=0;art<=${3 + (s.extra?.segments ?? 0)}`, { status: 200 }),
  L('mcp-contents', MCP, 'GET …/contents', 'contents.get', byKind({ branch: 'd1<=1;do=0;art<=2', sha: 'd1<=1;art=0;do=0;cache=hit' }), { status: 200 }),

  // Attribution notes and decision records
  L('attr-post', ATTR, 'POST …/commits/:sha/attribution', 'attr.post', 'd1<=3;do=0;sub<=8', { status: 201 }),
  L('attr-get', ATTR, 'GET …/commits/:sha/attribution', 'attr.get', 'd1<=1;sub=1;do=0', { status: 200 }),
  L('attr-merge', ATTR, 'POST …/changes/:n/merge (two-parent merge', 'changes.merge.threeWay', 'd1<=8;sub<=4;do=0', { status: 200 }),
  L('attr-decision', ATTR, 'POST …/decisions', 'decision.post', 'd1<=2;art=0;do=0;sub=0', { status: 201 }),
  L('attr-context', ATTR, 'GET …/context', 'context.get', (s) => `d1<=2;art=0;do=0;sub=0;rr<=${5 * s.extra.branches * (s.extra.limit + 1) + 2 * (s.extra.limit + 1) + 20}`, { status: 200 }),
  L('attr-ingress', ATTR, 'POST /mcp ingress body', 'mcp.oversize', 'd1=0;rr=0', { status: 413 }),
  L('attr-mcp-repo-ops', ATTR, 'delete_repo / fork_repo / import_repo', 'mcp.repoOps', byKind({ fork: 'd1<=3;do=0', delete: 'd1=2;art=1;do=0' }), { status: 200 }),

  // Merge queue and integration train
  L('mq-enqueue', MQ, 'POST …/changes/:n/enqueue (new entry)', 'enqueue.branch', 'd1<=2;rr<=8;rw<=4;art=0;do<=1;q=1', { exact: true, status: 201 }),
  L('mq-enqueue-refused', MQ, 'POST …/enqueue refused', 'enqueue.refused', 'd1=3;rw=0', { status: 409 }),
  N('mq-enqueue-full', MQ, 'POST …/enqueue at admission capacity', 'workerd-only', 'needs 64 active entries in one repo; workerd pins d1=3, and the committed fleet-100 run recorded QUEUE_FULL with Retry-After 30 live'),
  L('mq-dequeue', MQ, 'DELETE …/changes/:n/enqueue', 'enqueue.delete', 'd1=2;q=1', { status: 200 }),
  L('mq-queue', MQ, 'GET …/queue', 'queue.get', 'd1<=2;rr<=20;rw=0;art=0;do=0', { status: 200 }),
  L('mq-publication', MQ, 'One uncontended one-ref publication of a ready candidate (entry cost', 'pub.stored.branch', PUBLICATION, { format: 'stored' }),
  L('mq-enqueue-ws', MQ, 'POST …/changes/:n/enqueue (new entry) of a workspace-backed change', 'enqueue.ws', 'd1<=2;rr<=12;rw<=4;art=0;do<=1;q<=1', { status: 201 }),
  L('mq-publication-completed', MQ, 'One uncontended one-ref publication of a ready candidate, completed request', 'pub.completed.branch', 'd1<=3;rr<=22;rw<=10;art<=4;do=2;q=0;sub<=2', { format: 'stored' }),
  L('mq-train-run', MQ, 'Train run (queue consumer, per kick)', 'train.run', 'passes<=12', { format: 'log' }),
  L('mq-mergelock', MQ, 'MergeLock DO', 'pub.stored.any', 'do=2', { format: 'stored' }),

  // Conflict resolution and agent tasks
  L('conf-detail', CONF, 'GET …/changes/:n (conflicted, steady)', 'changes.detail.conflicted', 'd1=2;rw=0', { status: 200 }),
  L('conf-transition', CONF, 'GET …/changes/:n or …/mergeability with a transition', 'changes.detail.transition', 'd1<=3', { status: 200 }),
  L('conf-mergeability', CONF, 'GET …/changes/:n/mergeability (conflicted, steady)', 'changes.mergeability.conflicted', 'd1=2;rw=0', { status: 200 }),
  L('conf-merge-refused', CONF, 'POST …/changes/:n/merge refused MERGE_CONFLICT', 'changes.merge.conflict', 'd1=2;rw=0', { status: 409 }),
  L('conf-merge-resolved', CONF, 'POST …/changes/:n/merge (resolved three-way merge)', 'changes.merge.resolved', 'd1<=8;sub<=4;do=0', { status: 200 }),
  L('conf-tasks', CONF, 'GET …/tasks?status=open', 'tasks.list', 'd1<=2;rw=0;art=0', { status: 200 }),
  L('conf-hooks', CONF, 'Push to a head branch', 'consumer.changeHooks', 'd1<=7;do=0', { format: 'log' }),
  N('conf-ejection', CONF, 'Train MERGE_CONFLICT ejection', 'workerd-only', 'two statements in the pass write batch (no extra round trip, so the train-run row covers its counters); provoking an ejection needs a conflicting queued pair, workerd pins it'),

  // Agent task dispatch
  L('task-get', TASK, 'GET …/tasks/:id', 'task.get', 'd1=2;rw=0', { exact: true, status: 200 }),
  L('task-list', TASK, 'GET …/tasks?status=open / list_tasks', 'tasks.list', 'd1<=2;rw=0', { status: 200 }),
  L('task-claim', TASK, 'POST …/tasks/:id/claim (new workspace)', 'task.claim', 'd1<=5;sub=1;do=0', { status: 200 }),
  L('task-claim-refused', TASK, 'POST …/tasks/:id/claim refused', 'task.claim.refused', 'd1<=3;sub=0', { status: 409 }),
  L('task-heartbeat', TASK, 'POST …/tasks/:id/heartbeat', 'task.heartbeat', 'd1<=4;sub=0', { status: 200 }),
  L('task-complete', TASK, 'POST …/tasks/:id/complete (draft/review)', 'task.complete', 'd1<=6;do=0;sub<=5', { status: 200 }),
  // completion (d1<=6, sub<=5) + the resolution's own guard run (recordGuard: read batch + insert, base ls-refs) + the auto merge (d1=6, sub=2)
  L('task-complete-auto', TASK, 'POST …/tasks/:id/complete (auto)', 'task.complete.auto', 'd1<=14;do=0;sub<=8', { status: 200 }),
  L('task-complete-refused', TASK, 'POST …/tasks/:id/complete refused', 'task.complete.refused', 'd1<=3;rw=0', { status: 409 }),
  L('task-conflict-mark', TASK, 'Conflict marking with a new task', 'changes.create.conflict', 'd1=2;sub=1', { status: 201 }),

  // Review approvals and escalations
  L('rev-enqueue', REV, 'POST …/enqueue (repo without branch rules, admitted)', 'enqueue.branch', 'd1<=2;rr<=8;rw<=4;art=0;do<=1', { status: 201 }),
  L('rev-enqueue-refused', REV, 'POST …/enqueue refused by the review gate', 'enqueue.reviewRefused', 'd1<=4;q=0', { status: 409 }),
  L('rev-enqueue-protected', REV, 'POST …/enqueue into a protected target', 'enqueue.protected', 'd1=4;q=1', { status: 201 }),
  L('rev-merge', REV, 'POST …/merge', 'changes.merge.ff', 'd1<=6;sub<=2', { exact: true, status: 200 }),
  L('rev-policy-put', REV, 'PUT …/review-policy', 'review.policy.put', 'd1=2', { status: 200 }),
  L('rev-policy-get', REV, 'GET …/review-policy', 'review.policy.get', 'd1=2', { status: 200 }),
  L('rev-review', REV, 'POST …/changes/:n/approve', 'review.post', 'd1<=4;do=0', { status: 201 }),
  L('rev-reviews', REV, 'GET …/changes/:n/reviews', 'review.list', 'd1<=3', { status: 200 }),
  L('rev-escalation', REV, 'POST …/escalations/:id/resolve', 'escalation.resolve', 'd1=2', { status: 200 }),
  L('rev-assign', REV, 'POST …/reviewers/assign', 'reviewers.assign', 'd1=2', { status: 200 }),
  L('rev-pending', REV, 'GET …/reviews/pending', 'reviews.pending', 'd1=2', { status: 200 }),
  L('rev-train', REV, 'Train', 'pub.stored.any', 'd1<=3', { format: 'stored' }),

  // Pinned dependencies and train status
  L('dep-create', DEP, 'POST …/workspaces/:id/dependencies (created)', 'deps.create', 'd1=3;sub=1;rw<=3;do=0', { status: 201, aggregate: (xs) => smallVsMany(xs, ['depth4']) }),
  L('dep-refused', DEP, '… refused (cycle', 'deps.refused', 'd1=2;sub=0;rw=0', {
    status: (s) => (s.extra?.kind === 'crossRepo' ? 404 : 422),
    aggregate: (xs) => [...requireKinds(xs, ['crossRepo']), ...smallVsMany(xs, ['depth5', 'cycle'])],
  }),
  L('dep-rev', DEP, '… refused REVISION_NOT_CURRENT', 'deps.revNotCurrent', 'd1=2;sub=1', { status: 422 }),
  L('dep-list', DEP, 'GET …/workspaces/:id/dependencies (warm)', 'deps.list', 'd1=2;art=0;rw=0;do=0', { status: 200, aggregate: (xs) => smallVsMany(xs, ['warm']) }),
  L('dep-repin', DEP, 'POST …/dependencies/:dep/repin', 'deps.repin', 'd1=3;sub=1;q<=1', { status: 200 }),
  L('dep-delete', DEP, 'DELETE …/dependencies/:dep', 'deps.delete', 'd1=3;q<=1', { status: 200 }),
  L('dep-train', DEP, 'GET …/train', 'train.get', 'd1=2;rw=0;q=0', { status: 200 }),
  L('dep-enqueue', DEP, 'POST …/enqueue', 'enqueue.branch', 'd1<=2;rr<=8;rw<=4', { exact: true, status: 201 }),
  L('dep-merge', DEP, 'POST …/merge and each train pass', 'pub.stored.any', 'd1<=3', { format: 'stored' }),
  L('dep-status', DEP, 'kvarm status <repo>', 'status.reads', 'q=0;rw=0', { status: 200 }),

  // Integration-train scrutiny repairs
  L('r2-complete', R2, 'POST …/tasks/:id/complete (draft/review), VAL-COST-027', 'task.complete', 'd1<=6;do=0;sub<=5', { status: 200 }),
  L('r2-landing', R2, 'Landing settlement', 'pub.stored.any', 'do=2', { format: 'stored' }),
  N('r2-settle-message', R2, 'forge-events consumer, kvarm.dependency-settle message', 'workerd-only', 'sent only on the exceptional landing path (more than 1,024 pins, a failed wake effect); needs fault injection or more than 1,024 live workspaces'),
  N('r3-alarm', R3, 'MergeLock alarm, settlement intent wakeup', 'workerd-only', 'a settlement intent exists only on the exceptional landing path; covered by workerd mergeLock/dependencies tests'),

  // CI runner
  L('ci-claim', CI, 'POST …/ci/jobs/claim', 'ci.claim', 'd1<=2;do=0;q=0', { status: 200 }),
  L('ci-report', CI, 'POST …/ci/jobs/:id/report', 'ci.report', 'd1<=2;do=0;q=0', { status: 200 }),
  L('ci-heartbeat', CI, 'POST …/ci/jobs/:id/heartbeat', 'ci.heartbeat', 'd1<=2;do=0;q=0', { status: 200 }),

  // Fleet run rows: live at the sweep's small N plus the committed N = 100 run
  L('fleet-ws-pages', FLEET, 'GET …/workspaces pages', 'fleet.wsPages', 'd1<=2;art=0;do=0;sub=0', { status: 200 }),
  L('fleet-overlap', FLEET, 'GET …/workspaces/overlap pages', 'fleet.overlap', 'd1<=2;art=0;do=0;sub=0', { status: 200 }),
  L('fleet-forecast', FLEET, 'GET …/forecast?path=', 'fleet.forecast', 'd1<=2;art=0;do=0;sub=0', { status: 200 }),
  L('fleet-enqueue', FLEET, 'POST …/enqueue, unpinned workspace-backed change', 'fleet.enqueue', 'd1<=2;rr<=12;rw<=4;art=0;do<=1;q<=1', { status: 201 }),
  L('fleet-enqueue-pinned', FLEET, 'POST …/enqueue, pinned dependent', 'fleet.enqueuePinned', '', { status: 201 }),
  L('fleet-pub-unpinned', FLEET, 'Train publication, stored merge_queue.cost, unpinned', 'fleet.pubUnpinned', PUBLICATION, { format: 'stored' }),
  L('fleet-pub-pinned', FLEET, 'Train publication, stored merge_queue.cost, with one incoming pin', 'fleet.pubOnePin', PUBLICATION, { format: 'stored' }),
  N('fleet-full', FLEET, 'Enqueue admission at capacity', 'workerd-only', 'needs 64 active entries; recorded by the committed fleet-100 run (429 QUEUE_FULL twice, both admitted after Retry-After 30)'),
  N('fleet-idle', FLEET, 'Longest interval with no queue entry', 'reported-only', 'reported only, not a budget (the committed fleet-100 run: 79.7 s)'),

  // Container CI runner route
  L('cont-run', CONT, 'POST …/ci/container-runs', 'container.run', 'd1=1;do=1;q=0;art=0', { status: 200 }),
  L('cont-reset', CONT, 'DELETE …/ci/container-runs/snapshot', 'container.reset', 'd1=1;do=1', { status: 200 }),

  // Performance audit, platform half
  L('perf-overlap', PERF, 'GET …/workspaces/overlap (limit 50), per page', 'overlap', 'd1=2;art=0;do=0;sub=0;rr<=80', { status: 200 }),
  L('perf-forecast-exact', PERF, 'GET …/forecast?path=<exact>', 'forecast.exact', 'd1=2;art=0;do=0;sub=0;rr<=80', { status: 200 }),
  L('perf-forecast-prefix', PERF, 'GET …/forecast?path=<prefix>/', 'forecast.prefix', 'd1=2;rr<=2022', { status: 200 }),
  L('perf-consumer', PERF, 'Push consumer, intent index', 'consumer.push.workspace', 'd1=2', { format: 'log' }),
  N('perf-train-unchanged', PERF, 'Train pass with an unchanged composition identity', 'reported-only', 'reported per pass with no budget; the second-pass savings are pinned by workerd queue.test.ts "reuses the staged CI commit"'),
  L('perf-train-passes', PERF, 'Train passes, live per-pass counters', 'train.passes', '', { format: 'stored' }),
  L('perf-two-pin', PERF, 'Train publication with two incoming pins', 'pub.stored.twoPin', PUBLICATION, { format: 'stored' }),
  L('perf-snap-hit', PERF, 'GET …/snapshots/:sha/download', 'snap.download.hit', 'd1<=1;r2b=0;art=0;cache=hit', { status: 200 }),
  L('perf-changes-all', PERF, 'GET …/changes?state=all', 'changes.listAll', 'd1=2', { status: 200 }),
  N('perf-mcp-cpu', PERF, 'POST /mcp tool result (CPU)', 'cpu-microbench', 'a CPU microbenchmark (scripts/bench/json-passthrough.mjs) with no request counter; the MCP counters are checked by the tools/call row'),
  N('perf-compare-cpu', PERF, 'Warm compare hit (CPU)', 'cpu-microbench', 'a CPU microbenchmark with no counter change; warm compare counters are checked by the compare rows'),
  N('perf-realtimehub', PERF, 'RealtimeHub Durable Object', 'no-path', 'the class was removed; no request reaches it'),

  // Two-pin publication read optimization
  N('two-workerd-statements', TWO, 'Workerd statement test', 'workerd-only', 'a per-statement rows-read probe inside workerd'),
  N('two-workerd-stored', TWO, 'Workerd two-pin publication', 'workerd-only', 'the workerd trainFleet.test.ts measurement; the live rows below are checked live'),
  L('two-live-two-pin', TWO, 'Live two-pin publication', 'pub.stored.twoPin', PUBLICATION, { format: 'stored' }),
  L('two-live-one-pin', TWO, 'Live one incoming pin', 'pub.stored.onePin', PUBLICATION, { format: 'stored' }),
  L('two-live-unpinned', TWO, 'Live unpinned', 'pub.stored.unpinned', PUBLICATION, { format: 'stored' }),
];
