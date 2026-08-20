import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authorizeSpend, settleSpend, releaseReservation, budgetSnapshot,
  recordCreditBaseline, wouldFitInBudget,
} from '../src/budget/guard.js';
import { resolveCost, recordLearnedCost, readLearned, configHash, creditsToUsd, usdToCredits, sanityCheck } from '../src/budget/cost.js';
import { parseEstimate } from '../src/higgsfield/client.js';
import { writeState, readState } from '../src/state/store.js';
import { appendEntry } from '../src/manifest/store.js';
import { ensureProjectDirs } from '../src/state/paths.js';
import { emptyState, type ManifestEntry } from '../src/schemas/state.js';
import { HardStop, UnknownCostError } from '../src/util/errors.js';
import type { ResolvedCost } from '../src/budget/cost.js';

const SETTINGS = { width: 1920, height: 1080, fps: 30, colorspace: 'bt709', aspectRatio: '16:9' };
const PROJECT = 'budget-test';

let cwd: string;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'avp-budget-'));
  cwd = process.cwd();
  process.chdir(tmp);
  ensureProjectDirs(PROJECT);
  writeState(PROJECT, emptyState({
    projectName: PROJECT, idea: 'test', mode: 'full',
    maxBudgetUSD: 20, projectSettings: SETTINGS,
  }));
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
});

const cost = (usd: number, credits = usd * 16): ResolvedCost =>
  ({ credits, usd, source: 'estimate-api', exact: true });

const OPTS = { maxSingleCallUSD: 3, description: 'test shot' };

describe('budget guard - authorization', () => {
  it('approves a call within budget', () => {
    const auth = authorizeSpend(PROJECT, cost(2), OPTS);
    expect(auth.approved).toBe(true);
    expect(auth.costUSD).toBe(2);
  });

  it('reserves the cost so concurrent calls see reduced headroom', () => {
    authorizeSpend(PROJECT, cost(2), OPTS);
    expect(budgetSnapshot(PROJECT).reservedUSD).toBe(2);
    expect(budgetSnapshot(PROJECT).availableUSD).toBe(18);
  });

  it('refuses a call above the per-call ceiling', () => {
    // Guards against one runaway call (4k x 30s) eating most of the budget.
    expect(() => authorizeSpend(PROJECT, cost(5), OPTS)).toThrow(HardStop);
  });

  it('refuses a call that would breach the total budget', () => {
    // Six $3 calls reserve $18. The seventh would reach $21 against a $20
    // ceiling, so it must be refused rather than partially approved.
    for (let i = 0; i < 6; i++) authorizeSpend(PROJECT, cost(3), OPTS);
    expect(budgetSnapshot(PROJECT).reservedUSD).toBe(18);
    expect(() => authorizeSpend(PROJECT, cost(3), OPTS)).toThrow(HardStop);
    // The refused call must not have been reserved.
    expect(budgetSnapshot(PROJECT).reservedUSD).toBe(18);
  });

  it('counts reservations, so parallel jobs cannot both take the last slot', () => {
    // Without reservation both would see $20 available and both proceed.
    authorizeSpend(PROJECT, cost(3), OPTS);
    authorizeSpend(PROJECT, cost(3), OPTS);
    const snap = budgetSnapshot(PROJECT);
    expect(snap.reservedUSD).toBe(6);
    expect(snap.availableUSD).toBe(14);
  });

  it('allows spend exactly at the ceiling', () => {
    for (let i = 0; i < 6; i++) authorizeSpend(PROJECT, cost(3), OPTS);
    expect(() => authorizeSpend(PROJECT, cost(2), OPTS)).not.toThrow();
    expect(budgetSnapshot(PROJECT).availableUSD).toBe(0);
  });

  it('refuses when a manifest entry has no recorded cost', () => {
    // Unknown spend means unknown headroom - approximating here would be
    // exactly the bug the manifest accounting fix guards against.
    const entry: ManifestEntry = {
      assetHash: 'a'.repeat(16), kind: 'video', provider: 'Kling', model: 'kling3_0',
      prompt: 'x', settings: {}, submittedAt: new Date().toISOString(),
      estimatedCredits: null, estimatedUSD: null, actualCredits: null, actualUSD: null,
      status: 'completed', accepted: null,
    };
    appendEntry(PROJECT, entry);
    expect(() => authorizeSpend(PROJECT, cost(1), OPTS)).toThrow(HardStop);
  });

  it('enforces a credit floor independently of the dollar budget', () => {
    recordCreditBaseline(PROJECT, 100);
    expect(() =>
      authorizeSpend(PROJECT, cost(1, 80), { ...OPTS, stopOnCreditsBelow: 50 }),
    ).toThrow(HardStop);
  });

  it('allows a call that keeps credits above the floor', () => {
    recordCreditBaseline(PROJECT, 1385);
    expect(() =>
      authorizeSpend(PROJECT, cost(1, 45), { ...OPTS, stopOnCreditsBelow: 50 }),
    ).not.toThrow();
  });
});

describe('budget guard - settlement', () => {
  it('converts a reservation into spend', () => {
    const auth = authorizeSpend(PROJECT, cost(2), OPTS);
    settleSpend(PROJECT, auth, { usd: 2, credits: 32 });
    const snap = budgetSnapshot(PROJECT);
    expect(snap.spentUSD).toBe(2);
    expect(snap.reservedUSD).toBe(0);
  });

  it('records the actual cost when it differs from the estimate', () => {
    const auth = authorizeSpend(PROJECT, cost(2), OPTS);
    settleSpend(PROJECT, auth, { usd: 2.4, credits: 38 });
    expect(budgetSnapshot(PROJECT).spentUSD).toBe(2.4);
  });

  it('releases a reservation without spending when a call fails', () => {
    // Higgsfield does not charge for failed generations.
    const auth = authorizeSpend(PROJECT, cost(2), OPTS);
    releaseReservation(PROJECT, auth);
    const snap = budgetSnapshot(PROJECT);
    expect(snap.reservedUSD).toBe(0);
    expect(snap.spentUSD).toBe(0);
  });

  it('decrements the credit balance on settlement', () => {
    recordCreditBaseline(PROJECT, 1385);
    const auth = authorizeSpend(PROJECT, cost(2, 45), OPTS);
    settleSpend(PROJECT, auth, { usd: 2, credits: 45 });
    expect(readState(PROJECT).budget.creditsRemaining).toBe(1340);
    expect(readState(PROJECT).budget.creditsUsed).toBe(45);
  });

  it('keeps the reservation ledger non-negative under repeated release', () => {
    const auth = authorizeSpend(PROJECT, cost(2), OPTS);
    releaseReservation(PROJECT, auth);
    releaseReservation(PROJECT, auth);
    expect(budgetSnapshot(PROJECT).reservedUSD).toBe(0);
  });
});

describe('budget projection', () => {
  it('reports whether a whole plan fits without throwing', () => {
    const fit = wouldFitInBudget(PROJECT, 15);
    expect(fit.fits).toBe(true);
    expect(fit.overageUSD).toBe(0);
  });

  it('reports overage for an over-budget plan', () => {
    const fit = wouldFitInBudget(PROJECT, 32);
    expect(fit.fits).toBe(false);
    expect(fit.overageUSD).toBe(12);
  });
});

describe('cost resolution', () => {
  const query = { modelId: 'seedance_2_0', kind: 'video' as const, durationSeconds: 5 };

  it('refuses rather than guessing when nothing is known', async () => {
    await expect(
      resolveCost(PROJECT, { modelId: 'unknown_model', kind: 'video' }, { allowApi: false }),
    ).rejects.toThrow(UnknownCostError);
  });

  it('uses a measured cost from config when present', async () => {
    const r = await resolveCost(PROJECT, query, { allowApi: false });
    expect(r.credits).toBe(45);
    expect(r.source).toBe('config');
    expect(r.exact).toBe(false);
  });

  it('prefers a learned cost over the config value', async () => {
    recordLearnedCost(PROJECT, query, 38, 2.38);
    const r = await resolveCost(PROJECT, query, { allowApi: false });
    expect(r.credits).toBe(38);
    expect(r.source).toBe('learned');
    expect(r.exact).toBe(true);
  });

  it('keys learned costs by configuration, not just model', async () => {
    // A 15s clip must not inherit the price of a 5s clip.
    recordLearnedCost(PROJECT, { ...query, durationSeconds: 5 }, 38, 2.38);
    const long = { ...query, durationSeconds: 15 };
    expect(configHash(long)).not.toBe(configHash(query));
    const r = await resolveCost(PROJECT, long, { allowApi: false });
    expect(r.source).toBe('config');
  });

  it('overwrites rather than duplicates a re-measured cost', () => {
    recordLearnedCost(PROJECT, query, 38, 2.38);
    recordLearnedCost(PROJECT, query, 42, 2.63);
    const db = readLearned(PROJECT);
    expect(db.entries.filter((e) => e.modelId === 'seedance_2_0')).toHaveLength(1);
    expect(db.entries[0]?.credits).toBe(42);
  });

  it('converts credits to USD at the configured rate', () => {
    expect(creditsToUsd(45)).toBeCloseTo(2.82, 2);
  });
});

describe('sanity checking', () => {
  it('flags a premium-video price far outside the published band', () => {
    const warning = sanityCheck({ modelId: 'kling3_0', kind: 'video' }, 5000);
    expect(warning).toMatch(/outside the expected/i);
  });

  it('accepts a plausible premium price', () => {
    expect(sanityCheck({ modelId: 'kling3_0', kind: 'video' }, 45)).toBeUndefined();
  });

  it('flags an implausible image price', () => {
    expect(sanityCheck({ modelId: 'nano_banana', kind: 'image' }, 500)).toBeDefined();
  });
});

describe('estimate response parsing', () => {
  it('reads the documented shape', () => {
    const r = parseEstimate(JSON.stringify({ credits: 1.5, usd: 0.094 }));
    expect(r?.credits).toBe(1.5);
    expect(r?.usd).toBe(0.094);
  });

  it('reads a nested estimate object', () => {
    const r = parseEstimate(JSON.stringify({ estimate: { cost_credits: 45, cost_usd: 2.82 } }));
    expect(r?.credits).toBe(45);
  });

  it('accepts numeric strings', () => {
    expect(parseEstimate(JSON.stringify({ credits: '45' }))?.credits).toBe(45);
  });

  it('returns null for an unrecognised shape rather than assuming zero', () => {
    expect(parseEstimate(JSON.stringify({ status: 'ok' }))).toBeNull();
    expect(parseEstimate('not json')).toBeNull();
  });

  it('rejects a zero cost as a likely parse miss', () => {
    // A paid endpoint reporting 0 is more likely a field-name mismatch than
    // a free generation; treating it as free would defeat the budget check.
    expect(parseEstimate(JSON.stringify({ credits: 0, usd: 0 }))).toBeNull();
  });

  it('leaves missing credits null rather than reporting zero', () => {
    // Defaulting to 0 credits would silently pass the credit-floor check.
    const r = parseEstimate(JSON.stringify({ usd: 0.094 }));
    expect(r?.credits).toBeNull();
    expect(r?.usd).toBe(0.094);
  });

  it('matches the real documented response shape', () => {
    // Verified live: POST /estimate/higgsfield-ai/soul/standard
    const r = parseEstimate(JSON.stringify({ credits: '1.500', usd: '0.094' }));
    expect(r?.credits).toBe(1.5);
    expect(r?.usd).toBe(0.094);
  });
});

describe('unit conversion', () => {
  it('round-trips credits through USD', () => {
    expect(usdToCredits(creditsToUsd(45))).toBeCloseTo(45, 0);
  });

  it('derives credits when the API returns only USD', () => {
    expect(usdToCredits(0.094)).toBeCloseTo(1.5, 1);
  });
});
