/**
 * Cost estimation and the dry-run report. Architecture sections 19, 20.
 *
 * Produces a full price for a plan while spending nothing. This is what
 * Gate 1 presents to the human.
 */

import { resolveCost, type ResolvedCost } from '../budget/cost.js';
import { wouldFitInBudget } from '../budget/guard.js';
import { loadModels, loadProjectDefaults } from '../config/loader.js';
import { writeFileAtomic } from '../util/atomic.js';
import { paths } from '../state/paths.js';
import { UnknownCostError } from '../util/errors.js';
import type { GenerationPlan } from '../schemas/planning.js';

export type LineItem = {
  shotId: string;
  modelId: string;
  billableSeconds: number;
  cost: ResolvedCost | null;
  error?: string;
};

export type CostEstimate = {
  lineItems: LineItem[];
  totalCredits: number;
  totalUSD: number;
  unpricedCount: number;
  fitsInBudget: boolean;
  overageUSD: number;
  maxBudgetUSD: number;
  warnings: string[];
};

/**
 * Price every item in a generation plan.
 *
 * Unpriceable items are recorded rather than thrown, so the report can show
 * the human exactly which shots block the run.
 */
export async function estimateGenerationPlan(
  project: string,
  plan: GenerationPlan,
  opts: { allowApi?: boolean } = {},
): Promise<CostEstimate> {
  const lineItems: LineItem[] = [];
  const warnings: string[] = [];

  for (const item of plan.items) {
    try {
      const cost = await resolveCost(
        project,
        {
          modelId: item.modelId,
          kind: 'video',
          prompt: item.prompt,
          durationSeconds: item.billableSeconds,
          aspectRatio: item.aspectRatio,
          ...(item.resolution !== undefined ? { resolution: item.resolution } : {}),
          settings: item.settings,
        },
        opts,
      );
      if (cost.sanityWarning) warnings.push(`${item.shotId}: ${cost.sanityWarning}`);
      lineItems.push({
        shotId: item.shotId,
        modelId: item.modelId,
        billableSeconds: item.billableSeconds,
        cost,
      });
    } catch (err) {
      if (!(err instanceof UnknownCostError)) throw err;
      lineItems.push({
        shotId: item.shotId,
        modelId: item.modelId,
        billableSeconds: item.billableSeconds,
        cost: null,
        error: err.message,
      });
    }
  }

  const priced = lineItems.filter((l) => l.cost !== null);
  const totalCredits = priced.reduce((sum, l) => sum + l.cost!.credits, 0);
  const totalUSD = round2(priced.reduce((sum, l) => sum + l.cost!.usd, 0));

  const fit = wouldFitInBudget(project, totalUSD);

  return {
    lineItems,
    totalCredits: round3(totalCredits),
    totalUSD,
    unpricedCount: lineItems.length - priced.length,
    fitsInBudget: fit.fits,
    overageUSD: fit.overageUSD,
    maxBudgetUSD: fit.snapshot.maxBudgetUSD,
    warnings,
  };
}

/** Render the estimate as the markdown report from section 20. */
export function renderCostEstimateMarkdown(
  project: string,
  estimate: CostEstimate,
  meta: { idea: string; mode: string; totalRuntimeSeconds?: number },
): string {
  const cfg = loadModels();
  const defaults = loadProjectDefaults();
  const lines: string[] = [];

  lines.push(`# Cost estimate - ${project}`, '');
  lines.push(`**Idea:** ${meta.idea}`, '');
  lines.push(`**Mode:** ${meta.mode}  `);
  if (meta.totalRuntimeSeconds) {
    lines.push(`**Target runtime:** ${meta.totalRuntimeSeconds}s  `);
  }
  lines.push(
    `**Output:** ${defaults.video.width}x${defaults.video.height} @ ${defaults.video.fps}fps`,
    '',
  );

  lines.push('## Shots', '');
  lines.push('| Shot | Model | Billable | Credits | USD | Source |');
  lines.push('|------|-------|---------:|--------:|----:|--------|');
  for (const item of estimate.lineItems) {
    if (item.cost) {
      lines.push(
        `| ${item.shotId} | \`${item.modelId}\` | ${item.billableSeconds}s | ` +
          `${item.cost.credits} | $${item.cost.usd.toFixed(3)} | ${item.cost.source} |`,
      );
    } else {
      lines.push(
        `| ${item.shotId} | \`${item.modelId}\` | ${item.billableSeconds}s | ` +
          `**?** | **?** | **UNPRICED** |`,
      );
    }
  }
  lines.push('');

  lines.push('## Total', '');
  lines.push(`- **Credits:** ${estimate.totalCredits}`);
  lines.push(`- **USD:** $${estimate.totalUSD.toFixed(2)}`);
  lines.push(`- **Budget:** $${estimate.maxBudgetUSD.toFixed(2)}`);
  lines.push(
    `- **Status:** ${
      estimate.fitsInBudget
        ? 'fits within budget'
        : `**OVER BUDGET by $${estimate.overageUSD.toFixed(2)}**`
    }`,
  );
  lines.push('');

  if (estimate.unpricedCount > 0) {
    lines.push('## Blocking', '');
    lines.push(
      `${estimate.unpricedCount} shot(s) could not be priced. The run cannot ` +
        `proceed until every shot has a known cost - see architecture rule 3.`,
      '',
    );
    for (const item of estimate.lineItems.filter((l) => l.cost === null)) {
      lines.push(`- \`${item.shotId}\`: ${item.error ?? 'unknown cost'}`);
    }
    lines.push('');
  }

  if (estimate.warnings.length > 0) {
    lines.push('## Warnings', '');
    for (const w of estimate.warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  if (!cfg.creditToUsd.verified) {
    lines.push(
      `> Credit-to-USD rate (${cfg.creditToUsd.rate}) is derived from ` +
        `${cfg.creditToUsd.source} and has not been confirmed against a live ` +
        `invoice. Credit figures are more reliable than dollar figures.`,
      '',
    );
  }

  lines.push('---', '', `_Generated ${new Date().toISOString()} - $0 spent._`);
  return lines.join('\n');
}

export function writeCostEstimate(project: string, markdown: string): string {
  const file = paths(project).costEstimate;
  writeFileAtomic(file, markdown);
  return file;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
