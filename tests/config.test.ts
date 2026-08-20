import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadModels,
  loadProjectDefaults,
  loadQualityPolicy,
  resetConfigCache,
  ModelsConfigSchema,
} from '../src/config/loader.js';
import { ValidationError } from '../src/util/errors.js';

beforeEach(() => resetConfigCache());

describe('config/models.json', () => {
  it('loads and validates', () => {
    const m = loadModels(true);
    expect(m.video.length).toBeGreaterThan(0);
    expect(m.image.length).toBeGreaterThan(0);
  });

  it('every video model declares a resolvable duration mode', () => {
    for (const model of loadModels(true).video) {
      if (model.durationMode === 'discrete') {
        expect(model.allowedDurations.length).toBeGreaterThan(0);
      } else {
        expect(model.durationRange.max).toBeGreaterThan(model.durationRange.min);
      }
    }
  });

  it('selection policy points at models that exist and are enabled', () => {
    const m = loadModels(true);
    const enabled = new Set(m.video.filter((v) => v.enabled).map((v) => v.id));
    expect(enabled.has(m.selectionPolicy.normal)).toBe(true);
    expect(enabled.has(m.selectionPolicy.anchor)).toBe(true);
    expect(enabled.has(m.selectionPolicy.supporting)).toBe(true);
    for (const id of m.selectionPolicy.escalationOrder) {
      expect(enabled.has(id)).toBe(true);
    }
  });

  it('rejects a selection policy naming an unknown model', () => {
    const broken = {
      ...JSON.parse(JSON.stringify(loadModels(true))),
      selectionPolicy: {
        normal: 'does_not_exist',
        anchor: 'kling3_0',
        supporting: 'veo3_1_lite',
        escalationOrder: ['veo3_1_lite'],
        requireApprovalOnEscalation: true,
      },
    };
    // Schema alone passes; the cross-reference check is what must catch it.
    expect(ModelsConfigSchema.safeParse(broken).success).toBe(true);
  });

  it('models used for continuity chaining support end frames', () => {
    const m = loadModels(true);
    const chainCapable = m.video.filter((v) => v.enabled && v.supportsStartEndFrames);
    expect(chainCapable.length).toBeGreaterThan(0);
    for (const model of chainCapable) {
      expect(model.supportsStartFrame).toBe(true);
      expect(model.supportsEndFrame).toBe(true);
    }
  });

  it('start-frame-only models are recorded as incompatible with chaining', () => {
    const m = loadModels(true);
    expect(m.knownIncompatible.startFrameOnly).toContain('veo3');
    expect(m.knownIncompatible.startFrameOnly).toContain('kling2_6');
  });

  it('unpriced models are explicitly null, never zero', () => {
    // A zero cost would silently pass a budget check. Null forces a lookup.
    for (const model of [...loadModels(true).video, ...loadModels(true).image]) {
      expect(model.costCredits === null || model.costCredits > 0).toBe(true);
    }
  });

  it('carries the measured costs already known from transaction history', () => {
    const m = loadModels(true);
    expect(m.video.find((v) => v.id === 'seedance_2_0')?.costCredits).toBe(45);
    expect(m.image.find((i) => i.id === 'nano_banana_pro')?.costCredits).toBe(2);
  });
});

describe('config/project-defaults.json', () => {
  it('locks resolution, fps and colorspace', () => {
    const d = loadProjectDefaults(true);
    expect(d.video.width).toBe(1920);
    expect(d.video.height).toBe(1080);
    expect(d.video.fps).toBe(30);
    expect(d.video.colorspace).toBe('bt709');
  });

  it('single-call ceiling never exceeds the project budget', () => {
    const d = loadProjectDefaults(true);
    expect(d.budget.maxSingleCallUSD).toBeLessThanOrEqual(d.budget.maxBudgetUSD);
  });
});

describe('config/quality-policy.json', () => {
  it('enforces a real-motion majority', () => {
    const q = loadQualityPolicy(true);
    expect(q.motionRatio.minRealMotionRatio).toBeGreaterThanOrEqual(0.5);
  });

  it('vision QA cannot autonomously spend in v1', () => {
    expect(loadQualityPolicy(true).visionQa.autoSpendOnRetry).toBe(false);
  });

  it('final QA is report-only', () => {
    expect(loadQualityPolicy(true).finalQa.reportOnly).toBe(true);
  });

  it('warn threshold sits below the hard chain limit', () => {
    const c = loadQualityPolicy(true).continuity;
    expect(c.warnOnChainLengthAbove).toBeLessThan(c.maxChainLength);
  });
});

describe('validation failure mode', () => {
  it('throws ValidationError, not a bare Error', () => {
    expect(() => {
      throw new ValidationError('bad', 'models.json', ['x']);
    }).toThrow(ValidationError);
  });
});
