/**
 * The paid-generation sequence. This is the only place money is spent.
 *
 * The order is fixed and must not be rearranged:
 *
 *   resolveCost -> authorizeSpend -> appendEntry -> submit -> poll
 *               -> download -> settleSpend / releaseReservation
 *
 * appendEntry before submit is what makes a crash recoverable (section 23).
 * authorizeSpend before appendEntry is what enforces the budget (section 19).
 */

import { existsSync } from 'node:fs';
import { resolveCost, recordLearnedCost, creditsToUsd } from '../budget/cost.js';
import { authorizeSpend, settleSpend, releaseReservation } from '../budget/guard.js';
import {
  appendEntry, updateEntry, findReusable, computeAssetHash, hashFile,
} from '../manifest/store.js';
import { setShotStatus } from '../state/store.js';
import { paths } from '../state/paths.js';
import { pollUntilSettled, isChargeableOutcome, PollTimeout } from './poller.js';
import { log } from '../util/logger.js';
import { HardStop } from '../util/errors.js';
import type { GenerationProvider } from '../higgsfield/provider.js';
import type { GenerationItem } from '../schemas/planning.js';
import type { ManifestEntry } from '../schemas/state.js';

export type GenerateOptions = {
  maxSingleCallUSD: number;
  stopOnCreditsBelow?: number;
  poll: {
    initialDelayMs: number;
    maxDelayMs: number;
    backoffFactor: number;
    timeoutMs: number;
    sleep?: (ms: number) => Promise<void>;
  };
};

export type GenerateResult = {
  shotId: string;
  assetHash: string;
  localFile: string;
  reused: boolean;
  creditsCharged: number;
  usdCharged: number;
};

/**
 * Generate one shot.
 *
 * @throws HardStop when the budget refuses the call - never caught here.
 */
export async function generateShot(
  project: string,
  item: GenerationItem,
  provider: GenerationProvider,
  opts: GenerateOptions,
  frames: { startImage?: string; endImage?: string } = {},
): Promise<GenerateResult> {
  const p = paths(project);

  // Frame contents participate in identity: a changed start frame is a
  // different asset, and reusing the old one would be wrong.
  const startFrameHash =
    frames.startImage && existsSync(frames.startImage) ? hashFile(frames.startImage) : undefined;
  const endFrameHash =
    frames.endImage && existsSync(frames.endImage) ? hashFile(frames.endImage) : undefined;

  const assetHash = computeAssetHash({
    kind: 'video',
    model: item.modelId,
    prompt: item.prompt,
    duration: item.billableSeconds,
    ...(startFrameHash !== undefined ? { startFrameHash } : {}),
    ...(endFrameHash !== undefined ? { endFrameHash } : {}),
    ...(item.seed !== undefined ? { seed: item.seed } : {}),
    settings: item.settings,
  });

  // 0. Never pay twice for an identical asset (section 22).
  const reusable = findReusable(project, assetHash);
  if (reusable) {
    log.info(`${item.shotId}: reusing paid asset ${assetHash}`);
    setShotStatus(project, item.shotId, 'downloaded');
    return {
      shotId: item.shotId,
      assetHash,
      localFile: reusable.localFile!,
      reused: true,
      creditsCharged: 0,
      usdCharged: 0,
    };
  }

  // 1. Establish the price. Throws UnknownCostError rather than guessing.
  const cost = await resolveCost(project, {
    modelId: item.modelId,
    kind: 'video',
    prompt: item.prompt,
    durationSeconds: item.billableSeconds,
    aspectRatio: item.aspectRatio,
    ...(item.resolution !== undefined ? { resolution: item.resolution } : {}),
    settings: item.settings,
  });

  // 2. Budget gate. HardStop propagates - it is never caught in this file.
  const auth = authorizeSpend(project, cost, {
    maxSingleCallUSD: opts.maxSingleCallUSD,
    ...(opts.stopOnCreditsBelow !== undefined
      ? { stopOnCreditsBelow: opts.stopOnCreditsBelow }
      : {}),
    description: `${item.shotId} (${item.modelId}, ${item.billableSeconds}s)`,
  });

  // 3. Record BEFORE submitting, so a crash leaves a recoverable entry.
  const entry: ManifestEntry = {
    assetHash,
    shotId: item.shotId,
    kind: 'video',
    provider: provider.name,
    model: item.modelId,
    prompt: item.prompt,
    settings: item.settings,
    submittedAt: new Date().toISOString(),
    estimatedCredits: cost.credits,
    estimatedUSD: cost.usd,
    actualCredits: null,
    actualUSD: null,
    status: 'submitted',
    accepted: null,
    billableDuration: item.billableSeconds,
    ...(item.seed !== undefined ? { seed: item.seed } : {}),
  };
  appendEntry(project, entry);
  setShotStatus(project, item.shotId, 'submitted', {
    attempts: 1,
  });

  // 4. Submit.
  let jobId: string;
  try {
    const submitted = await provider.submitVideo({
      modelSlug: item.modelId,
      prompt: item.prompt,
      ...(item.negativePrompt !== undefined ? { negativePrompt: item.negativePrompt } : {}),
      durationSeconds: item.billableSeconds,
      aspectRatio: item.aspectRatio,
      ...(item.resolution !== undefined ? { resolution: item.resolution } : {}),
      ...(frames.startImage !== undefined ? { startImage: frames.startImage } : {}),
      ...(frames.endImage !== undefined ? { endImage: frames.endImage } : {}),
      ...(item.seed !== undefined ? { seed: item.seed } : {}),
      nativeAudio: item.nativeAudio,
      settings: item.settings,
    });
    jobId = submitted.jobId;
    updateEntry(project, assetHash, { jobId, status: 'polling' });
  } catch (err) {
    // Submission never happened, so nothing was charged.
    releaseReservation(project, auth);
    updateEntry(project, assetHash, { status: 'failed' });
    setShotStatus(project, item.shotId, 'failed', { lastError: (err as Error).message });
    throw err;
  }

  // 5. Poll to a terminal state.
  let settled;
  try {
    settled = await pollUntilSettled(provider, jobId, opts.poll);
  } catch (err) {
    if (err instanceof PollTimeout) {
      // Deliberately leave the entry as 'polling': the job may still be
      // running and already paid for. A later run recovers it.
      releaseReservation(project, auth);
      setShotStatus(project, item.shotId, 'submitted', { lastError: err.message });
    } else {
      releaseReservation(project, auth);
      updateEntry(project, assetHash, { status: 'failed' });
      setShotStatus(project, item.shotId, 'failed', { lastError: (err as Error).message });
    }
    throw err;
  }

  // 6. Failures are not charged, so release rather than settle.
  if (!isChargeableOutcome(settled.status)) {
    releaseReservation(project, auth);
    updateEntry(project, assetHash, {
      status: settled.status === 'cancelled' ? 'cancelled' : 'failed',
      actualCredits: 0,
      actualUSD: 0,
    });
    setShotStatus(project, item.shotId, 'failed', {
      lastError: settled.error ?? settled.status,
      failureClass: 'bad-random-generation',
    });
    throw new Error(`${item.shotId} generation ${settled.status}: ${settled.error ?? ''}`);
  }

  // 7. Download.
  const localFile = p.shotFile(item.shotId, 'original.mp4');
  await provider.download(settled.resultUrl!, localFile);

  // 8. Settle.
  //
  // Convert reported credits through the configured rate rather than scaling
  // the estimate by an actual/estimated ratio: the provider's credit figure
  // and our estimate are independent quantities, and treating one as a
  // proportion of the other silently understates spend when they disagree.
  //
  // A provider that reports no credit figure settles at the estimate, which
  // is the conservative choice - never settle for less than authorized
  // without positive evidence of a smaller charge.
  const reported = settled.actualCredits;
  const hasReportedCredits =
    provider.isPaid && reported !== null && reported !== undefined && reported > 0;

  const actualCredits = hasReportedCredits ? reported : cost.credits;
  const actualUSD = hasReportedCredits ? creditsToUsd(reported) : cost.usd;

  settleSpend(project, auth, { usd: actualUSD, credits: actualCredits });
  updateEntry(project, assetHash, {
    status: 'completed',
    completedAt: new Date().toISOString(),
    actualCredits,
    actualUSD: round2(actualUSD),
    localFile,
  });
  setShotStatus(project, item.shotId, 'downloaded');

  // 9. Learn the measured price for next time.
  if (provider.isPaid && settled.actualCredits != null) {
    recordLearnedCost(
      project,
      {
        modelId: item.modelId,
        kind: 'video',
        durationSeconds: item.billableSeconds,
        aspectRatio: item.aspectRatio,
        ...(item.resolution !== undefined ? { resolution: item.resolution } : {}),
        settings: item.settings,
      },
      actualCredits,
      round2(actualUSD),
      'measured from provider-reported charge',
    );
  }

  return {
    shotId: item.shotId,
    assetHash,
    localFile,
    reused: false,
    creditsCharged: actualCredits,
    usdCharged: round2(actualUSD),
  };
}

/**
 * Re-attach to jobs left mid-flight by a crash. Architecture section 23.
 *
 * These represent money already committed, so they are polled to completion
 * rather than resubmitted.
 */
export async function recoverInFlight(
  project: string,
  entries: ManifestEntry[],
  provider: GenerationProvider,
  opts: GenerateOptions,
): Promise<{ recovered: number; failed: number }> {
  let recovered = 0;
  let failed = 0;

  for (const entry of entries) {
    if (!entry.jobId) {
      // Submitted but no job id recorded: the crash landed between the
      // manifest write and the provider response. Nothing to poll.
      updateEntry(project, entry.assetHash, { status: 'failed' });
      failed += 1;
      continue;
    }

    try {
      const settled = await pollUntilSettled(provider, entry.jobId, opts.poll);
      if (isChargeableOutcome(settled.status) && settled.resultUrl && entry.shotId) {
        const localFile = paths(project).shotFile(entry.shotId, 'original.mp4');
        await provider.download(settled.resultUrl, localFile);
        updateEntry(project, entry.assetHash, {
          status: 'completed',
          completedAt: new Date().toISOString(),
          actualCredits: settled.actualCredits ?? entry.estimatedCredits,
          localFile,
        });
        setShotStatus(project, entry.shotId, 'downloaded');
        recovered += 1;
        log.info(`Recovered ${entry.shotId} from job ${entry.jobId}`);
      } else {
        updateEntry(project, entry.assetHash, { status: 'failed', actualCredits: 0, actualUSD: 0 });
        failed += 1;
      }
    } catch (err) {
      if (err instanceof HardStop) throw err;
      log.warn(`Could not recover job ${entry.jobId}: ${(err as Error).message}`);
      failed += 1;
    }
  }

  return { recovered, failed };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
