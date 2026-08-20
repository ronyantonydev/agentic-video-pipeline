/**
 * Final cost report. Architecture section 23 and 24.
 *
 * Everything here comes from the manifest, which recorded each generation as
 * it happened - not from a re-estimate after the fact.
 */

import { readManifest, totalSpend } from '../manifest/store.js';
import { readState } from '../state/store.js';
import { writeFileAtomic } from '../util/atomic.js';
import { paths } from '../state/paths.js';
import { creditsToUsd } from '../budget/cost.js';

export function renderCostReport(project: string): string {
  const state = readState(project);
  const manifest = readManifest(project);
  const spend = totalSpend(project);

  const chargeable = manifest.entries.filter(
    (e) => e.status !== 'failed' && e.status !== 'cancelled' && e.status !== 'refunded',
  );

  const byModel = new Map<string, { count: number; credits: number }>();
  for (const e of chargeable) {
    const row = byModel.get(e.model) ?? { count: 0, credits: 0 };
    row.count += 1;
    row.credits += e.actualCredits ?? e.estimatedCredits ?? 0;
    byModel.set(e.model, row);
  }

  const lines: string[] = [];
  lines.push(`# Cost report - ${project}`, '');
  lines.push(`**Idea:** ${state.idea}`, '');
  lines.push(`**Completed:** ${new Date().toISOString()}`, '');

  lines.push('## Spend', '');
  lines.push('| | Credits | USD |');
  lines.push('|---|--------:|----:|');
  lines.push(
    `| **Total** | ${spend.credits.toFixed(2)} | $${creditsToUsd(spend.credits).toFixed(2)} |`,
  );
  lines.push(
    `| Budget | ${state.budget.maxBudgetUSD > 0 ? '—' : '—'} | $${state.budget.maxBudgetUSD.toFixed(2)} |`,
  );
  lines.push('');

  if (state.budget.creditsStart !== null) {
    lines.push(
      `Balance: ${state.budget.creditsStart} → ${state.budget.creditsRemaining ?? '?'} ` +
        `(${state.budget.creditsUsed.toFixed(2)} used)`,
      '',
    );
  }

  lines.push('## By model', '');
  lines.push('| Model | Generations | Credits |');
  lines.push('|-------|------------:|--------:|');
  for (const [model, row] of [...byModel].sort((a, b) => b[1].credits - a[1].credits)) {
    lines.push(`| \`${model}\` | ${row.count} | ${row.credits.toFixed(2)} |`);
  }
  lines.push('');

  // Section 24: the manifest IS the prompt library. Accepted prompts are the
  // ones worth reusing.
  const accepted = manifest.entries.filter((e) => e.accepted === true && e.kind === 'video');
  const rejected = manifest.entries.filter((e) => e.accepted === false && e.kind === 'video');

  lines.push('## Outcomes', '');
  lines.push(`- Accepted: ${accepted.length}`);
  lines.push(`- Rejected / retried: ${rejected.length}`);
  const wasted = rejected.reduce((s, e) => s + (e.actualCredits ?? 0), 0);
  if (wasted > 0) {
    lines.push(`- Credits spent on rejected work: ${wasted.toFixed(2)}`);
  }
  lines.push('');

  if (rejected.length > 0) {
    lines.push('### Rejected', '');
    for (const e of rejected) {
      const shot = state.shots[e.shotId ?? ''];
      lines.push(
        `- \`${e.shotId}\` (${e.model}) — ${shot?.failureClass ?? 'unclassified'}` +
          (e.qualityNote ? `: ${e.qualityNote}` : ''),
      );
    }
    lines.push('');
  }

  lines.push('## Notes', '');
  lines.push(
    '- Failed and cancelled generations are excluded: Higgsfield does not charge for them.',
  );
  lines.push(
    '- Figures come from the manifest, written at generation time, not re-estimated afterwards.',
  );
  lines.push('');

  lines.push('---', '', `_${manifest.entries.length} manifest entries._`);
  return lines.join('\n');
}

export function writeCostReport(project: string): string {
  const file = paths(project).cost;
  writeFileAtomic(file, renderCostReport(project));
  return file;
}
