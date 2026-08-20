/**
 * Billable duration rounding. Architecture section 7.
 *
 * Never assume arbitrary durations. If the edit needs 3.2s and the model
 * bills in 5s units, we pay for 5s and trim. Rounding DOWN is forbidden:
 * it would leave the edit short of footage it already planned for.
 */

import type { VideoModelConfig } from '../config/loader.js';
import { CapabilityError } from '../util/errors.js';

/** Guards against float noise like 4.999999999 failing a >= 5 comparison. */
const EPSILON = 1e-6;

export type BillableResult = {
  requiredSeconds: number;
  billableSeconds: number;
  /** Footage paid for but not used in the edit. */
  wasteSeconds: number;
};

/**
 * Resolve what a model will actually bill for, given what the edit needs.
 *
 * Discrete models snap up to the next allowed value; range models clamp to
 * their minimum and otherwise bill the exact request.
 */
export function resolveBillableDuration(
  model: VideoModelConfig,
  requiredSeconds: number,
): BillableResult {
  if (!Number.isFinite(requiredSeconds) || requiredSeconds <= 0) {
    throw new CapabilityError(
      `Required duration must be a positive number, got ${requiredSeconds}`,
      model.id,
      'duration',
    );
  }

  const billableSeconds =
    model.durationMode === 'discrete'
      ? snapUpToAllowed(model, requiredSeconds)
      : clampToRange(model, requiredSeconds);

  return {
    requiredSeconds,
    billableSeconds,
    wasteSeconds: Math.max(0, billableSeconds - requiredSeconds),
  };
}

function snapUpToAllowed(model: VideoModelConfig, required: number): number {
  if (model.durationMode !== 'discrete') throw new Error('unreachable');

  const sorted = [...model.allowedDurations].sort((a, b) => a - b);
  const fit = sorted.find((d) => d >= required - EPSILON);

  if (fit === undefined) {
    const longest = sorted[sorted.length - 1]!;
    throw new CapabilityError(
      `Shot needs ${required}s but "${model.id}" bills at most ${longest}s ` +
        `(allowed: ${sorted.join(', ')}). Split the shot or choose another model.`,
      model.id,
      'duration',
    );
  }
  return fit;
}

function clampToRange(model: VideoModelConfig, required: number): number {
  if (model.durationMode !== 'range') throw new Error('unreachable');

  const { min, max } = model.durationRange;

  if (required > max + EPSILON) {
    throw new CapabilityError(
      `Shot needs ${required}s but "${model.id}" generates at most ${max}s. ` +
        `Split the shot or choose another model.`,
      model.id,
      'duration',
    );
  }

  // Below the minimum we still pay the minimum - that is the billable floor.
  if (required < min) return min;

  // Whole seconds: every range model observed exposes integer durations.
  return Math.ceil(required - EPSILON);
}

/** Longest shot a model can produce in one generation. */
export function maxSupportedDuration(model: VideoModelConfig): number {
  return model.durationMode === 'discrete'
    ? Math.max(...model.allowedDurations)
    : model.durationRange.max;
}

export function canProduceDuration(model: VideoModelConfig, seconds: number): boolean {
  return seconds <= maxSupportedDuration(model) + EPSILON;
}
