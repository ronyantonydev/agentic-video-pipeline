/**
 * The budget guard. Architecture section 19, rule 3.
 *
 *   current spend + expected call cost <= maxBudgetUSD
 *
 * This runs before EVERY paid call - first generation, retries, escalated
 * models, paid images, paid audio. Not only at the approval gate.
 *
 * The guard reserves before spending and settles afterwards, so two
 * concurrent jobs cannot each see the same headroom and both proceed.
 */

import { HardStop } from '../util/errors.js';
import { log } from '../util/logger.js';
import { readState, updateState } from '../state/store.js';
import { totalSpend } from '../manifest/store.js';
import type { ResolvedCost } from './cost.js';
import type { State } from '../schemas/state.js';

const EPSILON = 1e-6;

export type SpendAuthorization = {
  approved: true;
  costUSD: number;
  costCredits: number;
  remainingUSD: number;
  /** Release the reservation once the call settles. */
  reservationId: string;
};

export type BudgetSnapshot = {
  maxBudgetUSD: number;
  spentUSD: number;
  reservedUSD: number;
  availableUSD: number;
  creditsRemaining: number | null;
  unpricedEntries: string[];
};

export function budgetSnapshot(project: string): BudgetSnapshot {
  const state = readState(project);
  const manifest = totalSpend(project);

  // The manifest is the source of truth for what has been committed; state
  // mirrors it. Take the higher of the two so a lagging state file cannot
  // understate spend.
  const spentUSD = Math.max(state.budget.spentUSD, manifest.usd);

  return {
    maxBudgetUSD: state.budget.maxBudgetUSD,
    spentUSD,
    reservedUSD: state.budget.reservedUSD,
    availableUSD: Math.max(0, state.budget.maxBudgetUSD - spentUSD - state.budget.reservedUSD),
    creditsRemaining: state.budget.creditsRemaining,
    unpricedEntries: manifest.unpricedEntries,
  };
}

/**
 * Authorize one paid call, reserving its cost.
 *
 * @throws HardStop when the call would breach the project budget, the
 *         per-call ceiling, or the credit floor.
 */
export function authorizeSpend(
  project: string,
  cost: ResolvedCost,
  opts: {
    maxSingleCallUSD: number;
    stopOnCreditsBelow?: number;
    description?: string;
  },
): SpendAuthorization {
  const snapshot = budgetSnapshot(project);
  const label = opts.description ?? 'generation';

  // An unpriced chargeable entry means we cannot know true spend, so we
  // cannot know whether this call fits. Refuse rather than approximate.
  if (snapshot.unpricedEntries.length > 0) {
    throw new HardStop(
      `Cannot authorize "${label}": ${snapshot.unpricedEntries.length} manifest ` +
        `entr${snapshot.unpricedEntries.length === 1 ? 'y has' : 'ies have'} no recorded cost, ` +
        `so total spend is unknown.`,
      { spentUSD: snapshot.spentUSD, maxBudgetUSD: snapshot.maxBudgetUSD },
    );
  }

  if (cost.usd > opts.maxSingleCallUSD + EPSILON) {
    throw new HardStop(
      `"${label}" costs $${cost.usd.toFixed(2)}, above the per-call ceiling of ` +
        `$${opts.maxSingleCallUSD.toFixed(2)}. Reduce duration or resolution.`,
      { attemptedUSD: cost.usd, maxBudgetUSD: snapshot.maxBudgetUSD },
    );
  }

  const projected = snapshot.spentUSD + snapshot.reservedUSD + cost.usd;
  if (projected > snapshot.maxBudgetUSD + EPSILON) {
    throw new HardStop(
      `"${label}" would take spend to $${projected.toFixed(2)}, over the ` +
        `$${snapshot.maxBudgetUSD.toFixed(2)} budget. ` +
        `Spent $${snapshot.spentUSD.toFixed(2)}, reserved $${snapshot.reservedUSD.toFixed(2)}.`,
      {
        spentUSD: snapshot.spentUSD,
        attemptedUSD: cost.usd,
        maxBudgetUSD: snapshot.maxBudgetUSD,
      },
    );
  }

  const floor = opts.stopOnCreditsBelow;
  if (
    floor !== undefined &&
    snapshot.creditsRemaining !== null &&
    snapshot.creditsRemaining - cost.credits < floor
  ) {
    throw new HardStop(
      `"${label}" needs ${cost.credits} credits, which would drop the balance ` +
        `below the ${floor}-credit floor (${snapshot.creditsRemaining} remaining).`,
      { creditsRemaining: snapshot.creditsRemaining, attemptedUSD: cost.usd },
    );
  }

  const reservationId = `res_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

  updateState(project, (s) => ({
    ...s,
    budget: { ...s.budget, reservedUSD: round4(s.budget.reservedUSD + cost.usd) },
  }));

  log.money(`Authorized ${label}: $${cost.usd.toFixed(2)} (${cost.credits} credits)`, {
    source: cost.source,
    remaining: round2(snapshot.availableUSD - cost.usd),
  });

  return {
    approved: true,
    costUSD: cost.usd,
    costCredits: cost.credits,
    remainingUSD: round2(snapshot.availableUSD - cost.usd),
    reservationId,
  };
}

/**
 * Convert a reservation into actual spend once the call succeeds.
 * `actualUSD` may differ from the estimate; the actual figure wins.
 */
export function settleSpend(
  project: string,
  auth: SpendAuthorization,
  actual: { usd: number; credits: number },
): State {
  return updateState(project, (s) => ({
    ...s,
    budget: {
      ...s.budget,
      reservedUSD: round4(Math.max(0, s.budget.reservedUSD - auth.costUSD)),
      spentUSD: round4(s.budget.spentUSD + actual.usd),
      creditsUsed: round4(s.budget.creditsUsed + actual.credits),
      creditsRemaining:
        s.budget.creditsRemaining === null
          ? null
          : Math.max(0, round4(s.budget.creditsRemaining - actual.credits)),
    },
  }));
}

/**
 * Release a reservation without spending - the call failed or was cancelled.
 * Higgsfield does not charge for failed generations, so nothing is deducted.
 */
export function releaseReservation(project: string, auth: SpendAuthorization): State {
  return updateState(project, (s) => ({
    ...s,
    budget: {
      ...s.budget,
      reservedUSD: round4(Math.max(0, s.budget.reservedUSD - auth.costUSD)),
    },
  }));
}

/** Record the starting credit balance, so usage can be measured against it. */
export function recordCreditBaseline(project: string, credits: number): State {
  return updateState(project, (s) => ({
    ...s,
    budget: {
      ...s.budget,
      creditsStart: s.budget.creditsStart ?? credits,
      creditsRemaining: credits,
    },
  }));
}

/**
 * Would this total fit? Used by cost estimation and the dry run, which must
 * report over-budget plans without throwing mid-report.
 */
export function wouldFitInBudget(
  project: string,
  totalUSD: number,
): { fits: boolean; snapshot: BudgetSnapshot; overageUSD: number } {
  const snapshot = budgetSnapshot(project);
  const projected = snapshot.spentUSD + snapshot.reservedUSD + totalUSD;
  return {
    fits: projected <= snapshot.maxBudgetUSD + EPSILON,
    snapshot,
    overageUSD: Math.max(0, round2(projected - snapshot.maxBudgetUSD)),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
