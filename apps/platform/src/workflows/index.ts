/**
 * Workflows (durable, retryable, multi-invocation):
 *  - SnapshotBuilder: materialize working-tree tars into R2 on push (M4)
 *  - CiPipeline: run pipeline steps via runner agents, report checks (M5)
 *  - MergeWorkflow: FF + three-way merges server-side (M5)
 *  - RepoImport: mirror an external HTTPS remote into Artifacts (M2)
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

export class SnapshotBuilder extends WorkflowEntrypoint<Env, { repoId: string; sha: string }> {
  async run(_event: WorkflowEvent<{ repoId: string; sha: string }>, _step: WorkflowStep) {
    // Implemented in M4.
    return { status: 'stub' };
  }
}

export class CiPipeline extends WorkflowEntrypoint<Env, { repoId: string; ref: string; sha: string }> {
  async run(_event: WorkflowEvent<{ repoId: string; ref: string; sha: string }>, _step: WorkflowStep) {
    // Implemented in M5.
    return { status: 'stub' };
  }
}

export class MergeWorkflow extends WorkflowEntrypoint<Env, { repoId: string; changeSetId: string }> {
  async run(_event: WorkflowEvent<{ repoId: string; changeSetId: string }>, _step: WorkflowStep) {
    // Implemented in M5.
    return { status: 'stub' };
  }
}

export class RepoImport extends WorkflowEntrypoint<Env, { repoId: string; sourceUrl: string }> {
  async run(_event: WorkflowEvent<{ repoId: string; sourceUrl: string }>, _step: WorkflowStep) {
    // Implemented in M2 (Artifacts import() is called synchronously at repo
    // creation; this workflow tracks readiness and mirrors metadata).
    return { status: 'stub' };
  }
}
