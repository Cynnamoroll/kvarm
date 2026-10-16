/** Deterministic fixture, percentile and report helpers for git-storm. */

export const GIT_STORM_LIMITS = Object.freeze({ http: 5, git: 3, requests: 10_000, dedicatedGit: 64 });

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function summarize(values) {
  if (!values.length) return { n: 0, min: null, mean: null, p50: null, p90: null, p99: null, max: null };
  return {
    n: values.length,
    min: Math.min(...values),
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    p99: percentile(values, 99),
    max: Math.max(...values),
  };
}

export function checkGitStormCaps({ target, concurrency, dedicated = false, dedicatedHost, targetHost }) {
  if (!Number.isInteger(concurrency) || concurrency < 1) return 'concurrency must be a positive integer';
  if (target === 'local') return concurrency <= 64 ? null : 'local concurrency may not exceed 64';
  if (concurrency <= GIT_STORM_LIMITS.git) return null;
  if (!dedicated || !targetHost || dedicatedHost !== targetHost) {
    return `concurrency above ${GIT_STORM_LIMITS.git} requires --dedicated and KVARM_BENCH_DEDICATED equal to the target host`;
  }
  return concurrency <= GIT_STORM_LIMITS.dedicatedGit ? null : `dedicated concurrency may not exceed ${GIT_STORM_LIMITS.dedicatedGit}`;
}

export function gitAuthorization(mode, token, username) {
  if (mode === 'anonymous') return null;
  if (mode !== 'pat') throw new Error('--git-auth must be pat or anonymous');
  if (!token) throw new Error('KVARM_PAT is required for PAT-authenticated Git traffic');
  if (!username) throw new Error('Git username is required for PAT-authenticated Git traffic');
  return `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
}

// Write rate limits are keyed per credential, so measuring server write capacity needs one
// credential per writer; KVARM_PATS carries them, KVARM_PAT remains the single-credential form.
export function writerCredentials({ KVARM_PATS, KVARM_PAT } = {}) {
  const list = String(KVARM_PATS ?? '').split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
  if (list.length) return list;
  return KVARM_PAT ? [KVARM_PAT] : [];
}

export function credentialForWriter(credentials, writer) {
  if (!credentials.length) return null;
  return credentials[writer % credentials.length] ?? null;
}

export function redactCredentials(text, tokens) {
  const secrets = [...new Set(tokens.filter(Boolean))].flatMap((token) => [
    token,
    Buffer.from(`kvarm:${token}`).toString('base64'),
  ]);
  return secrets.reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), String(text));
}

export function benchBranch(ts, workload, suffix) {
  return `refs/heads/bench/${ts}-${workload}-${suffix}`;
}

export function validateExistingRepoTarget({ benchId, repo, workloads }) {
  if (!benchId || !/^[a-z0-9]{4,12}$/.test(benchId)) return '--existing-repo requires a valid --bench-id';
  const repoPrefix = `kvarm-bench-${benchId}-`;
  if (typeof repo !== 'string' || !repo.startsWith(repoPrefix) || repo.length === repoPrefix.length ||
      !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(repo)) {
    return `--existing-repo must be a valid repository name under kvarm-bench-${benchId}-`;
  }
  const allowed = new Set(['clone-cold', 'clone-shallow', 'fetch-noop', 'fetch-incremental']);
  const invalid = workloads.find((workload) => !allowed.has(workload));
  return invalid ? `--existing-repo does not allow workload ${invalid}` : null;
}

export function createRandom(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function fixtureFiles(fixture, seed = 1) {
  const random = createRandom(seed);
  const count = fixture === 'small' ? 50 : fixture === 'mixed' ? 500 : 5000;
  const files = [];
  for (let i = 0; i < count; i++) {
    const size = fixture === 'small' ? 1024 : fixture === 'mixed' ? 1024 + Math.floor(random() * 63 * 1024) : 1024;
    let text = '';
    while (text.length < size) text += Math.floor(random() * 36).toString(36);
    files.push([`files/${String(i).padStart(5, '0')}.txt`, `${text.slice(0, size - 1)}\n`]);
  }
  return files;
}

export function operationSummary(samples, requests) {
  const grouped = new Map();
  for (const request of requests) {
    const list = grouped.get(request.op) ?? [];
    list.push(request);
    grouped.set(request.op, list);
  }
  const cost = {};
  for (const [op, rows] of grouped) {
    const counters = [...new Set(rows.flatMap((r) => Object.keys(r.cost ?? {})))];
    cost[op] = {
      median: Object.fromEntries(counters.map((key) => [key, percentile(rows.map((r) => Number(r.cost?.[key]) || 0), 50)])),
      total: Object.fromEntries(counters.map((key) => [key, rows.reduce((n, r) => n + (Number(r.cost?.[key]) || 0), 0)])),
    };
  }
  const starts = samples.map((s) => s.start).filter(Number.isFinite);
  const ends = samples.map((s) => s.end).filter(Number.isFinite);
  const span = starts.length && ends.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) / 1000 : 0;
  const errorBuckets = {};
  for (const sample of samples) if (!sample.ok && (sample.status ?? 0) === 0) errorBuckets[0] = (errorBuckets[0] ?? 0) + 1;
  for (const request of requests) if (request.status < 200 || request.status >= 400) {
    errorBuckets[request.status] = (errorBuckets[request.status] ?? 0) + 1;
  }
  return {
    metrics: {
      latencyMs: summarize(samples.filter((s) => s.ok).map((s) => s.ms)),
      throughput: span > 0 ? samples.filter((s) => s.ok).length / span : 0,
      attemptsPerSuccess: summarize(samples.filter((s) => s.ok && Number.isFinite(s.attempts)).map((s) => s.attempts)),
      giveUps: samples.filter((s) => !s.ok).length,
    },
    errors: errorBuckets,
    requests: Object.fromEntries([...grouped].map(([op, rows]) => [op, rows.length])),
    totalRequests: requests.length,
    totalReqBytes: requests.reduce((n, r) => n + r.reqBytes, 0),
    totalResBytes: requests.reduce((n, r) => n + r.resBytes, 0),
    cost,
  };
}

export function opForPath(path) {
  if (path.startsWith('/api/')) return 'api';
  if (path.endsWith('/branches')) return 'page';
  if (path.includes('/info/refs') && path.includes('git-upload-pack')) return 'info-refs-upload';
  if (path.includes('/info/refs') && path.includes('git-receive-pack')) return 'info-refs-receive';
  if (path.endsWith('/git-upload-pack')) return 'upload-pack';
  if (path.endsWith('/git-receive-pack')) return 'receive-pack';
  return 'other';
}
