import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { modelFamilyEvidence } from './provenance';

interface AnalyticsGroupRow {
  filer_kind: string | null;
  model_family: string | null;
  category: string | null;
  severity: string | null;
  filed: number | null;
  open: number | null;
  resolved: number | null;
  wont_fix: number | null;
  irrelevant: number | null;
  acceptance: number | null;
  truncated: number;
}

interface AnalyticsChangeRow {
  created_at: number;
  first_verdict_at: number | null;
  approval_coverage: string | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
}

export async function getReviewAnalytics(
  env: Env,
  repo: RepoRow,
  rawDays?: string,
): Promise<ServiceResult<Record<string, unknown>>> {
  const days = rawDays === undefined ? 30 : Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > 180) {
    return { ok: false, status: 400, error: 'days must be an integer from 1 to 180', code: 'INVALID_DAYS' };
  }
  const since = Date.now() - days * 86_400_000;
  const [groupsResult, changesResult] = await env.DB.batch([
    env.DB.prepare(
      `WITH recent AS (
         SELECT c.id FROM change_sets c
          WHERE c.repo_id = ?1 AND c.updated_at >= ?2
          ORDER BY c.updated_at DESC, c.id LIMIT 501
       ), bounded AS (SELECT id FROM recent LIMIT 500),
       cap AS (SELECT COUNT(*) > 500 AS truncated FROM recent),
       grouped AS (
         SELECT CASE WHEN f.agent_id IS NULL THEN 'human' ELSE 'agent' END AS filer_kind,
                CASE WHEN f.agent_id IS NULL THEN 'human' ELSE COALESCE(
                  (SELECT a.model_family FROM agents a WHERE a.id = f.agent_id), 'unknown') END AS model_family,
                f.category, f.severity, COUNT(*) AS filed,
                SUM(f.status = 'open') AS open,
                SUM(f.status = 'resolved') AS resolved,
                SUM(f.status = 'wont-fix') AS wont_fix,
                SUM(f.status = 'irrelevant') AS irrelevant,
                CASE WHEN SUM(f.status IN ('resolved', 'irrelevant', 'wont-fix')) = 0 THEN NULL
                     ELSE 1.0 * SUM(f.status = 'resolved') / SUM(f.status IN ('resolved', 'irrelevant', 'wont-fix')) END AS acceptance
           FROM bounded b JOIN review_findings f ON f.change_set_id = b.id
          GROUP BY filer_kind, model_family, f.category, f.severity
       )
       SELECT grouped.*, cap.truncated FROM grouped CROSS JOIN cap
       UNION ALL
       SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, cap.truncated
         FROM cap WHERE NOT EXISTS (SELECT 1 FROM grouped)`,
    ).bind(repo.id, since),
    env.DB.prepare(
      `WITH recent AS (
         SELECT c.id, c.created_at FROM change_sets c
          WHERE c.repo_id = ?1 AND c.updated_at >= ?2
          ORDER BY c.updated_at DESC, c.id LIMIT 500
       )
       SELECT c.created_at,
              (SELECT MIN(r.created_at) FROM change_reviews r WHERE r.change_set_id = c.id) AS first_verdict_at,
              (SELECT r.coverage FROM change_reviews r
                WHERE r.change_set_id = c.id AND r.verdict = 'approve' AND r.coverage IS NOT NULL
                ORDER BY r.updated_at DESC, r.id LIMIT 1) AS approval_coverage
         FROM recent c`,
    ).bind(repo.id, since),
  ]);
  const rawGroups = (groupsResult?.results as AnalyticsGroupRow[] | undefined) ?? [];
  const truncated = Boolean(rawGroups[0]?.truncated);
  const groups = rawGroups.filter((row) => row.filer_kind !== null).map((row) => ({
    filerKind: row.filer_kind,
    modelFamily: row.model_family,
    modelFamilyEvidence: modelFamilyEvidence(
      row.filer_kind === 'agent' && row.model_family === 'unknown' ? null : row.model_family,
      row.filer_kind === 'human',
    ),
    category: row.category,
    severity: row.severity,
    filed: Number(row.filed),
    open: Number(row.open),
    resolved: Number(row.resolved),
    wontFix: Number(row.wont_fix),
    irrelevant: Number(row.irrelevant),
    acceptance: row.acceptance === null ? null : Number(row.acceptance),
  }));
  const changeRows = (changesResult?.results as AnalyticsChangeRow[] | undefined) ?? [];
  const firstVerdicts = changeRows.flatMap((row) =>
    row.first_verdict_at === null ? [] : [(row.first_verdict_at - row.created_at) / 60_000]);
  const coverage: number[] = [];
  for (const row of changeRows) {
    if (!row.approval_coverage) continue;
    try {
      const parsed = JSON.parse(row.approval_coverage) as { units?: unknown; acked?: unknown };
      if (typeof parsed.units === 'number' && parsed.units > 0 && typeof parsed.acked === 'number') {
        coverage.push(parsed.acked / parsed.units);
      }
    } catch {
      // Older coverage payloads are absent from analytics.
    }
  }
  return {
    ok: true,
    value: {
      days,
      groups,
      medianFirstVerdictMinutes: median(firstVerdicts),
      medianGuideCoverage: median(coverage),
      truncated,
    },
  };
}
