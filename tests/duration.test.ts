import { describe, it, expect } from 'vitest';
import {
  resolveBillableDuration, maxSupportedDuration, canProduceDuration,
} from '../src/budget/duration.js';
import { CapabilityError } from '../src/util/errors.js';
import type { VideoModelConfig } from '../src/config/loader.js';

const discrete = (durations: number[]): VideoModelConfig =>
  ({
    id: 'test_discrete', provider: 'T', name: 'T', qualityTier: 'standard',
    costCredits: null, supportsStartFrame: true, supportsEndFrame: true,
    supportsStartEndFrames: true, supportsNativeAudio: true, maxResolution: '1080p',
    aspectRatios: ['16:9'], fps: 24, enabled: true, useFor: [],
    durationMode: 'discrete', allowedDurations: durations,
  }) as VideoModelConfig;

const ranged = (min: number, max: number): VideoModelConfig =>
  ({
    id: 'test_range', provider: 'T', name: 'T', qualityTier: 'standard',
    costCredits: null, supportsStartFrame: true, supportsEndFrame: true,
    supportsStartEndFrames: true, supportsNativeAudio: true, maxResolution: '1080p',
    aspectRatios: ['16:9'], fps: 24, enabled: true, useFor: [],
    durationMode: 'range', durationRange: { min, max },
  }) as VideoModelConfig;

describe('discrete billable rounding', () => {
  it('rounds 3.2s up to the 5s billable unit', () => {
    // The worked example from architecture section 7.
    const r = resolveBillableDuration(discrete([5, 10]), 3.2);
    expect(r.billableSeconds).toBe(5);
    expect(r.wasteSeconds).toBeCloseTo(1.8, 5);
  });

  it('uses an exact match without rounding up', () => {
    expect(resolveBillableDuration(discrete([5, 10]), 5).billableSeconds).toBe(5);
  });

  it('never rounds down', () => {
    // Rounding 5.1 -> 5 would leave the edit short of footage it planned for.
    expect(resolveBillableDuration(discrete([5, 10]), 5.1).billableSeconds).toBe(10);
  });

  it('handles unsorted allowedDurations', () => {
    expect(resolveBillableDuration(discrete([12, 4, 8]), 5).billableSeconds).toBe(8);
  });

  it('matches Seedance 1.5 real durations', () => {
    const seedance = discrete([4, 8, 12]);
    expect(resolveBillableDuration(seedance, 3).billableSeconds).toBe(4);
    expect(resolveBillableDuration(seedance, 4.5).billableSeconds).toBe(8);
    expect(resolveBillableDuration(seedance, 9).billableSeconds).toBe(12);
  });

  it('throws when the shot exceeds the longest billable unit', () => {
    expect(() => resolveBillableDuration(discrete([5, 10]), 15)).toThrow(CapabilityError);
  });

  it('tolerates float noise at the boundary', () => {
    // 5.0000000001 must not silently escalate to a 10s charge.
    expect(resolveBillableDuration(discrete([5, 10]), 5.0000000001).billableSeconds).toBe(5);
  });
});

describe('range billable rounding', () => {
  it('bills the minimum for a shorter request', () => {
    const r = resolveBillableDuration(ranged(3, 15), 1.5);
    expect(r.billableSeconds).toBe(3);
    expect(r.wasteSeconds).toBeCloseTo(1.5, 5);
  });

  it('rounds up to whole seconds within range', () => {
    expect(resolveBillableDuration(ranged(3, 15), 7.2).billableSeconds).toBe(8);
  });

  it('bills an exact whole second as-is', () => {
    expect(resolveBillableDuration(ranged(3, 15), 8).billableSeconds).toBe(8);
    expect(resolveBillableDuration(ranged(3, 15), 8).wasteSeconds).toBe(0);
  });

  it('matches Kling 3.0 real range', () => {
    const kling = ranged(3, 15);
    expect(resolveBillableDuration(kling, 2).billableSeconds).toBe(3);
    expect(resolveBillableDuration(kling, 12.4).billableSeconds).toBe(13);
  });

  it('throws beyond the maximum', () => {
    expect(() => resolveBillableDuration(ranged(3, 15), 20)).toThrow(CapabilityError);
  });
});

describe('duration guards', () => {
  it('rejects zero and negative durations', () => {
    expect(() => resolveBillableDuration(discrete([5]), 0)).toThrow(CapabilityError);
    expect(() => resolveBillableDuration(discrete([5]), -3)).toThrow(CapabilityError);
  });

  it('rejects NaN', () => {
    expect(() => resolveBillableDuration(discrete([5]), NaN)).toThrow(CapabilityError);
  });

  it('reports maximum supported duration for both modes', () => {
    expect(maxSupportedDuration(discrete([4, 8, 12]))).toBe(12);
    expect(maxSupportedDuration(ranged(3, 15))).toBe(15);
  });

  it('answers capability questions without throwing', () => {
    expect(canProduceDuration(discrete([5, 10]), 8)).toBe(true);
    expect(canProduceDuration(discrete([5, 10]), 11)).toBe(false);
  });
});

describe('billable duration always covers the requirement', () => {
  it('holds across a wide sweep of requests', () => {
    const models = [discrete([5, 10]), discrete([4, 8, 12]), ranged(3, 15), ranged(4, 30)];
    for (const model of models) {
      for (let required = 0.1; required <= maxSupportedDuration(model); required += 0.1) {
        const r = resolveBillableDuration(model, required);
        // The core invariant of section 7.
        expect(r.billableSeconds).toBeGreaterThanOrEqual(required - 1e-6);
        expect(r.wasteSeconds).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
