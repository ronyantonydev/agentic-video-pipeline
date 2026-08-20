/**
 * Interactive setup: ask for the idea and the budget, then show exactly what
 * that budget buys before anything is created.
 *
 * This is the only place the pipeline reads from stdin. Gates deliberately do
 * not (architecture section 21) - they write state and exit. Setup is
 * different: nothing has been spent yet, and there is no run to resume.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fitToBudget, formatFit, type FitResult } from '../budget/budget-fit.js';
import { cmdInit } from './commands.js';
import { paths } from '../state/paths.js';
import { writeJsonAtomic } from '../util/atomic.js';
import { log } from '../util/logger.js';

export type WizardAnswers = {
  idea: string;
  budgetUSD: number;
  runtimeSeconds: number;
  needsCharacterConsistency: boolean;
  projectName: string;
};

export async function runWizard(preset: Partial<WizardAnswers> = {}): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    stdout.write('\n  Agentic video pipeline\n');
    stdout.write('  ──────────────────────\n\n');

    const idea = preset.idea ?? (await ask(rl, '  What is the video about?\n  > '));
    if (!idea.trim()) {
      log.error('An idea is required.');
      process.exitCode = 1;
      return;
    }

    const runtimeSeconds =
      preset.runtimeSeconds ??
      (await askNumber(rl, '\n  How long, in seconds? [90] ', 90, 5, 3600));

    const budgetUSD =
      preset.budgetUSD ?? (await askNumber(rl, '  Budget in USD? [20] ', 20, 0.5, 10000));

    const needsCharacterConsistency =
      preset.needsCharacterConsistency ??
      (await askYesNo(rl, '  Does the same person appear in several shots? [Y/n] ', true));

    // Price it before creating anything.
    const fit = fitToBudget({ runtimeSeconds, budgetUSD, needsCharacterConsistency });

    stdout.write('\n  What this budget buys\n');
    stdout.write('  ─────────────────────\n');
    stdout.write(`${formatFit(fit, { runtimeSeconds, budgetUSD, needsCharacterConsistency })}\n\n`);

    if (!fit.recommended) {
      log.error('Nothing fits this budget. Raise it, or shorten the video.');
      process.exitCode = 1;
      return;
    }

    if (!fit.recommended.fitsRequestedRuntime) {
      const shorter = await askYesNo(
        rl,
        `  Continue with ${fit.recommended.plannedSeconds}s instead of ` +
          `${runtimeSeconds}s? [Y/n] `,
        true,
      );
      if (!shorter) {
        stdout.write('\n  Nothing created. Raise the budget and run again.\n\n');
        return;
      }
    }

    for (const w of fit.recommended.warnings) log.warn(w);

    const projectName = preset.projectName ?? slugify(idea);
    const proceed = await askYesNo(rl, `\n  Create project "${projectName}"? [Y/n] `, true);
    if (!proceed) {
      stdout.write('\n  Nothing created.\n\n');
      return;
    }

    rl.close();
    createProject({ idea, budgetUSD, runtimeSeconds, needsCharacterConsistency, projectName }, fit);
  } finally {
    rl.close();
  }
}

function createProject(answers: WizardAnswers, fit: FitResult): void {
  cmdInit(answers.projectName, answers.idea, 'full');

  const chosen = fit.recommended!;

  // Persist the decision so planning can read it rather than re-deriving it.
  writeJsonAtomic(paths(answers.projectName).planningFile('../budget-plan.json'), {
    version: 1,
    decidedAt: new Date().toISOString(),
    request: {
      runtimeSeconds: answers.runtimeSeconds,
      budgetUSD: answers.budgetUSD,
      needsCharacterConsistency: answers.needsCharacterConsistency,
    },
    chosen: {
      modelId: chosen.tier.id,
      label: chosen.tier.label,
      creditsPerSecond: chosen.tier.creditsPerSecond,
      holdsIdentity: chosen.tier.holdsIdentity,
      plannedSeconds: chosen.plannedSeconds,
      shotCount: chosen.shotCount,
      averageShotSeconds: chosen.averageShotSeconds,
      estimatedCredits: chosen.estimatedCredits,
      estimatedUSD: chosen.estimatedUSD,
    },
    warnings: chosen.warnings,
    alternatives: fit.options
      .filter((o) => o !== chosen)
      .map((o) => ({
        modelId: o.tier.id,
        plannedSeconds: o.plannedSeconds,
        estimatedUSD: o.estimatedUSD,
        warnings: o.warnings,
      })),
  });

  stdout.write('\n  Created. Next:\n\n');
  stdout.write(`    Claude writes the plan into projects/${answers.projectName}/planning/\n`);
  stdout.write(`    then validate it stage by stage:\n\n`);
  for (const stage of ['story', 'audio', 'storyboard', 'edit', 'generation']) {
    stdout.write(`      npm run plan:${stage} -- ${answers.projectName}\n`);
  }
  stdout.write(`      npm run cost -- ${answers.projectName}\n\n`);
  stdout.write(
    `    Model: ${chosen.tier.label} — ${chosen.plannedSeconds}s across ` +
      `${chosen.shotCount} shots, about $${chosen.estimatedUSD.toFixed(2)}\n\n`,
  );
}

/* ---------------------------------------------------------------- prompts */

async function ask(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return (await rl.question(prompt)).trim();
}

async function askNumber(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  fallback: number,
  min: number,
  max: number,
): Promise<number> {
  for (;;) {
    const raw = await ask(rl, prompt);
    if (raw === '') return fallback;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= min && n <= max) return n;
    stdout.write(`  Enter a number between ${min} and ${max}.\n`);
  }
}

async function askYesNo(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  fallback: boolean,
): Promise<boolean> {
  const raw = (await ask(rl, prompt)).toLowerCase();
  if (raw === '') return fallback;
  return raw.startsWith('y');
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/g, '') || 'project'
  );
}
