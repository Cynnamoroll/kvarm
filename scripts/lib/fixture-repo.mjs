/**
 * Isolated scratch repos for the live fixture drivers. A run may only use a
 * repo it creates itself, named `<prefix>-<purpose>-<timestamp>`, and only
 * ever deletes that repo. Existing repos, including protected bootstrap data
 * such as the kvarm-e2e repository, are rejected before any push and never deleted.
 */

const PROTECTED = new Set(['kvarm-e2e']);

/** null when `repo` is an acceptable isolated name for `prefix`, else the reason it is not. */
export function checkIsolatedName(repo, prefix) {
  if (PROTECTED.has(repo)) return `${repo} is protected bootstrap data`;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^${escaped}-[a-z0-9][a-z0-9-]*-\\d{10,}$`).test(repo)) {
    return `${repo} is not an isolated name (${prefix}-<purpose>-<timestamp>)`;
  }
  return null;
}

/**
 * Creates `owner/repo`, runs `body`, then deletes the repo unless `keep`.
 * With `org` the repo is an org repo: created through
 * `POST /api/v1/orgs/<org>/repos` and namespaced under it for the existence
 * check and the delete. The delete happens only when this call created the
 * repo, including when `body` throws. Returns `{ok: false, reason}` without
 * running `body` when the name is not isolated, the repo already exists, or
 * creation fails.
 */
export async function withFixtureRepo({ owner, repo, prefix, org, http, keep = false, visibility = 'public', log = () => {} }, body) {
  const invalid = checkIsolatedName(repo, prefix);
  if (invalid) return { ok: false, created: false, reason: invalid };
  const ns = org ?? owner;
  const existing = await http(`/api/v1/repos/${ns}/${repo}`);
  if (existing.status !== 404) {
    return { ok: false, created: false, reason: `${ns}/${repo} already exists or could not be checked (${existing.status}); refusing to reuse it` };
  }
  const made = org
    ? await http(`/api/v1/orgs/${org}/repos`, { method: 'POST', json: { name: repo, visibility } })
    : await http('/api/v1/repos', { method: 'POST', json: { name: repo, visibility } });
  if (made.status !== 201) return { ok: false, created: false, reason: `create ${ns}/${repo} failed (${made.status})` };
  try {
    return { ok: true, created: true, value: await body() };
  } finally {
    if (keep) {
      log(`# kept: ${ns}/${repo}`);
    } else {
      const del = await http(`/api/v1/repos/${ns}/${repo}`, { method: 'DELETE' });
      log(`# delete ${ns}/${repo} (created by this run): ${del.status}`);
    }
  }
}
