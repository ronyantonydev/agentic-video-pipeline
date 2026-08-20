/**
 * Environment loading and validation.
 *
 * Fails loudly at startup rather than mid-run. A misconfigured budget
 * ceiling discovered halfway through a paid batch is far worse than a
 * refusal to boot.
 */

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

loadDotenv({ path: resolve(process.cwd(), '.env'), quiet: true });

/** Coerce "true"/"1"/"yes" to boolean; anything else is false. */
const boolish = z
  .string()
  .optional()
  .transform((v) => ['true', '1', 'yes', 'on'].includes((v ?? '').toLowerCase()));

/** Positive number from string, with a default. */
const numeric = (fallback: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : Number(v)))
    .pipe(z.number().finite().min(min));

const EnvSchema = z.object({
  HIGGSFIELD_API_KEY: z.string().default(''),
  HIGGSFIELD_API_SECRET: z.string().default(''),
  HIGGSFIELD_API_BASE: z.string().url().default('https://platform.higgsfield.ai'),

  MAX_BUDGET_USD: numeric(20, 0),
  MAX_SINGLE_CALL_USD: numeric(3, 0),

  DRY_RUN: boolish,
  MAX_CONCURRENCY: numeric(3, 1),
  JOB_TIMEOUT_SECONDS: numeric(900, 1),

  FFMPEG_PATH: z.string().default(''),
  FFPROBE_PATH: z.string().default(''),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof EnvSchema> & {
  ffmpegBin: string;
  ffprobeBin: string;
  hasHiggsfieldCredentials: boolean;
};

let cached: Env | null = null;

export function loadEnv(force = false): Env {
  if (cached && !force) return cached;

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }

  const env = parsed.data;

  // A single call must never be permitted to exceed the whole project budget.
  if (env.MAX_SINGLE_CALL_USD > env.MAX_BUDGET_USD) {
    throw new Error(
      `MAX_SINGLE_CALL_USD (${env.MAX_SINGLE_CALL_USD}) exceeds ` +
        `MAX_BUDGET_USD (${env.MAX_BUDGET_USD}). One call could consume the entire budget.`,
    );
  }

  cached = {
    ...env,
    ffmpegBin: env.FFMPEG_PATH || 'ffmpeg',
    ffprobeBin: env.FFPROBE_PATH || 'ffprobe',
    hasHiggsfieldCredentials:
      env.HIGGSFIELD_API_KEY.length > 0 && env.HIGGSFIELD_API_SECRET.length > 0,
  };

  return cached;
}

/** Reset the cache. Tests only. */
export function resetEnvCache(): void {
  cached = null;
}

/** True when a .env exists at the project root. */
export function envFileExists(): boolean {
  return existsSync(resolve(process.cwd(), '.env'));
}
