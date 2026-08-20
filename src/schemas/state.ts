/**
 * state.json and manifest.json schemas.
 *
 * These two files are the crash-recovery contract. state.json says where the
 * run is; manifest.json says what has been paid for. Architecture sections
 * 19, 21, 22, 23.
 */

import { z } from 'zod';
import { ShotId } from './planning.js';

/* ------------------------------------------------------------------ stages */

/**
 * Ordered pipeline stages. Position matters: resume logic compares indexes,
 * so never reorder without a migration.
 */
export const STAGES = [
  'init',
  'story',
  'music',
  'beat-grid',
  'progression',
  'continuity',
  'shotlist',
  'storyboard',
  'edit-plan',
  'motion-lint-1',
  'generation-plan',
  'cost-estimate',
  'gate-cost',
  'references',
  'target-frames',
  'contact-sheet',
  'gate-look',
  'generate-shots',
  'normalize',
  'qa-machine',
  'qa-vision',
  'review',
  'motion-lint-2',
  'audio-finalize',
  'render',
  'upscale',
  'thumbnail',
  'qa-final',
  'report',
  'done',
] as const;

export const Stage = z.enum(STAGES);
export type StageName = (typeof STAGES)[number];

export function stageIndex(stage: StageName): number {
  return STAGES.indexOf(stage);
}

/** True when `a` happens at or after `b` in the pipeline. */
export function stageAtLeast(a: StageName, b: StageName): boolean {
  return stageIndex(a) >= stageIndex(b);
}

/* ------------------------------------------------------------------- gates */

export const GateName = z.enum(['cost', 'look', 'review']);
export type GateNameT = z.infer<typeof GateName>;

export const GateStateSchema = z.object({
  status: z.enum(['not-reached', 'pending', 'approved', 'rejected']),
  requestedAt: z.string().datetime().optional(),
  decidedAt: z.string().datetime().optional(),
  decidedBy: z.string().optional(),
  note: z.string().optional(),
});

/* ------------------------------------------------------------------ budget */

export const BudgetStateSchema = z
  .object({
    maxBudgetUSD: z.number().nonnegative(),
    spentUSD: z.number().nonnegative().default(0),
    /** Cost of in-flight jobs, counted against budget until settled. */
    reservedUSD: z.number().nonnegative().default(0),
    creditsStart: z.number().nonnegative().nullable().default(null),
    creditsUsed: z.number().nonnegative().default(0),
    creditsRemaining: z.number().nonnegative().nullable().default(null),
  })
  .refine((b) => b.spentUSD + b.reservedUSD <= b.maxBudgetUSD + 0.0001, {
    message: 'spent + reserved exceeds maxBudgetUSD - budget invariant violated',
  });
export type BudgetState = z.infer<typeof BudgetStateSchema>;

/* ------------------------------------------------------------------- state */

export const StateSchema = z.object({
  version: z.literal(1),
  projectName: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),

  idea: z.string().min(1),
  mode: z.enum(['full', 'proof', 'dry-run']).default('full'),

  stage: Stage,
  completedStages: z.array(Stage).default([]),

  gates: z.object({
    cost: GateStateSchema,
    look: GateStateSchema,
    review: GateStateSchema,
  }),

  budget: BudgetStateSchema,

  projectSettings: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
    colorspace: z.string(),
    aspectRatio: z.string(),
  }),

  /** Per-shot progress. Keyed by shot id. */
  shots: z
    .record(
      z.object({
        status: z.enum([
          'planned',
          'submitted',
          'downloaded',
          'normalized',
          'qa-passed',
          'qa-flagged',
          'accepted',
          'rejected',
          'fallback-still',
          'failed',
        ]),
        attempts: z.number().int().nonnegative().default(0),
        lastError: z.string().optional(),
        failureClass: z.string().optional(),
      }),
    )
    .default({}),

  warnings: z.array(z.string()).default([]),
  lastError: z.string().optional(),
});
export type State = z.infer<typeof StateSchema>;

/* ---------------------------------------------------------------- manifest */

/**
 * One entry per paid generation. Written BEFORE submission completes so a
 * crash mid-flight still leaves a recoverable record. Architecture section 23.
 */
export const ManifestEntrySchema = z.object({
  /** hash(prompt + model + frames + duration + settings). Architecture section 22. */
  assetHash: z.string().min(8),
  shotId: ShotId.optional(),
  kind: z.enum(['video', 'image', 'audio']),
  provider: z.string().min(1),
  model: z.string().min(1),

  prompt: z.string(),
  seed: z.number().int().optional(),
  settings: z.record(z.unknown()).default({}),

  jobId: z.string().optional(),
  remoteUrl: z.string().optional(),

  submittedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),

  billableDuration: z.number().nonnegative().optional(),
  estimatedCredits: z.number().nonnegative().nullable(),
  estimatedUSD: z.number().nonnegative().nullable(),
  actualCredits: z.number().nonnegative().nullable().default(null),
  actualUSD: z.number().nonnegative().nullable().default(null),

  status: z.enum(['submitted', 'polling', 'completed', 'failed', 'cancelled', 'refunded']),
  localFile: z.string().optional(),
  accepted: z.boolean().nullable().default(null),
  qualityNote: z.string().optional(),
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const ManifestSchema = z.object({
  version: z.literal(1),
  projectName: z.string().min(1),
  entries: z.array(ManifestEntrySchema).default([]),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/* ------------------------------------------------------------- constructors */

export function emptyState(args: {
  projectName: string;
  idea: string;
  mode: 'full' | 'proof' | 'dry-run';
  maxBudgetUSD: number;
  projectSettings: State['projectSettings'];
  now?: string;
}): State {
  const now = args.now ?? new Date().toISOString();
  const gate = { status: 'not-reached' as const };
  return {
    version: 1,
    projectName: args.projectName,
    createdAt: now,
    updatedAt: now,
    idea: args.idea,
    mode: args.mode,
    stage: 'init',
    completedStages: [],
    gates: { cost: { ...gate }, look: { ...gate }, review: { ...gate } },
    budget: {
      maxBudgetUSD: args.maxBudgetUSD,
      spentUSD: 0,
      reservedUSD: 0,
      creditsStart: null,
      creditsUsed: 0,
      creditsRemaining: null,
    },
    projectSettings: args.projectSettings,
    shots: {},
    warnings: [],
  };
}

export function emptyManifest(projectName: string): Manifest {
  return { version: 1, projectName, entries: [] };
}
