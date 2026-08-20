/**
 * Budget-driven model selection.
 *
 * Given a runtime and a budget, work out which model the project can afford
 * and how many shots fit. Quality is traded down deliberately and visibly,
 * never silently - the caller is told exactly what tier it landed on and
 * what it gives up.
 *
 * The QA layer is what makes this safe: a cheaper model produces weaker
 * footage, but machine QA still rejects anything corrupt, blank or frozen,
 * and vision QA still flags continuity breaks. Low budget lowers the
 * ceiling, not the floor.
 */

import { creditsToUsd, usdToCredits } from './cost.js';

export type ModelTier = {
  id: string;
  label: string;
  creditsPerSecond: number;
  /** Accepts image_references - required to hold a character across shots. */
  holdsIdentity: boolean;
  nativeAudio: boolean;
  maxResolution: string;
  /** Allowed clip lengths in seconds. */
  minSeconds: number;
  maxSeconds: number;
  notes: string;
};

/**
 * Measured rates, not published ones. Every figure here came from the
 * transaction log after a real generation.
 */
export const TIERS: ModelTier[] = [
  {
    id: 'seedance_2_0_mini',
    label: 'Seedance 2.0 Mini',
    creditsPerSecond: 2.5,
    holdsIdentity: true,
    nativeAudio: true,
    maxResolution: '720p',
    minSeconds: 4,
    maxSeconds: 15,
    notes: 'Identity references + native audio. The quality/price sweet spot.',
  },
  {
    id: 'kling3_0',
    label: 'Kling 3.0',
    creditsPerSecond: 1.5,
    holdsIdentity: false,
    nativeAudio: true,
    maxResolution: '720p',
    minSeconds: 3,
    maxSeconds: 15,
    notes:
      'Cheaper, but has no identity-reference slot - a recurring character ' +
      'will drift between shots. Fine for landscapes, objects and tools.',
  },
  {
    id: 'seedance_2_0',
    label: 'Seedance 2.0 (1080p)',
    creditsPerSecond: 9,
    holdsIdentity: true,
    nativeAudio: true,
    maxResolution: '1080p',
    minSeconds: 4,
    maxSeconds: 15,
    notes: 'Native 1080p, no upscaling. Roughly 3.5x the cost of Mini.',
  },
];

export type FitRequest = {
  runtimeSeconds: number;
  budgetUSD: number;
  /** True when a person appears across multiple shots. */
  needsCharacterConsistency: boolean;
  /** Reserve for reference images, retries and the odd rejected shot. */
  overheadFraction?: number;
};

export type FitOption = {
  tier: ModelTier;
  affordableSeconds: number;
  /** Runtime actually achievable, capped by the request. */
  plannedSeconds: number;
  shotCount: number;
  averageShotSeconds: number;
  estimatedCredits: number;
  estimatedUSD: number;
  fitsRequestedRuntime: boolean;
  warnings: string[];
};

export type FitResult = {
  /** Best option that meets the constraints, or null when nothing fits. */
  recommended: FitOption | null;
  options: FitOption[];
  budgetCredits: number;
  shortfall: string | null;
};

const DEFAULT_OVERHEAD = 0.12;

/**
 * Work out what the budget buys.
 *
 * Options are returned for every tier so the caller can see the trade, not
 * just the winner.
 */
export function fitToBudget(req: FitRequest): FitResult {
  const overhead = req.overheadFraction ?? DEFAULT_OVERHEAD;
  const budgetCredits = usdToCredits(req.budgetUSD);
  const generationCredits = budgetCredits * (1 - overhead);

  const options: FitOption[] = TIERS.map((tier) => {
    const affordableSeconds = Math.floor(generationCredits / tier.creditsPerSecond);
    const plannedSeconds = Math.min(affordableSeconds, req.runtimeSeconds);

    // Aim for shots around 6s: long enough to read, short enough that a
    // single weak generation costs little.
    const targetShot = 6;
    const shotCount = Math.max(1, Math.round(plannedSeconds / targetShot));
    const averageShotSeconds = shotCount > 0 ? plannedSeconds / shotCount : 0;

    const warnings: string[] = [];
    if (req.needsCharacterConsistency && !tier.holdsIdentity) {
      warnings.push(
        'no identity references: a recurring character will change appearance between shots',
      );
    }
    if (averageShotSeconds < tier.minSeconds && plannedSeconds > 0) {
      warnings.push(
        `average shot ${averageShotSeconds.toFixed(1)}s is below this model's ` +
          `${tier.minSeconds}s minimum, so short shots will be billed at the floor`,
      );
    }
    if (plannedSeconds < req.runtimeSeconds) {
      warnings.push(
        `budget covers ${plannedSeconds}s of the ${req.runtimeSeconds}s requested`,
      );
    }

    const estimatedCredits = round2(plannedSeconds * tier.creditsPerSecond);

    return {
      tier,
      affordableSeconds,
      plannedSeconds,
      shotCount,
      averageShotSeconds: round2(averageShotSeconds),
      estimatedCredits,
      estimatedUSD: creditsToUsd(estimatedCredits),
      fitsRequestedRuntime: plannedSeconds >= req.runtimeSeconds,
      warnings,
    };
  });

  // Prefer: covers the runtime, holds identity when needed, then best quality
  // per credit. A cheaper tier that drops identity is only chosen when the
  // caller said consistency does not matter.
  const viable = options.filter(
    (o) => o.plannedSeconds > 0 && (!req.needsCharacterConsistency || o.tier.holdsIdentity),
  );

  const ranked = [...viable].sort((a, b) => {
    if (a.fitsRequestedRuntime !== b.fitsRequestedRuntime) {
      return a.fitsRequestedRuntime ? -1 : 1;
    }
    // Among those that fit, prefer the higher-quality (dearer) tier;
    // among those that do not, prefer whichever buys the most runtime.
    return a.fitsRequestedRuntime
      ? b.tier.creditsPerSecond - a.tier.creditsPerSecond
      : b.plannedSeconds - a.plannedSeconds;
  });

  const recommended = ranked[0] ?? null;

  let shortfall: string | null = null;
  if (!recommended) {
    shortfall = req.needsCharacterConsistency
      ? 'No identity-capable model fits this budget. Either raise the budget or ' +
        'accept a changing character by setting needsCharacterConsistency to false.'
      : 'Budget is too small for any model.';
  } else if (!recommended.fitsRequestedRuntime) {
    const needed = creditsToUsd(req.runtimeSeconds * recommended.tier.creditsPerSecond);
    shortfall =
      `${req.runtimeSeconds}s on ${recommended.tier.label} needs about ` +
      `$${needed.toFixed(2)}. At $${req.budgetUSD.toFixed(2)} you get ` +
      `${recommended.plannedSeconds}s.`;
  }

  return { recommended, options, budgetCredits, shortfall };
}

export function formatFit(result: FitResult, req: FitRequest): string {
  const lines: string[] = [];
  lines.push(
    `  Budget $${req.budgetUSD.toFixed(2)} = ${result.budgetCredits.toFixed(0)} credits ` +
      `(${((req.overheadFraction ?? DEFAULT_OVERHEAD) * 100).toFixed(0)}% held back for ` +
      `reference images and retries)`,
    '',
  );

  for (const o of result.options) {
    const mark = o === result.recommended ? '→' : ' ';
    lines.push(
      `${mark} ${o.tier.label.padEnd(22)} ${String(o.plannedSeconds).padStart(4)}s  ` +
        `${String(o.shotCount).padStart(3)} shots  ${o.estimatedCredits.toFixed(0).padStart(5)}cr  ` +
        `$${o.estimatedUSD.toFixed(2)}`,
    );
    for (const w of o.warnings) lines.push(`    ! ${w}`);
  }

  if (result.shortfall) lines.push('', `  ${result.shortfall}`);
  return lines.join('\n');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
