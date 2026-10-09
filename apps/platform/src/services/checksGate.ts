/**
 * The checks-gate (architecture §0.3, invariant 5): the only place merge,
 * queue and composition code learns which checks a tree must pass.
 *
 * Producers (guard, CI) register a factory in CHECKS_PRODUCERS and answer
 * for the exact tree and config identity being published. With none
 * registered the required set is empty and its state is `success`, so a
 * merge is gated by mergeability alone. Producers return only checks that
 * are required; non-required and quarantined runs never reach the gate.
 */

export type CheckState = 'success' | 'pending' | 'failure';

export interface RequiredCheck {
  name: string;
  state: CheckState;
  /** The producer that declared the check. */
  producer: string;
  /** Producer-specific run id, for links and evidence. */
  runId?: string;
}

export interface RequiredChecks {
  treeSha: string;
  configId: string | null;
  required: RequiredCheck[];
  /** `failure` if any required check failed, else `pending` if any is unfinished, else `success`. */
  state: CheckState;
}

export interface ChecksRepo {
  id: string;
}

export interface ChecksProducer {
  readonly name: string;
  requiredChecksFor(repo: ChecksRepo, treeSha: string, configId: string | null): Promise<Array<Omit<RequiredCheck, 'producer'>>>;
}

export interface ChecksGate {
  requiredChecksFor(repo: ChecksRepo, treeSha: string, configId: string | null): Promise<RequiredChecks>;
}

export type ChecksProducerFactory = (env: Env) => ChecksProducer;

/** Registered producers; empty until guard/CI land. */
export const CHECKS_PRODUCERS: readonly ChecksProducerFactory[] = [];

export function rollupState(checks: readonly { state: CheckState }[]): CheckState {
  if (checks.some((c) => c.state === 'failure')) return 'failure';
  if (checks.some((c) => c.state === 'pending')) return 'pending';
  return 'success';
}

export function checksGate(producers: readonly ChecksProducer[]): ChecksGate {
  return {
    async requiredChecksFor(repo, treeSha, configId) {
      const lists = await Promise.all(
        producers.map(async (p) => (await p.requiredChecksFor(repo, treeSha, configId)).map((c) => ({ ...c, producer: p.name }))),
      );
      const required = lists.flat();
      return { treeSha, configId, required, state: rollupState(required) };
    },
  };
}

/** The gate over every registered producer. */
export function defaultChecksGate(env: Env): ChecksGate {
  return checksGate(CHECKS_PRODUCERS.map((make) => make(env)));
}
