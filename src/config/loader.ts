/**
 * Loads and validates config/*.json.
 *
 * These files drive model selection and spending decisions, so they are
 * schema-checked on load rather than trusted.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ValidationError } from '../util/errors.js';

const CONFIG_DIR = resolve(process.cwd(), 'config');

/* ------------------------------------------------------------------ models */

const DurationDiscrete = z.object({
  durationMode: z.literal('discrete'),
  allowedDurations: z.array(z.number().positive()).min(1),
});

const DurationRange = z.object({
  durationMode: z.literal('range'),
  durationRange: z.object({ min: z.number().positive(), max: z.number().positive() }),
});

const VideoModel = z
  .object({
    id: z.string().min(1),
    provider: z.string(),
    name: z.string(),
    qualityTier: z.enum(['budget', 'standard', 'quality']),
    costCredits: z.number().nonnegative().nullable(),
    costSource: z.string().optional(),
    supportsStartFrame: z.boolean(),
    supportsEndFrame: z.boolean(),
    supportsStartEndFrames: z.boolean(),
    supportsNativeAudio: z.boolean(),
    nativeAudioDefault: z.boolean().optional(),
    maxResolution: z.string(),
    aspectRatios: z.array(z.string()),
    fps: z.number().positive(),
    modes: z.array(z.string()).optional(),
    enabled: z.boolean(),
    useFor: z.array(z.string()),
  })
  .and(z.union([DurationDiscrete, DurationRange]));

const ImageModel = z.object({
  id: z.string().min(1),
  provider: z.string(),
  name: z.string(),
  qualityTier: z.enum(['budget', 'standard', 'quality']),
  costCredits: z.number().nonnegative().nullable(),
  costSource: z.string().optional(),
  supportsImageReferences: z.boolean(),
  resolutions: z.array(z.string()).optional(),
  aspectRatios: z.array(z.string()),
  enabled: z.boolean(),
  useFor: z.array(z.string()),
});

const AudioModel = z.object({
  id: z.string().min(1),
  provider: z.string(),
  name: z.string(),
  costCredits: z.number().nonnegative().nullable(),
  enabled: z.boolean(),
  useFor: z.array(z.string()),
});

const SanityBand = z.object({ min: z.number().nonnegative(), max: z.number().positive() });

export const ModelsConfigSchema = z.object({
  creditToUsd: z.object({
    rate: z.number().positive(),
    source: z.string(),
    verified: z.boolean(),
  }),
  sanityRangeCredits: z.object({
    image: SanityBand,
    videoBudget: SanityBand,
    videoPremium: SanityBand,
    audio: SanityBand,
  }),
  video: z.array(VideoModel).min(1),
  image: z.array(ImageModel).min(1),
  audio: z.array(AudioModel),
  selectionPolicy: z.object({
    normal: z.string(),
    anchor: z.string(),
    supporting: z.string(),
    escalationOrder: z.array(z.string()).min(1),
    requireApprovalOnEscalation: z.boolean(),
  }),
  knownIncompatible: z.object({
    startFrameOnly: z.array(z.string()),
  }),
});

export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
export type VideoModelConfig = z.infer<typeof VideoModel>;
export type ImageModelConfig = z.infer<typeof ImageModel>;

/* --------------------------------------------------------- project defaults */

export const ProjectDefaultsSchema = z.object({
  video: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
    colorspace: z.string(),
    pixelFormat: z.string(),
    aspectRatio: z.string(),
  }),
  audio: z.object({
    sampleRate: z.number().int().positive(),
    channels: z.number().int().positive(),
    codec: z.string(),
    bitrate: z.string(),
    targetLoudnessLufs: z.number(),
  }),
  encoding: z.object({
    videoCodec: z.string(),
    crf: z.number().int().min(0).max(51),
    preset: z.string(),
  }),
  budget: z.object({
    maxBudgetUSD: z.number().nonnegative(),
    maxSingleCallUSD: z.number().nonnegative(),
    stopOnCreditsBelow: z.number().nonnegative(),
  }),
  execution: z.object({
    maxConcurrency: z.number().int().positive(),
    jobTimeoutSeconds: z.number().positive(),
    pollInitialDelayMs: z.number().positive(),
    pollMaxDelayMs: z.number().positive(),
    pollBackoffFactor: z.number().min(1),
    maxRetriesPerShot: z.number().int().nonnegative(),
  }),
  proof: z.object({
    targetDurationSeconds: z.number().positive(),
    shotCount: z.number().int().positive(),
    useProductionModels: z.boolean(),
  }),
});

export type ProjectDefaults = z.infer<typeof ProjectDefaultsSchema>;

/* ----------------------------------------------------------- quality policy */

export const QualityPolicySchema = z.object({
  motionRatio: z.object({
    minRealMotionRatio: z.number().min(0).max(1),
    maxStillDurationSeconds: z.number().positive(),
    maxConsecutiveNonMotionShots: z.number().int().positive(),
    openingMustBeMotion: z.boolean(),
    closingMustBeMotion: z.boolean(),
  }),
  continuity: z.object({
    maxChainLength: z.number().int().positive(),
    warnOnChainLengthAbove: z.number().int().positive(),
  }),
  machineQa: z.object({
    durationTolerancePercent: z.number().nonnegative(),
    maxBlackFrameRatio: z.number().min(0).max(1),
    blackFrameLumaThreshold: z.number().min(0).max(1),
    frozenFrameSimilarityThreshold: z.number().min(0).max(1),
    maxFrozenRunSeconds: z.number().positive(),
    requireAudioWhenExpected: z.boolean(),
    allowedFpsDeviation: z.number().nonnegative(),
    requireExactResolution: z.boolean(),
  }),
  visionQa: z.object({
    framesPerShot: z.number().int().positive(),
    frameSamplingStrategy: z.enum(['even', 'keyframe']),
    checks: z.array(z.string()),
    autoSpendOnRetry: z.boolean(),
  }),
  failureClasses: z.array(z.string()).min(1),
  finalQa: z.object({
    reportOnly: z.boolean(),
    checks: z.array(z.string()),
  }),
});

export type QualityPolicy = z.infer<typeof QualityPolicySchema>;

/* -------------------------------------------------------------------- load */

function readJson(file: string): unknown {
  const path = resolve(CONFIG_DIR, file);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ValidationError(
      `Cannot read config/${file}: ${(err as Error).message}`,
      file,
    );
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, file: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ValidationError(
      `config/${file} failed validation:\n  ${issues.join('\n  ')}`,
      file,
      issues,
    );
  }
  return result.data;
}

let modelsCache: ModelsConfig | null = null;
let defaultsCache: ProjectDefaults | null = null;
let policyCache: QualityPolicy | null = null;

export function loadModels(force = false): ModelsConfig {
  if (!modelsCache || force) {
    modelsCache = parseOrThrow(ModelsConfigSchema, readJson('models.json'), 'models.json');
    assertSelectionPolicyResolvable(modelsCache);
  }
  return modelsCache;
}

export function loadProjectDefaults(force = false): ProjectDefaults {
  if (!defaultsCache || force) {
    defaultsCache = parseOrThrow(
      ProjectDefaultsSchema,
      readJson('project-defaults.json'),
      'project-defaults.json',
    );
  }
  return defaultsCache;
}

export function loadQualityPolicy(force = false): QualityPolicy {
  if (!policyCache || force) {
    policyCache = parseOrThrow(
      QualityPolicySchema,
      readJson('quality-policy.json'),
      'quality-policy.json',
    );
  }
  return policyCache;
}

export function resetConfigCache(): void {
  modelsCache = null;
  defaultsCache = null;
  policyCache = null;
}

/**
 * Every model named by the selection policy must actually exist and be enabled.
 * A typo here would otherwise surface as a runtime failure mid-generation.
 */
function assertSelectionPolicyResolvable(cfg: ModelsConfig): void {
  const byId = new Map(cfg.video.map((m) => [m.id, m]));
  const referenced = [
    ['normal', cfg.selectionPolicy.normal],
    ['anchor', cfg.selectionPolicy.anchor],
    ['supporting', cfg.selectionPolicy.supporting],
    ...cfg.selectionPolicy.escalationOrder.map((id, i) => [`escalationOrder[${i}]`, id] as const),
  ] as const;

  const problems: string[] = [];
  for (const [role, id] of referenced) {
    const model = byId.get(id);
    if (!model) problems.push(`selectionPolicy.${role} -> unknown video model "${id}"`);
    else if (!model.enabled) problems.push(`selectionPolicy.${role} -> model "${id}" is disabled`);
  }

  if (problems.length > 0) {
    throw new ValidationError(
      `config/models.json selection policy is unresolvable:\n  ${problems.join('\n  ')}`,
      'models.json',
      problems,
    );
  }
}
