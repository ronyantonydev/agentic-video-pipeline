import { describe, it, expect } from 'vitest';
import { buildContinuityGraph, assertExecutableGraph, executionPlan } from '../src/planning/continuity-graph.js';
import { lintMotionRatio, lintAfterFallbacks } from '../src/planning/motion-lint.js';
import { loadQualityPolicy } from '../src/config/loader.js';
import { ValidationError } from '../src/util/errors.js';
import type { Shot, Shotlist, EditPlan } from '../src/schemas/planning.js';

const policy = loadQualityPolicy(true);
const CHAIN_OPTS = policy.continuity;

const shot = (i: number, over: Partial<Shot> = {}): Shot => ({
  id: `shot_${String(i + 1).padStart(3, '0')}`,
  index: i,
  intent: 'x',
  importance: 'normal',
  continuityMode: 'independent',
  ...over,
});

const list = (shots: Shot[]): Shotlist => ({ shots });

describe('continuity graph - errors', () => {
  it('accepts an all-independent shotlist', () => {
    const g = buildContinuityGraph(list([shot(0), shot(1), shot(2)]), CHAIN_OPTS);
    expect(g.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(g.parallelizable).toHaveLength(3);
  });

  it('rejects a dangling previousShot reference', () => {
    const g = buildContinuityGraph(
      list([shot(0), shot(1, { continuityMode: 'previous-shot', previousShot: 'shot_099' })]),
      CHAIN_OPTS,
    );
    expect(g.issues.some((i) => i.severity === 'error' && /does not exist/.test(i.message))).toBe(true);
    expect(() => assertExecutableGraph(g)).toThrow(ValidationError);
  });

  it('rejects a self-reference', () => {
    const g = buildContinuityGraph(
      list([shot(0, { continuityMode: 'previous-shot', previousShot: 'shot_001' })]),
      CHAIN_OPTS,
    );
    expect(g.issues.some((i) => /depends on itself/.test(i.message))).toBe(true);
  });

  it('detects a cycle', () => {
    // shot_001 -> shot_002 -> shot_001 would deadlock: neither can start.
    const g = buildContinuityGraph(
      list([
        shot(0, { continuityMode: 'previous-shot', previousShot: 'shot_002' }),
        shot(1, { continuityMode: 'previous-shot', previousShot: 'shot_001' }),
      ]),
      CHAIN_OPTS,
    );
    expect(g.issues.some((i) => /cycle/.test(i.message))).toBe(true);
    expect(() => assertExecutableGraph(g)).toThrow(ValidationError);
  });

  it('rejects a dependency that comes later in the timeline', () => {
    const g = buildContinuityGraph(
      list([shot(0, { continuityMode: 'previous-shot', previousShot: 'shot_002' }), shot(1)]),
      CHAIN_OPTS,
    );
    expect(g.issues.some((i) => /cannot follow its dependant/.test(i.message))).toBe(true);
  });
});

describe('continuity graph - chains', () => {
  const chained = list([
    shot(0),
    shot(1, { continuityMode: 'previous-shot', previousShot: 'shot_001' }),
    shot(2, { continuityMode: 'previous-shot', previousShot: 'shot_002' }),
    shot(3),
  ]);

  it('groups dependent shots into an ordered chain', () => {
    const g = buildContinuityGraph(chained, CHAIN_OPTS);
    expect(g.chains).toHaveLength(1);
    expect(g.chains[0]!.map((s) => s.id)).toEqual(['shot_001', 'shot_002', 'shot_003']);
  });

  it('leaves unchained shots parallelizable', () => {
    const g = buildContinuityGraph(chained, CHAIN_OPTS);
    expect(g.parallelizable.map((s) => s.id)).toEqual(['shot_004']);
  });

  it('treats reference-only as parallelizable', () => {
    // reference-only shares look but not the exact prior frame (section 12).
    const g = buildContinuityGraph(
      list([shot(0), shot(1, { continuityMode: 'reference-only' })]),
      CHAIN_OPTS,
    );
    expect(g.parallelizable).toHaveLength(2);
    expect(g.chains).toHaveLength(0);
  });

  it('warns but does not fail on a long chain', () => {
    const long = list([
      shot(0),
      ...Array.from({ length: 6 }, (_, i) =>
        shot(i + 1, {
          continuityMode: 'previous-shot',
          previousShot: `shot_${String(i + 1).padStart(3, '0')}`,
        }),
      ),
    ]);
    const g = buildContinuityGraph(long, CHAIN_OPTS);
    expect(g.longestChain).toBe(7);
    expect(g.issues.some((i) => i.severity === 'warning' && /drift/.test(i.message))).toBe(true);
    // Drift is a quality risk, not a correctness failure (section 13).
    expect(() => assertExecutableGraph(g)).not.toThrow();
  });

  it('produces an execution plan separating parallel from serial work', () => {
    const plan = executionPlan(buildContinuityGraph(chained, CHAIN_OPTS));
    expect(plan.parallelBatch).toEqual(['shot_004']);
    expect(plan.serialChains).toEqual([['shot_001', 'shot_002', 'shot_003']]);
  });
});

/* ------------------------------------------------------------- motion lint */

const item = (id: string, over: Partial<EditPlan['items'][number]> = {}) => ({
  shotId: id,
  startSeconds: 0,
  screenDurationSeconds: 6,
  motionSeconds: 5,
  speedFactor: 1,
  transitionIn: 'cut',
  transitionOut: 'cut',
  isStill: false,
  ...over,
});

const plan = (items: EditPlan['items']): EditPlan => ({
  totalDurationSeconds: items.reduce((s, i) => s + i.screenDurationSeconds, 0),
  items,
  music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
  captions: [],
});

describe('motion lint', () => {
  it('passes a motion-dominant plan', () => {
    const r = lintMotionRatio(plan([item('shot_001'), item('shot_002'), item('shot_003')]), policy);
    expect(r.pass).toBe(true);
    expect(r.motionRatio).toBeGreaterThan(0.55);
  });

  it('fails when stills dominate', () => {
    const r = lintMotionRatio(
      plan([
        item('shot_001'),
        item('shot_002', { isStill: true, motionSeconds: 0, screenDurationSeconds: 3 }),
        item('shot_003', { isStill: true, motionSeconds: 0, screenDurationSeconds: 3 }),
        item('shot_004', { isStill: true, motionSeconds: 0, screenDurationSeconds: 3 }),
        item('shot_005'),
      ]),
      policy,
    );
    expect(r.pass).toBe(false);
    expect(r.violations.some((v) => v.rule === 'min-motion-ratio')).toBe(true);
  });

  it('fails a still that lingers too long', () => {
    const r = lintMotionRatio(
      plan([
        item('shot_001'),
        item('shot_002', { isStill: true, motionSeconds: 0, screenDurationSeconds: 8 }),
        item('shot_003'),
      ]),
      policy,
    );
    expect(r.violations.some((v) => v.rule === 'max-still-duration')).toBe(true);
  });

  it('fails too many consecutive stills', () => {
    const r = lintMotionRatio(
      plan([
        item('shot_001'),
        ...['shot_002', 'shot_003', 'shot_004'].map((id) =>
          item(id, { isStill: true, motionSeconds: 0, screenDurationSeconds: 2 }),
        ),
        item('shot_005', { motionSeconds: 30, screenDurationSeconds: 32 }),
      ]),
      policy,
    );
    expect(r.violations.some((v) => v.rule === 'max-consecutive-stills')).toBe(true);
  });

  it('requires the opening shot to move', () => {
    const r = lintMotionRatio(
      plan([
        item('shot_001', { isStill: true, motionSeconds: 0, screenDurationSeconds: 3 }),
        item('shot_002', { motionSeconds: 30, screenDurationSeconds: 32 }),
      ]),
      policy,
    );
    expect(r.violations.some((v) => v.rule === 'opening-motion')).toBe(true);
  });

  it('requires the closing shot to move', () => {
    const r = lintMotionRatio(
      plan([
        item('shot_001', { motionSeconds: 30, screenDurationSeconds: 32 }),
        item('shot_002', { isStill: true, motionSeconds: 0, screenDurationSeconds: 3 }),
      ]),
      policy,
    );
    expect(r.violations.some((v) => v.rule === 'closing-motion')).toBe(true);
  });

  it('does not count a Ken Burns still as real motion', () => {
    // The substitution this lint exists to catch: panning a still is not motion.
    const r = lintMotionRatio(
      plan([
        item('shot_001', {
          isStill: true,
          motionSeconds: 5,
          kenBurns: { enabled: true, startScale: 1, endScale: 1.2 },
        }),
      ]),
      policy,
    );
    expect(r.motionSeconds).toBe(0);
  });
});

describe('motion lint #2 - after fallbacks', () => {
  const healthy = plan([
    item('shot_001'), item('shot_002'), item('shot_003'), item('shot_004'),
  ]);

  it('passes when nothing failed', () => {
    expect(lintAfterFallbacks(healthy, [], policy).pass).toBe(true);
  });

  it('catches slideshow drift once several shots fall back to stills', () => {
    // Each fallback looks reasonable alone; together they break the ratio.
    // This is exactly why section 18 mandates a second lint.
    const r = lintAfterFallbacks(healthy, ['shot_002', 'shot_003', 'shot_004'], policy);
    expect(r.pass).toBe(false);
    expect(r.phase).toBe(2);
  });

  it('reports the degraded ratio, not the planned one', () => {
    const before = lintMotionRatio(healthy, policy, 1);
    const after = lintAfterFallbacks(healthy, ['shot_002', 'shot_003'], policy);
    expect(after.motionRatio).toBeLessThan(before.motionRatio);
  });

  it('leaves the original plan unmutated', () => {
    lintAfterFallbacks(healthy, ['shot_002'], policy);
    expect(healthy.items[1]!.isStill).toBe(false);
  });
});
