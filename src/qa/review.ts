/**
 * Human retry decisions and the fallback path.
 * Architecture sections 16 and 17.
 *
 * v1 deliberately keeps a human in this loop. Vision QA flags; a person
 * decides ACCEPT / RETRY / FALLBACK, and the failure class is recorded so
 * that later videos can automate the decision from real data rather than
 * from guesswork.
 *
 * Like every gate, this writes state and exits - it never blocks on stdin.
 */

import { existsSync } from 'node:fs';
import { readState, updateState, setShotStatus } from '../state/store.js';
import { updateEntry, readManifest } from '../manifest/store.js';
import { loadQualityPolicy } from '../config/loader.js';
import { paths } from '../state/paths.js';
import { ValidationError } from '../util/errors.js';
import { log } from '../util/logger.js';
import type { EditPlan } from '../schemas/planning.js';

export type Decision = 'accept' | 'retry' | 'fallback';

export type ReviewRecord = {
  shotId: string;
  decision: Decision;
  failureClass?: string;
  note?: string;
  decidedAt: string;
};

/**
 * Record a decision for one shot.
 *
 * `retry` is recorded but never executed here - spending is the caller's
 * job, and only after the budget guard has authorised it.
 */
export function recordDecision(
  project: string,
  shotId: string,
  decision: Decision,
  opts: { failureClass?: string; note?: string } = {},
): ReviewRecord {
  const policy = loadQualityPolicy();

  if (decision !== 'accept' && opts.failureClass) {
    if (!policy.failureClasses.includes(opts.failureClass)) {
      throw new ValidationError(
        `Unknown failure class "${opts.failureClass}". ` +
          `Expected one of: ${policy.failureClasses.join(', ')}`,
        'quality-policy.json',
      );
    }
  }

  const status =
    decision === 'accept' ? 'accepted' : decision === 'fallback' ? 'fallback-still' : 'qa-flagged';

  setShotStatus(project, shotId, status, {
    ...(opts.failureClass !== undefined ? { failureClass: opts.failureClass } : {}),
  });

  // Mirror the decision onto the manifest entry, so the prompt library
  // (section 24) can later query which prompts actually produced good work.
  const entry = readManifest(project).entries.find(
    (e) => e.shotId === shotId && e.kind === 'video' && e.status === 'completed',
  );
  if (entry) {
    updateEntry(project, entry.assetHash, {
      accepted: decision === 'accept',
      ...(opts.note !== undefined ? { qualityNote: opts.note } : {}),
    });
  }

  const record: ReviewRecord = {
    shotId,
    decision,
    ...(opts.failureClass !== undefined ? { failureClass: opts.failureClass } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
    decidedAt: new Date().toISOString(),
  };

  log.info(`${shotId}: ${decision}${opts.failureClass ? ` (${opts.failureClass})` : ''}`);
  return record;
}

/** Shots still awaiting a decision. */
export function pendingReview(project: string): string[] {
  const state = readState(project);
  return Object.entries(state.shots)
    .filter(([, s]) => s.status === 'qa-flagged')
    .map(([id]) => id);
}

export function reviewSummary(project: string): {
  accepted: string[];
  flagged: string[];
  fallback: string[];
  failed: string[];
} {
  const state = readState(project);
  const by = (want: string) =>
    Object.entries(state.shots)
      .filter(([, s]) => s.status === want)
      .map(([id]) => id);

  return {
    accepted: by('accepted'),
    flagged: by('qa-flagged'),
    fallback: by('fallback-still'),
    failed: by('failed'),
  };
}

/**
 * Rewrite the edit plan so fallback shots become animated stills.
 * Architecture section 17.
 *
 * The point is that one difficult shot must not block the whole project -
 * but the result still has to survive motion lint #2, which is why that
 * lint exists.
 */
export function applyFallbacks(plan: EditPlan, fallbackShotIds: string[]): EditPlan {
  const fallbacks = new Set(fallbackShotIds);
  return {
    ...plan,
    items: plan.items.map((item) =>
      fallbacks.has(item.shotId)
        ? {
            ...item,
            isStill: true,
            motionSeconds: 0,
            // A gentle push keeps a still from reading as a freeze frame,
            // though the lint correctly refuses to count it as real motion.
            kenBurns: { enabled: true, startScale: 1.0, endScale: 1.12 },
          }
        : item,
    ),
  };
}

/** A fallback needs a still to animate; prefer the shot's own start frame. */
export function fallbackSourceFor(project: string, shotId: string): string | null {
  const p = paths(project);
  for (const candidate of [
    p.shotFile(shotId, 'start.png'),
    p.shotFile(shotId, 'end_target.png'),
    p.shotFile(shotId, 'qa-frames/frame_01.jpg'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Mark the review gate settled once nothing is left pending. */
export function completeReview(project: string): void {
  const pending = pendingReview(project);
  if (pending.length > 0) {
    throw new ValidationError(
      `${pending.length} shot(s) still awaiting a decision: ${pending.join(', ')}`,
      'review',
    );
  }
  updateState(project, (s) => ({
    ...s,
    gates: {
      ...s.gates,
      review: { status: 'approved', decidedAt: new Date().toISOString(), decidedBy: 'human' },
    },
  }));
}
