/**
 * The provenance panel on the commit and change pages is readable by anyone
 * who can read the repository, anonymous readers of a public one included.
 * The credential's token prefix (sandbox runs mint agent tokens, so this is
 * where a sandbox token prefix would surface) and the submitting principal
 * are shown to repository admins only (#41, #45).
 */

import { env as cfEnv } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { getRepoById, type RepoRow } from '../src/db/repos';
import { commitProvenance } from '../src/services/provenancePanel';
import { provenancePanel } from '../src/render/provenance';
import { seedRepo } from './helpers/seed';

const env = cfEnv as unknown as Env;

const SHA = 'a'.repeat(40);
const PREFIX = 'kvarm_agt_0123abcd';
const PRINCIPAL = 'agent:sandbox-agent-id';
let repo: RepoRow;

beforeAll(async () => {
  const { id } = await seedRepo(env, 'provenance-redaction', { owner: 'redaction-owner', visibility: 'public', register: false });
  repo = (await getRepoById(env.DB, id))!;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO attribution_evidence (repo_id, commit_sha, note_digest, notes_commit, source, agent, session, prompt_hash, model, actor,
       level, reasons, principal, token_kind, token_prefix, run_id, key_id, at, recorded_at)
     VALUES (?1, ?2, 'digest', 'notes', 'api', 'sandbox', 'run-1', NULL, 'model-x', 'redaction-owner',
       'authenticated', '[]', ?3, 'agent', ?4, NULL, NULL, ?5, ?5)`,
  )
    .bind(repo.id, SHA, PRINCIPAL, PREFIX, now)
    .run();
});

describe('provenance panel redaction', () => {
  it('shows a non-admin reader the attribution without the token prefix or principal', async () => {
    const panel = await commitProvenance(env, repo, SHA, { admin: false });
    expect(panel.attribution?.evidence).toMatchObject({ level: 'authenticated', tokenPrefix: null, principal: null });
    const html = provenancePanel(panel);
    expect(html).toContain('sandbox');
    expect(html).not.toContain(PREFIX);
    expect(html).not.toContain(PRINCIPAL);
  });

  it('shows a repository admin the token prefix', async () => {
    const panel = await commitProvenance(env, repo, SHA, { admin: true });
    expect(panel.attribution?.evidence).toMatchObject({ tokenPrefix: PREFIX, principal: PRINCIPAL });
    expect(provenancePanel(panel)).toContain(PREFIX);
  });
});
