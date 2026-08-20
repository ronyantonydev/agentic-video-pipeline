import { describe, it, expect } from 'vitest';
import {
  StorySchema,
  BeatGridSchema,
  ProgressionSchema,
  ShotlistSchema,
  EditPlanSchema,
  GenerationPlanSchema,
  MusicSchema,
  ContinuitySchema,
  StoryboardSchema,
  AudioPlanSchema,
  PLANNING_ARTIFACTS,
} from '../src/schemas/planning.js';
import { StateSchema, BudgetStateSchema, emptyState, STAGES, stageAtLeast } from '../src/schemas/state.js';

const SETTINGS = { width: 1920, height: 1080, fps: 30, colorspace: 'bt709', aspectRatio: '16:9' };

describe('story schema', () => {
  const valid = {
    idea: 'a man builds an underground house',
    title: 'The Dig',
    logline: 'One man, one shovel, one year.',
    hook: 'He started with nothing but a shovel.',
    targetDurationSeconds: 90,
    tone: 'cinematic',
    beats: [{ id: 'b1', summary: 'breaks ground' }],
    narrationRequired: false,
  };

  it('accepts a valid story', () => {
    expect(StorySchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an empty hook', () => {
    expect(StorySchema.safeParse({ ...valid, hook: '' }).success).toBe(false);
  });

  it('rejects zero duration', () => {
    expect(StorySchema.safeParse({ ...valid, targetDurationSeconds: 0 }).success).toBe(false);
  });

  it('rejects an empty beat list', () => {
    expect(StorySchema.safeParse({ ...valid, beats: [] }).success).toBe(false);
  });
});

describe('beat grid schema', () => {
  const valid = { bpm: 120, beatsPerBar: 4, beats: [0, 0.5, 1.0, 1.5], downbeats: [0, 2], totalDurationSeconds: 90 };

  it('accepts increasing beats', () => {
    expect(BeatGridSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects out-of-order beats', () => {
    const r = BeatGridSchema.safeParse({ ...valid, beats: [0, 1.0, 0.5] });
    expect(r.success).toBe(false);
  });

  it('rejects a beat past the end of the track', () => {
    const r = BeatGridSchema.safeParse({ ...valid, beats: [0, 50, 200], totalDurationSeconds: 90 });
    expect(r.success).toBe(false);
  });
});

describe('progression schema', () => {
  it('requires contiguous stage indexes', () => {
    const ok = {
      subject: 'underground house',
      stages: [
        { index: 0, name: 'empty ground', description: 'untouched field' },
        { index: 1, name: 'shallow hole', description: 'first dig' },
      ],
    };
    expect(ProgressionSchema.safeParse(ok).success).toBe(true);

    const gap = { ...ok, stages: [ok.stages[0]!, { ...ok.stages[1]!, index: 5 }] };
    expect(ProgressionSchema.safeParse(gap).success).toBe(false);
  });

  it('requires at least two stages to be a progression', () => {
    const one = { subject: 'x', stages: [{ index: 0, name: 'a', description: 'b' }] };
    expect(ProgressionSchema.safeParse(one).success).toBe(false);
  });
});

describe('shotlist schema', () => {
  const shot = (i: number, extra: Record<string, unknown> = {}) => ({
    id: `shot_${String(i + 1).padStart(3, '0')}`,
    index: i,
    intent: 'digging',
    importance: 'normal',
    continuityMode: 'independent',
    ...extra,
  });

  it('accepts a well-formed shotlist', () => {
    expect(ShotlistSchema.safeParse({ shots: [shot(0), shot(1)] }).success).toBe(true);
  });

  it('rejects a malformed shot id', () => {
    const bad = { shots: [{ ...shot(0), id: 'shot1' }] };
    expect(ShotlistSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects duplicate shot ids', () => {
    const dup = { shots: [shot(0), { ...shot(1), id: 'shot_001' }] };
    expect(ShotlistSchema.safeParse(dup).success).toBe(false);
  });

  it('rejects non-contiguous indexes', () => {
    const gap = { shots: [shot(0), { ...shot(1), index: 7 }] };
    expect(ShotlistSchema.safeParse(gap).success).toBe(false);
  });

  it('requires previousShot when continuityMode is previous-shot', () => {
    const missing = { shots: [shot(0), shot(1, { continuityMode: 'previous-shot' })] };
    expect(ShotlistSchema.safeParse(missing).success).toBe(false);

    const present = {
      shots: [shot(0), shot(1, { continuityMode: 'previous-shot', previousShot: 'shot_001' })],
    };
    expect(ShotlistSchema.safeParse(present).success).toBe(true);
  });
});

describe('edit plan schema', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    shotId: 'shot_001',
    startSeconds: 0,
    screenDurationSeconds: 6,
    motionSeconds: 3,
    speedFactor: 1,
    transitionIn: 'cut',
    transitionOut: 'cut',
    isStill: false,
    ...over,
  });
  const plan = (items: unknown[]) => ({
    totalDurationSeconds: 90,
    items,
    music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
    captions: [],
  });

  it('accepts a valid plan', () => {
    expect(EditPlanSchema.safeParse(plan([item()])).success).toBe(true);
  });

  it('rejects motion longer than screen time', () => {
    const bad = plan([item({ motionSeconds: 10, screenDurationSeconds: 6 })]);
    expect(EditPlanSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects items out of timeline order', () => {
    const bad = plan([
      item({ startSeconds: 10 }),
      item({ shotId: 'shot_002', startSeconds: 2 }),
    ]);
    expect(EditPlanSchema.safeParse(bad).success).toBe(false);
  });
});

describe('generation plan schema', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    shotId: 'shot_001',
    modelId: 'seedance1_5',
    requiredSeconds: 3.2,
    billableSeconds: 4,
    prompt: 'man digging',
    aspectRatio: '16:9',
    usesStartFrame: false,
    usesEndFrame: false,
    nativeAudio: false,
    settings: {},
    ...over,
  });

  it('accepts billable >= required', () => {
    expect(GenerationPlanSchema.safeParse({ items: [item()] }).success).toBe(true);
  });

  it('rejects rounding down below what the edit needs', () => {
    // The whole point of section 7: never generate less than the edit requires.
    const bad = { items: [item({ requiredSeconds: 5, billableSeconds: 4 })] };
    expect(GenerationPlanSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects duplicate shots', () => {
    const dup = { items: [item(), item()] };
    expect(GenerationPlanSchema.safeParse(dup).success).toBe(false);
  });
});

describe('remaining artifact schemas accept minimal valid input', () => {
  it('music', () => {
    expect(
      MusicSchema.safeParse({
        mood: 'tense', genre: 'ambient', bpm: 90, energyCurve: 'build',
        source: 'generated', durationSeconds: 90,
      }).success,
    ).toBe(true);
  });

  it('continuity', () => {
    expect(
      ContinuitySchema.safeParse({ environment: { description: 'rural field' } }).success,
    ).toBe(true);
  });

  it('storyboard', () => {
    expect(
      StoryboardSchema.safeParse({
        frames: [{ shotId: 'shot_001', description: 'digging', imagePrompt: 'a man digs' }],
      }).success,
    ).toBe(true);
  });

  it('audio plan', () => {
    expect(AudioPlanSchema.safeParse({}).success).toBe(true);
  });

  it('all ten artifacts are registered', () => {
    expect(Object.keys(PLANNING_ARTIFACTS)).toHaveLength(10);
  });
});

describe('budget invariant', () => {
  it('rejects spent + reserved above the ceiling', () => {
    const over = { maxBudgetUSD: 20, spentUSD: 15, reservedUSD: 10, creditsStart: null, creditsUsed: 0, creditsRemaining: null };
    expect(BudgetStateSchema.safeParse(over).success).toBe(false);
  });

  it('accepts spend exactly at the ceiling', () => {
    const exact = { maxBudgetUSD: 20, spentUSD: 12, reservedUSD: 8, creditsStart: null, creditsUsed: 0, creditsRemaining: null };
    expect(BudgetStateSchema.safeParse(exact).success).toBe(true);
  });

  it('rejects negative spend', () => {
    const neg = { maxBudgetUSD: 20, spentUSD: -1, reservedUSD: 0, creditsStart: null, creditsUsed: 0, creditsRemaining: null };
    expect(BudgetStateSchema.safeParse(neg).success).toBe(false);
  });
});

describe('state schema and stages', () => {
  it('constructs a valid empty state', () => {
    const s = emptyState({
      projectName: 'test', idea: 'x', mode: 'full', maxBudgetUSD: 20, projectSettings: SETTINGS,
    });
    expect(StateSchema.safeParse(s).success).toBe(true);
    expect(s.stage).toBe('init');
  });

  it('orders stages so gates precede the work they guard', () => {
    expect(stageAtLeast('references', 'gate-cost')).toBe(true);
    expect(stageAtLeast('generate-shots', 'gate-look')).toBe(true);
    expect(stageAtLeast('gate-cost', 'generate-shots')).toBe(false);
  });

  it('runs motion lint both before and after generation', () => {
    expect(stageAtLeast('motion-lint-1', 'edit-plan')).toBe(true);
    expect(stageAtLeast('motion-lint-2', 'review')).toBe(true);
    expect(STAGES.indexOf('motion-lint-1')).toBeLessThan(STAGES.indexOf('generate-shots'));
    expect(STAGES.indexOf('motion-lint-2')).toBeGreaterThan(STAGES.indexOf('generate-shots'));
  });

  it('rejects an unknown stage', () => {
    const s = emptyState({ projectName: 't', idea: 'x', mode: 'full', maxBudgetUSD: 20, projectSettings: SETTINGS });
    expect(StateSchema.safeParse({ ...s, stage: 'not-a-stage' }).success).toBe(false);
  });
});
