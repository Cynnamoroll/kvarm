import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

export interface CiPipelineParams {
  repoId: string;
  changeId: string;
  headSha: string;
  treeSha: string;
}

const STEP = { retries: { limit: 4, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' } as const;

/**
 * CI execution stays on user-owned runners. The Workflow durably orchestrates
 * the bounded platform side with a pipeline-state checkpoint. Snapshot demand
 * intentionally happens only when a user-owned runner claims an exact job.
 */
export class CiPipeline extends WorkflowEntrypoint<Env, CiPipelineParams> {
  async run(event: WorkflowEvent<CiPipelineParams>, step: WorkflowStep) {
    const state = await step.do('queued-pipeline-state', STEP, () =>
      this.env.DB.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status IN ('success','failure') THEN 1 ELSE 0 END) AS finished
           FROM ci_jobs WHERE repo_id = ?1 AND change_set_id = ?2 AND head_sha = ?3`,
      )
        .bind(event.payload.repoId, event.payload.changeId, event.payload.headSha)
        .first<{ total: number; finished: number }>(),
    );
    return { status: 'queued', treeSha: event.payload.treeSha, total: state?.total ?? 0, finished: state?.finished ?? 0 };
  }
}
