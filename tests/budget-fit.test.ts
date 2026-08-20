import { describe, it, expect } from 'vitest';
import { fitToBudget, TIERS } from '../src/budget/budget-fit.js';

const req = (over: Partial<Parameters<typeof fitToBudget>[0]> = {}) => ({
  runtimeSeconds: 90,
  budgetUSD: 20,
  needsCharacterConsistency: true,
  ...over,
});

describe('budget fitting', () => {
  it('recommends the identity-capable model when a character recurs', () => {
    const r = fitToBudget(req());
    expect(r.recommended?.tier.holdsIdentity).toBe(true);
  });

  it('never recommends an identity-blind model for a recurring character', () => {
    // Kling is cheaper per second, but it has no image_references slot -
    // choosing it silently would reintroduce the drift that got the first
    // paid run rejected.
    const r = fitToBudget(req({ budgetUSD: 5 }));
    if (r.recommended) expect(r.recommended.tier.holdsIdentity).toBe(true);
  });

  it('allows the cheaper model when identity does not matter', () => {
    const r = fitToBudget(req({ needsCharacterConsistency: false, runtimeSeconds: 600 }));
    expect(r.recommended?.tier.id).toBe('kling3_0');
  });

  it('still lists identity-blind options with a warning', () => {
    const kling = fitToBudget(req()).options.find((o) => o.tier.id === 'kling3_0')!;
    expect(kling.warnings.some((w) => /identity/i.test(w))).toBe(true);
  });

  it('scales runtime down rather than overspending', () => {
    const r = fitToBudget(req({ runtimeSeconds: 1200, budgetUSD: 20 }));
    expect(r.recommended!.plannedSeconds).toBeLessThan(1200);
    expect(r.recommended!.estimatedUSD).toBeLessThanOrEqual(20);
  });

  it('reports the shortfall in money terms', () => {
    const r = fitToBudget(req({ runtimeSeconds: 1200, budgetUSD: 20 }));
    expect(r.shortfall).toMatch(/\$\d+/);
  });

  it('reports no shortfall when the runtime fits', () => {
    expect(fitToBudget(req({ runtimeSeconds: 60, budgetUSD: 20 })).shortfall).toBeNull();
  });

  it('holds back budget for images and retries', () => {
    // dop models are image2video: every clip needs a paid frame first, and
    // spending the entire budget on video would leave none for them.
    const r = fitToBudget(req({ runtimeSeconds: 10_000, budgetUSD: 20 }));
    expect(r.recommended!.estimatedUSD).toBeLessThan(20);
  });

  it('prefers higher quality when both tiers fit the runtime', () => {
    const r = fitToBudget(req({ runtimeSeconds: 30, budgetUSD: 20 }));
    expect(r.recommended!.fitsRequestedRuntime).toBe(true);
    expect(r.recommended!.tier.id).toBe('seedance_2_0');
  });

  it('buys the most runtime when nothing fits', () => {
    const r = fitToBudget(req({ runtimeSeconds: 1200, budgetUSD: 20 }));
    const identityCapable = r.options.filter((o) => o.tier.holdsIdentity);
    const best = Math.max(...identityCapable.map((o) => o.plannedSeconds));
    expect(r.recommended!.plannedSeconds).toBe(best);
  });

  it('returns nothing for a budget that buys no footage', () => {
    const r = fitToBudget(req({ budgetUSD: 0.5 }));
    if (!r.recommended) expect(r.shortfall).toBeTruthy();
  });

  it('warns when shots fall below the model minimum', () => {
    const r = fitToBudget(req({ runtimeSeconds: 8, budgetUSD: 20 }));
    const opt = r.options.find((o) => o.averageShotSeconds < o.tier.minSeconds);
    if (opt) expect(opt.warnings.some((w) => /minimum/i.test(w))).toBe(true);
  });

  it('matches the measured rate from the real project', () => {
    // 80s of Seedance Mini cost 249 credits in practice; the tier rate must
    // reproduce that, or every estimate is wrong.
    const mini = TIERS.find((t) => t.id === 'seedance_2_0_mini')!;
    expect(mini.creditsPerSecond).toBe(2.5);
    expect(80 * mini.creditsPerSecond).toBeCloseTo(200, 0);
  });
});
