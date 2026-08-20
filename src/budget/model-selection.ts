/**
 * Model selection. Architecture sections 8 and 9.
 *
 * Deliberately simple for v1:
 *   normal/simple shot   -> cheaper model
 *   anchor/difficult     -> quality model
 *   capability failure   -> escalate
 *
 * The escalation rule that matters: switching to a model that costs MORE
 * requires human approval. Auto-switching is only allowed when it is free
 * or cheaper.
 */

import { loadModels, type ModelsConfig, type VideoModelConfig } from '../config/loader.js';
import { CapabilityError } from '../util/errors.js';
import { canProduceDuration } from './duration.js';
import type { Shot } from '../schemas/planning.js';

export type Requirements = {
  durationSeconds: number;
  needsStartFrame: boolean;
  needsEndFrame: boolean;
  needsNativeAudio: boolean;
  aspectRatio: string;
};

export type Selection = {
  model: VideoModelConfig;
  reason: string;
  /** Set when the first choice could not satisfy the requirements. */
  escalatedFrom?: string;
  /** True when the switch increases cost and therefore needs approval. */
  requiresApproval: boolean;
};

/** Derive requirements from a shot's continuity mode and importance. */
export function requirementsForShot(
  shot: Shot,
  durationSeconds: number,
  aspectRatio: string,
  wantsNativeAudio = false,
): Requirements {
  // previous-shot chaining needs the actual end frame of the prior shot as
  // this shot's start frame (section 12).
  const needsStartFrame = shot.continuityMode === 'previous-shot';
  return {
    durationSeconds,
    needsStartFrame,
    needsEndFrame: shot.importance === 'anchor',
    needsNativeAudio: wantsNativeAudio,
    aspectRatio,
  };
}

function supports(model: VideoModelConfig, req: Requirements): string | null {
  if (!canProduceDuration(model, req.durationSeconds)) {
    return `cannot generate ${req.durationSeconds}s`;
  }
  if (req.needsStartFrame && !model.supportsStartFrame) return 'no start-frame support';
  if (req.needsEndFrame && !model.supportsEndFrame) return 'no end-frame support';
  if (req.needsStartFrame && req.needsEndFrame && !model.supportsStartEndFrames) {
    return 'cannot use start and end frames together';
  }
  if (req.needsNativeAudio && !model.supportsNativeAudio) return 'no native audio';
  if (
    model.aspectRatios.length > 0 &&
    !model.aspectRatios.includes(req.aspectRatio) &&
    !model.aspectRatios.includes('auto')
  ) {
    return `does not support ${req.aspectRatio}`;
  }
  return null;
}

const TIER_RANK: Record<VideoModelConfig['qualityTier'], number> = {
  budget: 0,
  standard: 1,
  quality: 2,
};

/**
 * Choose a video model for a shot, escalating through the configured order
 * when the preferred model cannot do the job.
 */
export function selectVideoModel(
  shot: Pick<Shot, 'importance'>,
  req: Requirements,
  cfg: ModelsConfig = loadModels(),
): Selection {
  const byId = new Map(cfg.video.filter((m) => m.enabled).map((m) => [m.id, m]));

  const preferredId =
    shot.importance === 'anchor'
      ? cfg.selectionPolicy.anchor
      : shot.importance === 'supporting'
        ? cfg.selectionPolicy.supporting
        : cfg.selectionPolicy.normal;

  const preferred = byId.get(preferredId);
  if (preferred) {
    const problem = supports(preferred, req);
    if (problem === null) {
      return {
        model: preferred,
        reason: `${shot.importance} shot -> ${preferred.qualityTier} tier`,
        requiresApproval: false,
      };
    }
  }

  // Escalate in configured order, taking the first model that can do the job.
  const failures: string[] = [];
  if (preferred) failures.push(`${preferred.id}: ${supports(preferred, req)}`);

  for (const candidateId of cfg.selectionPolicy.escalationOrder) {
    if (candidateId === preferredId) continue;
    const candidate = byId.get(candidateId);
    if (!candidate) continue;

    const problem = supports(candidate, req);
    if (problem !== null) {
      failures.push(`${candidateId}: ${problem}`);
      continue;
    }

    // Cost comparison drives the approval decision. Where a price is unknown
    // we assume a higher tier costs more - the conservative reading.
    const costsMore = isMoreExpensive(preferred, candidate);

    return {
      model: candidate,
      reason: `escalated: ${preferred?.id ?? preferredId} ${preferred ? `(${supports(preferred, req)})` : 'unavailable'}`,
      ...(preferred ? { escalatedFrom: preferred.id } : {}),
      requiresApproval: costsMore && cfg.selectionPolicy.requireApprovalOnEscalation,
    };
  }

  throw new CapabilityError(
    `No enabled model can satisfy this shot (${req.durationSeconds}s, ` +
      `start=${req.needsStartFrame}, end=${req.needsEndFrame}, ${req.aspectRatio}).\n  ` +
      failures.join('\n  '),
    preferredId,
    'selection',
  );
}

/**
 * True when `candidate` is expected to cost more than `current`.
 * Unknown prices fall back to tier ranking, which errs toward asking.
 */
export function isMoreExpensive(
  current: VideoModelConfig | undefined,
  candidate: VideoModelConfig,
): boolean {
  if (!current) return true;
  if (current.costCredits !== null && candidate.costCredits !== null) {
    return candidate.costCredits > current.costCredits;
  }
  return TIER_RANK[candidate.qualityTier] > TIER_RANK[current.qualityTier];
}

/**
 * Identify anchor shots - roughly 2-4 per video. Architecture section 9.
 *
 * Claude normally marks these during planning; this is the deterministic
 * fallback when it has not.
 */
export function inferAnchorShots(shotCount: number): number[] {
  if (shotCount <= 0) return [];
  if (shotCount <= 3) return [0];

  const anchors = new Set<number>([0, shotCount - 1]);
  if (shotCount >= 6) anchors.add(Math.floor(shotCount / 2));
  if (shotCount >= 10) anchors.add(Math.floor(shotCount * 0.75));

  return [...anchors].sort((a, b) => a - b);
}
