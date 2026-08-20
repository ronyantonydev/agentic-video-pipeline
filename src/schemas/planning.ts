/**
 * Zod schemas for every planning artifact. Architecture section 35.
 *
 * These are the contract between Claude (which writes the JSON) and the
 * deterministic code (which spends money against it). Invalid JSON must fail
 * here, before any paid call.
 */

import { z } from 'zod';

/* ------------------------------------------------------------------ shared */

/** shot_001, shot_042 - zero padded so lexical order matches shot order. */
export const ShotId = z
  .string()
  .regex(/^shot_\d{3}$/, 'shot id must look like shot_001');

export const Seconds = z.number().positive().finite();

/** Architecture section 12. Determines whether a shot can run in parallel. */
export const ContinuityMode = z.enum(['independent', 'reference-only', 'previous-shot']);

export const ShotImportance = z.enum(['anchor', 'normal', 'supporting']);

/* ------------------------------------------------------------------- story */

export const StorySchema = z.object({
  idea: z.string().min(1),
  title: z.string().min(1),
  logline: z.string().min(1),
  hook: z.string().min(1),
  targetDurationSeconds: Seconds,
  tone: z.string().min(1),
  audience: z.string().optional(),
  beats: z
    .array(
      z.object({
        id: z.string().min(1),
        summary: z.string().min(1),
        purpose: z.string().optional(),
      }),
    )
    .min(1),
  narrationRequired: z.boolean(),
  narrationScript: z.string().optional(),
});
export type Story = z.infer<typeof StorySchema>;

/* ------------------------------------------------------------------- music */

export const MusicSchema = z.object({
  mood: z.string().min(1),
  genre: z.string().min(1),
  bpm: z.number().positive().max(300),
  energyCurve: z.enum(['build', 'steady', 'ebb-flow', 'drop']),
  source: z.enum(['generated', 'library']),
  generationPrompt: z.string().optional(),
  durationSeconds: Seconds,
  localFile: z.string().optional(),
});
export type Music = z.infer<typeof MusicSchema>;

/* --------------------------------------------------------------- beat grid */

export const BeatGridSchema = z
  .object({
    bpm: z.number().positive(),
    beatsPerBar: z.number().int().positive().default(4),
    /** Seconds from t=0 for each usable cut point. */
    beats: z.array(z.number().nonnegative()).min(2),
    downbeats: z.array(z.number().nonnegative()).default([]),
    totalDurationSeconds: Seconds,
  })
  .refine((g) => g.beats.every((b, i, arr) => i === 0 || b > arr[i - 1]!), {
    message: 'beats must be strictly increasing',
  })
  .refine((g) => g.beats[g.beats.length - 1]! <= g.totalDurationSeconds + 0.001, {
    message: 'last beat exceeds total duration',
  });
export type BeatGrid = z.infer<typeof BeatGridSchema>;

/* ------------------------------------------------------------- progression */

export const ProgressionSchema = z
  .object({
    subject: z.string().min(1),
    stages: z
      .array(
        z.object({
          index: z.number().int().nonnegative(),
          name: z.string().min(1),
          description: z.string().min(1),
          visualMarkers: z.array(z.string()).default([]),
        }),
      )
      .min(2),
  })
  .refine((p) => p.stages.every((s, i) => s.index === i), {
    message: 'progression stage indexes must be contiguous from 0',
  });
export type Progression = z.infer<typeof ProgressionSchema>;

/* -------------------------------------------------------------- continuity */

export const ContinuitySchema = z.object({
  character: z
    .object({
      description: z.string().min(1),
      wardrobe: z.string().optional(),
      distinguishingFeatures: z.array(z.string()).default([]),
    })
    .optional(),
  environment: z.object({
    description: z.string().min(1),
    timeOfDay: z.string().optional(),
    weather: z.string().optional(),
  }),
  lighting: z.string().optional(),
  cameraStyle: z.string().optional(),
  lensStyle: z.string().optional(),
  colorPalette: z.array(z.string()).default([]),
  props: z.array(z.object({ name: z.string(), description: z.string() })).default([]),
  styleKeywords: z.array(z.string()).default([]),
  negativePrompt: z.string().optional(),
});
export type Continuity = z.infer<typeof ContinuitySchema>;

/* ---------------------------------------------------------------- shotlist */

export const ShotSchema = z.object({
  id: ShotId,
  index: z.number().int().nonnegative(),
  beatId: z.string().optional(),
  progressionStage: z.number().int().nonnegative().optional(),
  intent: z.string().min(1),
  importance: ShotImportance,
  continuityMode: ContinuityMode,
  /** Required when continuityMode is previous-shot. Cross-checked in graph validation. */
  previousShot: ShotId.optional(),
  cameraMove: z.string().optional(),
  shotSize: z.string().optional(),
});
export type Shot = z.infer<typeof ShotSchema>;

export const ShotlistSchema = z
  .object({
    shots: z.array(ShotSchema).min(1),
  })
  .refine((s) => s.shots.every((shot, i) => shot.index === i), {
    message: 'shot indexes must be contiguous from 0',
  })
  .refine((s) => new Set(s.shots.map((x) => x.id)).size === s.shots.length, {
    message: 'duplicate shot ids',
  })
  .refine(
    (s) =>
      s.shots.every((shot) =>
        shot.continuityMode === 'previous-shot' ? shot.previousShot !== undefined : true,
      ),
    { message: 'previous-shot shots must name a previousShot' },
  );
export type Shotlist = z.infer<typeof ShotlistSchema>;

/* -------------------------------------------------------------- storyboard */
/* "What should the viewer see?" - architecture section 6 */

export const StoryboardSchema = z.object({
  frames: z
    .array(
      z.object({
        shotId: ShotId,
        description: z.string().min(1),
        imagePrompt: z.string().min(1),
        startFramePrompt: z.string().optional(),
        endFramePrompt: z.string().optional(),
        referenceImages: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

/* --------------------------------------------------------------- edit plan */
/* "How will the final timeline present it?" - architecture section 6 */

export const TimelineItemSchema = z.object({
  shotId: ShotId,
  startSeconds: z.number().nonnegative(),
  /** Screen time in the final edit, which may differ from generated duration. */
  screenDurationSeconds: Seconds,
  /** Portion of screen time that is genuinely moving footage. Drives motion-ratio lint. */
  motionSeconds: z.number().nonnegative(),
  speedFactor: z.number().positive().default(1),
  transitionIn: z.string().default('cut'),
  transitionOut: z.string().default('cut'),
  kenBurns: z
    .object({
      enabled: z.boolean(),
      startScale: z.number().positive().optional(),
      endScale: z.number().positive().optional(),
    })
    .optional(),
  isStill: z.boolean().default(false),
});

export const EditPlanSchema = z
  .object({
    totalDurationSeconds: Seconds,
    items: z.array(TimelineItemSchema).min(1),
    music: z.object({
      file: z.string().optional(),
      gainDb: z.number().default(-12),
      fadeInSeconds: z.number().nonnegative().default(0),
      fadeOutSeconds: z.number().nonnegative().default(0),
    }),
    captions: z
      .array(
        z.object({
          text: z.string(),
          startSeconds: z.number().nonnegative(),
          durationSeconds: Seconds,
        }),
      )
      .default([]),
  })
  .refine((p) => p.items.every((it) => it.motionSeconds <= it.screenDurationSeconds + 0.001), {
    message: 'motionSeconds cannot exceed screenDurationSeconds',
  })
  .refine(
    (p) =>
      p.items.every((it, i, arr) => i === 0 || it.startSeconds >= arr[i - 1]!.startSeconds),
    { message: 'timeline items must be ordered by startSeconds' },
  );
export type EditPlan = z.infer<typeof EditPlanSchema>;
export type TimelineItem = z.infer<typeof TimelineItemSchema>;

/* --------------------------------------------------------- generation plan */
/* "What paid assets do we actually need?" - architecture section 6 */

export const GenerationItemSchema = z.object({
  shotId: ShotId,
  modelId: z.string().min(1),
  /** What the edit needs. */
  requiredSeconds: Seconds,
  /** What the model will actually bill for, after rounding. Architecture section 7. */
  billableSeconds: Seconds,
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  aspectRatio: z.string(),
  resolution: z.string().optional(),
  usesStartFrame: z.boolean().default(false),
  usesEndFrame: z.boolean().default(false),
  nativeAudio: z.boolean().default(false),
  seed: z.number().int().optional(),
  settings: z.record(z.unknown()).default({}),
});

export const GenerationPlanSchema = z
  .object({
    items: z.array(GenerationItemSchema).min(1),
  })
  .refine((p) => p.items.every((it) => it.billableSeconds >= it.requiredSeconds - 0.001), {
    message: 'billableSeconds must cover requiredSeconds - never round down below need',
  })
  .refine((p) => new Set(p.items.map((i) => i.shotId)).size === p.items.length, {
    message: 'duplicate shotId in generation plan',
  });
export type GenerationPlan = z.infer<typeof GenerationPlanSchema>;
export type GenerationItem = z.infer<typeof GenerationItemSchema>;

/* -------------------------------------------------------------- audio plan */

export const AudioPlanSchema = z.object({
  musicFile: z.string().optional(),
  useNativeVideoAudio: z.boolean().default(false),
  sfx: z
    .array(
      z.object({
        shotId: ShotId.optional(),
        description: z.string().min(1),
        startSeconds: z.number().nonnegative(),
        gainDb: z.number().default(-18),
        source: z.enum(['generated', 'library']).default('generated'),
        localFile: z.string().optional(),
      }),
    )
    .default([]),
  narration: z
    .object({
      script: z.string().min(1),
      voiceId: z.string().optional(),
      localFile: z.string().optional(),
      durationSeconds: Seconds.optional(),
    })
    .optional(),
});
export type AudioPlan = z.infer<typeof AudioPlanSchema>;

/* ------------------------------------------------------------------ export */

export const PLANNING_ARTIFACTS = {
  'story.json': StorySchema,
  'music.json': MusicSchema,
  'beat-grid.json': BeatGridSchema,
  'progression.json': ProgressionSchema,
  'continuity.json': ContinuitySchema,
  'shotlist.json': ShotlistSchema,
  'storyboard.json': StoryboardSchema,
  'edit-plan.json': EditPlanSchema,
  'generation-plan.json': GenerationPlanSchema,
  'audio-plan.json': AudioPlanSchema,
} as const;

export type PlanningArtifactName = keyof typeof PLANNING_ARTIFACTS;
