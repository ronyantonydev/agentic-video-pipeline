import { describe, it, expect } from 'vitest';
import {
  selectVideoModel, requirementsForShot, inferAnchorShots, isMoreExpensive,
} from '../src/budget/model-selection.js';
import { loadModels } from '../src/config/loader.js';
import { CapabilityError } from '../src/util/errors.js';
import type { Shot } from '../src/schemas/planning.js';

const cfg = loadModels(true);

const req = (over: Partial<Parameters<typeof selectVideoModel>[1]> = {}) => ({
  durationSeconds: 5,
  needsStartFrame: false,
  needsEndFrame: false,
  needsNativeAudio: false,
  aspectRatio: '16:9',
  ...over,
});

const shot = (importance: Shot['importance']) => ({ importance });

describe('model selection by importance', () => {
  it('uses the budget tier for supporting shots', () => {
    const s = selectVideoModel(shot('supporting'), req(), cfg);
    expect(s.model.id).toBe(cfg.selectionPolicy.supporting);
    expect(s.requiresApproval).toBe(false);
  });

  it('uses the standard tier for normal shots', () => {
    expect(selectVideoModel(shot('normal'), req(), cfg).model.id).toBe(cfg.selectionPolicy.normal);
  });

  it('uses the quality tier for anchor shots', () => {
    expect(selectVideoModel(shot('anchor'), req(), cfg).model.id).toBe(cfg.selectionPolicy.anchor);
  });
});

describe('capability-driven escalation', () => {
  it('escalates when the preferred model cannot reach the duration', () => {
    // veo3_1_lite tops out at 8s; a 14s shot must move to a range model.
    const s = selectVideoModel(shot('supporting'), req({ durationSeconds: 14 }), cfg);
    expect(s.model.id).not.toBe(cfg.selectionPolicy.supporting);
    expect(s.escalatedFrom).toBe(cfg.selectionPolicy.supporting);
  });

  it('requires approval when escalation raises cost', () => {
    const s = selectVideoModel(shot('supporting'), req({ durationSeconds: 14 }), cfg);
    expect(s.requiresApproval).toBe(true);
  });

  it('picks a model that supports start and end frames together', () => {
    const s = selectVideoModel(
      shot('normal'),
      req({ needsStartFrame: true, needsEndFrame: true }),
      cfg,
    );
    expect(s.model.supportsStartEndFrames).toBe(true);
  });

  it('throws when nothing can satisfy the requirements', () => {
    expect(() => selectVideoModel(shot('normal'), req({ durationSeconds: 999 }), cfg)).toThrow(
      CapabilityError,
    );
  });

  it('reports every rejected candidate in the failure message', () => {
    try {
      selectVideoModel(shot('normal'), req({ durationSeconds: 999 }), cfg);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/cannot generate 999s/);
    }
  });

  it('never selects a disabled model', () => {
    const s = selectVideoModel(shot('anchor'), req(), cfg);
    expect(s.model.enabled).toBe(true);
  });
});

describe('cost comparison for approval', () => {
  const cheap = cfg.video.find((m) => m.qualityTier === 'budget')!;
  const dear = cfg.video.find((m) => m.id === 'seedance_2_0')!;

  it('compares measured prices when both are known', () => {
    const a = { ...cheap, costCredits: 20 };
    const b = { ...dear, costCredits: 45 };
    expect(isMoreExpensive(a, b)).toBe(true);
    expect(isMoreExpensive(b, a)).toBe(false);
  });

  it('falls back to tier ranking when a price is unknown', () => {
    expect(isMoreExpensive({ ...cheap, costCredits: null }, { ...dear, costCredits: null })).toBe(true);
  });

  it('treats an unknown current model as needing approval', () => {
    // Conservative: if we cannot compare, ask.
    expect(isMoreExpensive(undefined, dear)).toBe(true);
  });
});

describe('shot requirements', () => {
  const base: Shot = {
    id: 'shot_001', index: 0, intent: 'digging',
    importance: 'normal', continuityMode: 'independent',
  };

  it('requires a start frame only for previous-shot continuity', () => {
    expect(requirementsForShot(base, 5, '16:9').needsStartFrame).toBe(false);
    expect(
      requirementsForShot({ ...base, continuityMode: 'previous-shot', previousShot: 'shot_001' }, 5, '16:9')
        .needsStartFrame,
    ).toBe(true);
  });

  it('does not require a start frame for reference-only shots', () => {
    // reference-only shots share look but not the exact prior frame, so they
    // can still run in parallel (section 12).
    expect(requirementsForShot({ ...base, continuityMode: 'reference-only' }, 5, '16:9').needsStartFrame).toBe(false);
  });

  it('requires an end frame for anchor shots', () => {
    expect(requirementsForShot({ ...base, importance: 'anchor' }, 5, '16:9').needsEndFrame).toBe(true);
  });
});

describe('anchor inference', () => {
  it('returns 2-4 anchors for a typical video', () => {
    for (const count of [8, 12, 15, 20]) {
      const anchors = inferAnchorShots(count);
      expect(anchors.length).toBeGreaterThanOrEqual(2);
      expect(anchors.length).toBeLessThanOrEqual(4);
    }
  });

  it('always anchors the opening and closing shots', () => {
    const anchors = inferAnchorShots(12);
    expect(anchors).toContain(0);
    expect(anchors).toContain(11);
  });

  it('handles degenerate counts', () => {
    expect(inferAnchorShots(0)).toEqual([]);
    expect(inferAnchorShots(1)).toEqual([0]);
    expect(inferAnchorShots(3)).toEqual([0]);
  });

  it('returns sorted, unique indexes', () => {
    const anchors = inferAnchorShots(15);
    expect([...anchors].sort((a, b) => a - b)).toEqual(anchors);
    expect(new Set(anchors).size).toBe(anchors.length);
  });
});
