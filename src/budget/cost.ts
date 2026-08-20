/**
 * Cost resolution. The single place a price is established.
 *
 * Resolution order, strictest first:
 *   1. Higgsfield estimate endpoint - exact, authoritative
 *   2. Learned cost from a prior identical configuration - measured
 *   3. config costCredits - measured previously, settings unknown
 *   4. refuse
 *
 * There is deliberately no "guess" tier. An invented price that passes a
 * budget check spends real money.
 */

import { estimateCost } from '../higgsfield/client.js';
import { loadModels, type ModelsConfig } from '../config/loader.js';
import { UnknownCostError } from '../util/errors.js';
import { log } from '../util/logger.js';
import { readJsonIfExists, writeJsonAtomic } from '../util/atomic.js';
import { paths } from '../state/paths.js';
import { createHash } from 'node:crypto';

export type CostSource = 'estimate-api' | 'learned' | 'config' | 'none';

export type ResolvedCost = {
  credits: number;
  usd: number;
  source: CostSource;
  /** True when the value came from a live quote rather than history. */
  exact: boolean;
  /** Set when the figure sits outside the published sanity band. */
  sanityWarning?: string;
};

export type CostQuery = {
  modelId: string;
  kind: 'video' | 'image' | 'audio';
  prompt?: string;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
  settings?: Record<string, unknown>;
};

/* ------------------------------------------------------------- learned db */

type LearnedEntry = {
  configHash: string;
  modelId: string;
  credits: number;
  usd: number | null;
  measuredAt: string;
  note: string;
};

type LearnedDb = { version: 1; entries: LearnedEntry[] };

function learnedPath(project: string): string {
  return paths(project).planningFile('../checkpoints/learned-costs.json');
}

/** Identity of a priced configuration - anything affecting price. */
export function configHash(q: CostQuery): string {
  const canonical = JSON.stringify({
    modelId: q.modelId,
    kind: q.kind,
    duration: q.durationSeconds ?? null,
    aspectRatio: q.aspectRatio ?? null,
    resolution: q.resolution ?? null,
    settings: sortKeys(q.settings ?? {}),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

export function readLearned(project: string): LearnedDb {
  return readJsonIfExists<LearnedDb>(learnedPath(project), { version: 1, entries: [] });
}

/**
 * Record a measured cost. Called after a real generation settles, using the
 * observed credit delta. Architecture: prices are measured, never assumed.
 */
export function recordLearnedCost(
  project: string,
  q: CostQuery,
  credits: number,
  usd: number | null,
  note = 'measured from balance delta',
): void {
  const db = readLearned(project);
  const hash = configHash(q);
  const entry: LearnedEntry = {
    configHash: hash,
    modelId: q.modelId,
    credits,
    usd,
    measuredAt: new Date().toISOString(),
    note,
  };
  const entries = db.entries.filter((e) => e.configHash !== hash);
  writeJsonAtomic(learnedPath(project), { version: 1, entries: [...entries, entry] });
  log.info(`Learned cost for ${q.modelId}: ${credits} credits`, { configHash: hash });
}

function lookupLearned(project: string, q: CostQuery): LearnedEntry | undefined {
  return readLearned(project).entries.find((e) => e.configHash === configHash(q));
}

/* ------------------------------------------------------------ conversion */

export function creditsToUsd(credits: number, cfg: ModelsConfig = loadModels()): number {
  return round2(credits * cfg.creditToUsd.rate);
}

export function usdToCredits(usd: number, cfg: ModelsConfig = loadModels()): number {
  return Math.round((usd / cfg.creditToUsd.rate) * 1000) / 1000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* --------------------------------------------------------- sanity checking */

/**
 * Compare against published third-party ranges. This never approves a cost -
 * it only flags a figure that looks wrong, so a mis-parsed response cannot
 * quietly become a large charge.
 */
export function sanityCheck(
  q: CostQuery,
  credits: number,
  cfg: ModelsConfig = loadModels(),
): string | undefined {
  const bands = cfg.sanityRangeCredits;

  let band = bands.image;
  let label = 'image';
  if (q.kind === 'audio') {
    band = bands.audio;
    label = 'audio';
  } else if (q.kind === 'video') {
    const model = cfg.video.find((m) => m.id === q.modelId);
    const premium = model?.qualityTier === 'quality';
    band = premium ? bands.videoPremium : bands.videoBudget;
    label = premium ? 'premium video' : 'budget video';
  }

  if (credits < band.min || credits > band.max) {
    return (
      `${credits} credits for ${q.modelId} is outside the expected ${label} ` +
      `range (${band.min}-${band.max}). Verify before spending.`
    );
  }
  return undefined;
}

/* ---------------------------------------------------------------- resolve */

/**
 * Establish the cost of one generation.
 *
 * @throws UnknownCostError when no trusted source yields a price.
 */
export async function resolveCost(
  project: string,
  q: CostQuery,
  opts: { allowApi?: boolean } = {},
): Promise<ResolvedCost> {
  const cfg = loadModels();
  const allowApi = opts.allowApi ?? true;

  // 1. Live quote.
  if (allowApi) {
    const estimate = await estimateCost({
      model: q.modelId,
      kind: q.kind,
      ...(q.prompt !== undefined ? { prompt: q.prompt } : {}),
      ...(q.durationSeconds !== undefined ? { durationSeconds: q.durationSeconds } : {}),
      ...(q.aspectRatio !== undefined ? { aspectRatio: q.aspectRatio } : {}),
      ...(q.resolution !== undefined ? { resolution: q.resolution } : {}),
      ...(q.settings !== undefined ? { settings: q.settings } : {}),
    });

    if (estimate && (estimate.credits !== null || estimate.usd !== null)) {
      // Derive whichever unit is missing rather than defaulting it to zero:
      // a zero would silently pass both the budget and credit-floor checks.
      const credits = estimate.credits ?? usdToCredits(estimate.usd!, cfg);
      const usd = estimate.usd ?? creditsToUsd(credits, cfg);
      const warning = sanityCheck(q, credits, cfg);
      if (warning) log.warn(warning);
      return {
        credits,
        usd,
        source: 'estimate-api',
        exact: true,
        ...(warning ? { sanityWarning: warning } : {}),
      };
    }
  }

  // 2. Measured from a prior identical configuration.
  const learned = lookupLearned(project, q);
  if (learned) {
    const usd = learned.usd ?? creditsToUsd(learned.credits, cfg);
    return { credits: learned.credits, usd, source: 'learned', exact: true };
  }

  // 3. Config-level cost: measured, but settings were not recorded, so it is
  //    a weaker signal than a matching learned entry.
  const configured = findConfiguredCost(cfg, q.modelId);
  if (configured !== null) {
    const warning = sanityCheck(q, configured, cfg);
    return {
      credits: configured,
      usd: creditsToUsd(configured, cfg),
      source: 'config',
      exact: false,
      ...(warning ? { sanityWarning: warning } : {}),
    };
  }

  // 4. Refuse.
  throw new UnknownCostError(
    q.modelId,
    'no estimate from the API, no learned cost for this configuration, ' +
      'and no measured cost in config/models.json',
  );
}

function findConfiguredCost(cfg: ModelsConfig, modelId: string): number | null {
  const model =
    cfg.video.find((m) => m.id === modelId) ??
    cfg.image.find((m) => m.id === modelId) ??
    cfg.audio.find((m) => m.id === modelId);
  return model?.costCredits ?? null;
}
