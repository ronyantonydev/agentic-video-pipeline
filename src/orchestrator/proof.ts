/**
 * Proof run. Architecture section 25.
 *
 * ~15 seconds, ~3 shots, but using the real production model, resolution,
 * prompt process, references and QA path. It validates the technical
 * pipeline and the visual quality together.
 *
 * Proof assets live in the SAME project and manifest as the full video, so
 * accepted proof shots are reused rather than regenerated.
 */

import { validateArtifact } from '../planning/validate.js';
import { resolveCost } from '../budget/cost.js';
import { budgetSnapshot } from '../budget/guard.js';
import { loadProjectDefaults } from '../config/loader.js';
import { findReusable, computeAssetHash } from '../manifest/store.js';
import type { GenerationItem } from '../schemas/planning.js';

export type ProofPlan = {
  items: ProofItem[];
  totalCredits: number;
  totalUSD: number;
  totalSeconds: number;
  budgetRemainingUSD: number;
  alreadyPaid: string[];
};

export type ProofItem = {
  item: GenerationItem;
  /** The reference image this shot animates from. */
  needsStartImage: boolean;
  needsEndImage: boolean;
  imageCostCredits: number;
  imageCostUSD: number;
  videoCostCredits: number;
  videoCostUSD: number;
};

/**
 * Select the shots for a proof run and price them completely.
 *
 * Picks anchors first: they are the shots whose quality matters most, so
 * they are the most informative thing to look at before committing.
 */
export async function planProofRun(
  project: string,
  opts: { shotCount?: number; imageModelSlug: string },
): Promise<ProofPlan> {
  const defaults = loadProjectDefaults();
  const count = opts.shotCount ?? defaults.proof.shotCount;

  const generation = validateArtifact(project, 'generation-plan.json').data;
  const shotlist = validateArtifact(project, 'shotlist.json').data;
  const importance = new Map(shotlist.shots.map((s) => [s.id, s.importance]));

  // Anchors first, then in timeline order - the opening reveal and the final
  // payoff tell you more about quality than a mid-sequence cutaway.
  const ranked = [...generation.items].sort((a, b) => {
    const rank = (id: string) => (importance.get(id) === 'anchor' ? 0 : 1);
    const byRank = rank(a.shotId) - rank(b.shotId);
    return byRank !== 0 ? byRank : a.shotId.localeCompare(b.shotId);
  });

  const chosen = ranked.slice(0, count);
  const items: ProofItem[] = [];
  const alreadyPaid: string[] = [];

  for (const item of chosen) {
    // A start image must exist for every dop generation, and an end image
    // for first-last-frame variants.
    const needsEndImage = item.modelId.includes('first-last-frame');
    const imageCount = 1 + (needsEndImage ? 1 : 0);

    const imageCost = await resolveCost(project, {
      modelId: opts.imageModelSlug,
      kind: 'image',
      prompt: item.prompt,
      aspectRatio: item.aspectRatio,
    });

    const videoCost = await resolveCost(project, {
      modelId: item.modelId,
      kind: 'video',
      prompt: item.prompt,
      durationSeconds: item.billableSeconds,
      aspectRatio: item.aspectRatio,
      ...(item.resolution !== undefined ? { resolution: item.resolution } : {}),
      settings: item.settings,
    });

    // Section 22: an identical asset already paid for is reused, not repaid.
    const hash = computeAssetHash({
      kind: 'video',
      model: item.modelId,
      prompt: item.prompt,
      duration: item.billableSeconds,
      settings: item.settings,
    });
    if (findReusable(project, hash)) alreadyPaid.push(item.shotId);

    items.push({
      item,
      needsStartImage: true,
      needsEndImage,
      imageCostCredits: round3(imageCost.credits * imageCount),
      imageCostUSD: round2(imageCost.usd * imageCount),
      videoCostCredits: videoCost.credits,
      videoCostUSD: videoCost.usd,
    });
  }

  const totalCredits = round3(
    items.reduce((s, i) => s + i.imageCostCredits + i.videoCostCredits, 0),
  );
  const totalUSD = round2(items.reduce((s, i) => s + i.imageCostUSD + i.videoCostUSD, 0));

  return {
    items,
    totalCredits,
    totalUSD,
    totalSeconds: items.reduce((s, i) => s + i.item.billableSeconds, 0),
    budgetRemainingUSD: budgetSnapshot(project).availableUSD,
    alreadyPaid,
  };
}

export function renderProofPlan(plan: ProofPlan): string {
  const lines: string[] = [];

  lines.push('', '  Shots selected for the proof run:', '');
  for (const p of plan.items) {
    const images = p.needsEndImage ? '2 frames' : '1 frame';
    lines.push(
      `    ${p.item.shotId}  ${p.item.billableSeconds}s  ${p.item.modelId}`,
    );
    lines.push(
      `      ${images} ${p.imageCostCredits}cr + video ${p.videoCostCredits}cr ` +
        `= $${(p.imageCostUSD + p.videoCostUSD).toFixed(2)}`,
    );
    lines.push(`      "${p.item.prompt.slice(0, 72)}..."`);
    lines.push('');
  }

  lines.push(`  Total runtime:  ${plan.totalSeconds}s`);
  lines.push(`  Total cost:     ${plan.totalCredits} credits  (~$${plan.totalUSD.toFixed(2)})`);
  lines.push(`  Budget left:    $${plan.budgetRemainingUSD.toFixed(2)}`);

  if (plan.alreadyPaid.length > 0) {
    lines.push('');
    lines.push(`  Already paid for, will be reused: ${plan.alreadyPaid.join(', ')}`);
  }

  return lines.join('\n');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
