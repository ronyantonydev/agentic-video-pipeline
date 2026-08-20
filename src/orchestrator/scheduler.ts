/**
 * Concurrency-capped scheduler. Architecture sections 12, 13, 14.
 *
 * Independent and reference-only shots run in parallel up to a cap.
 * previous-shot chains run strictly serially, and a chain stops the moment
 * a link fails - a bad shot_04 must never cause paid generation of shot_05.
 */

import { log } from '../util/logger.js';

export type TaskResult<T> =
  | { shotId: string; status: 'fulfilled'; value: T }
  | { shotId: string; status: 'rejected'; reason: Error }
  | { shotId: string; status: 'skipped'; reason: string };

export type ScheduleOptions = {
  maxConcurrency: number;
  /** Abort the whole run - used when the budget guard hard-stops. */
  signal?: { aborted: boolean };
};

/**
 * Run tasks concurrently, capped.
 *
 * Individual failures do not abort the batch: each shot is independent, and
 * one bad generation should not discard the others already paid for.
 */
export async function runParallel<T>(
  shotIds: string[],
  task: (shotId: string) => Promise<T>,
  opts: ScheduleOptions,
): Promise<TaskResult<T>[]> {
  const results: TaskResult<T>[] = [];
  const queue = [...shotIds];
  const cap = Math.max(1, opts.maxConcurrency);

  async function worker(): Promise<void> {
    for (;;) {
      const shotId = queue.shift();
      if (shotId === undefined) return;

      if (opts.signal?.aborted) {
        results.push({ shotId, status: 'skipped', reason: 'run aborted' });
        continue;
      }

      try {
        results.push({ shotId, status: 'fulfilled', value: await task(shotId) });
      } catch (err) {
        log.warn(`${shotId} failed: ${(err as Error).message}`);
        results.push({ shotId, status: 'rejected', reason: err as Error });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(cap, queue.length) }, worker));

  // Restore input order; workers finish out of order.
  const order = new Map(shotIds.map((id, i) => [id, i]));
  return results.sort((a, b) => (order.get(a.shotId) ?? 0) - (order.get(b.shotId) ?? 0));
}

/**
 * Run a continuity chain serially, stopping at the first failure.
 *
 * Architecture section 13: a shot whose predecessor failed cannot be
 * generated, because its start frame does not exist. Continuing would spend
 * money on an input that is missing.
 */
export async function runChain<T>(
  shotIds: string[],
  task: (shotId: string, previous: T | null) => Promise<T>,
  opts: ScheduleOptions,
): Promise<TaskResult<T>[]> {
  const results: TaskResult<T>[] = [];
  let previous: T | null = null;
  let broken = false;
  let brokenBy = '';

  for (const shotId of shotIds) {
    if (broken) {
      results.push({
        shotId,
        status: 'skipped',
        reason: `depends on ${brokenBy}, which did not succeed`,
      });
      continue;
    }
    if (opts.signal?.aborted) {
      results.push({ shotId, status: 'skipped', reason: 'run aborted' });
      broken = true;
      brokenBy = shotId;
      continue;
    }

    try {
      previous = await task(shotId, previous);
      results.push({ shotId, status: 'fulfilled', value: previous });
    } catch (err) {
      log.warn(`Chain broken at ${shotId}: ${(err as Error).message}`);
      results.push({ shotId, status: 'rejected', reason: err as Error });
      broken = true;
      brokenBy = shotId;
    }
  }

  return results;
}

/**
 * Execute a full plan: the parallel batch first, then each chain.
 *
 * Chains run after the batch so that a hard stop during the cheap parallel
 * work does not leave a half-finished chain.
 */
export async function runExecutionPlan<T>(
  plan: { parallelBatch: string[]; serialChains: string[][] },
  tasks: {
    parallel: (shotId: string) => Promise<T>;
    chained: (shotId: string, previous: T | null) => Promise<T>;
  },
  opts: ScheduleOptions,
): Promise<TaskResult<T>[]> {
  const results: TaskResult<T>[] = [];

  if (plan.parallelBatch.length > 0) {
    log.info(
      `Running ${plan.parallelBatch.length} independent shot(s), ` +
        `up to ${opts.maxConcurrency} at a time`,
    );
    results.push(...(await runParallel(plan.parallelBatch, tasks.parallel, opts)));
  }

  for (const [i, chain] of plan.serialChains.entries()) {
    log.info(`Running chain ${i + 1}/${plan.serialChains.length} (${chain.length} shots, serial)`);
    results.push(...(await runChain(chain, tasks.chained, opts)));
  }

  return results;
}

export function summarize<T>(results: TaskResult<T>[]): {
  fulfilled: number;
  rejected: number;
  skipped: number;
} {
  return {
    fulfilled: results.filter((r) => r.status === 'fulfilled').length,
    rejected: results.filter((r) => r.status === 'rejected').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  };
}
