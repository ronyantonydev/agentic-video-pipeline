/**
 * Job polling with exponential backoff. Architecture section 14.
 *
 * A submitted job represents money already committed, so the poller must
 * never lose track of one: it reports a timeout rather than abandoning the
 * job, leaving the manifest entry recoverable on the next run.
 */

import { log } from '../util/logger.js';
import type { GenerationProvider, PollResult } from '../higgsfield/provider.js';

export type PollOptions = {
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  timeoutMs: number;
  /** Injected in tests so backoff logic runs without real waiting. */
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (result: PollResult) => void;
};

export class PollTimeout extends Error {
  constructor(
    readonly jobId: string,
    readonly elapsedMs: number,
  ) {
    super(
      `Job ${jobId} did not settle within ${Math.round(elapsedMs / 1000)}s. ` +
        `It may still be running - the manifest entry remains recoverable.`,
    );
    this.name = 'PollTimeout';
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll until the job reaches a terminal state.
 *
 * @throws PollTimeout when the deadline passes. The job is NOT cancelled -
 *         cancelling something already paid for would waste it.
 */
export async function pollUntilSettled(
  provider: GenerationProvider,
  jobId: string,
  opts: PollOptions,
): Promise<PollResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const started = Date.now();
  let delay = opts.initialDelayMs;
  let attempts = 0;

  for (;;) {
    const result = await provider.poll(jobId);
    attempts += 1;
    opts.onProgress?.(result);

    if (isTerminal(result.status)) {
      log.debug(`Job ${jobId} settled as ${result.status} after ${attempts} poll(s)`);
      return result;
    }

    const elapsed = Date.now() - started;
    if (elapsed >= opts.timeoutMs) throw new PollTimeout(jobId, elapsed);

    // Never sleep past the deadline - that would overshoot the timeout.
    await sleep(Math.min(delay, opts.timeoutMs - elapsed));
    delay = Math.min(delay * opts.backoffFactor, opts.maxDelayMs);
  }
}

export function isTerminal(status: PollResult['status']): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'nsfw'
  );
}

/** Statuses Higgsfield does not charge for. */
export function isChargeableOutcome(status: PollResult['status']): boolean {
  return status === 'completed';
}
