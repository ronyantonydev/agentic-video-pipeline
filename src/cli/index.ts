#!/usr/bin/env node
/**
 * CLI entry point. Architecture section 34.
 *
 * Stages are deliberately separate commands rather than one monolith: each
 * writes state and exits, so a run survives a closed terminal (section 21).
 */

import { Command } from 'commander';
import { runDoctor } from './doctor.js';
import { log } from '../util/logger.js';
import { HardStop, PipelineError, GatePending } from '../util/errors.js';
import {
  cmdInit, cmdPlan, cmdCost, cmdApprove, cmdStatus, cmdRequestLook, cmdPlanReport, cmdSetBudget,
  cmdPlanContract, cmdReadiness,
  cmdQaMachine, cmdQaFinal, cmdRender, cmdThumbnail, cmdReport,
  type PlanStage,
} from './commands.js';
import type { GateNameT } from '../schemas/state.js';
import { runWizard } from './wizard.js';
import { buildDebugBundle } from '../reports/debug-bundle.js';
import { attachProjectLog } from '../util/logger.js';
import { paths } from '../state/paths.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReferences, formatReferenceCheck } from '../qa/reference-gate.js';
import { buildPlanContactSheet } from '../qa/vision.js';
import { fitToBudget, formatFit } from '../budget/budget-fit.js';

const program = new Command();

program
  .name('video')
  .description('Agentic video pipeline - Claude plans, code spends.')
  .version('0.1.0');

/* ------------------------------------------------------------------ doctor */

program
  .command('doctor')
  .description('Verify environment, config, and tooling')
  .action(() => {
    process.exitCode = runDoctor();
  });

/* -------------------------------------------------------------------- init */

program
  .command('init')
  .description('Create a new project skeleton')
  .argument('<project>', 'project name (kebab-case)')
  .requiredOption('--idea <text>', 'the idea, in plain language')
  .option('--mode <mode>', 'full | proof | dry-run', 'full')
  .option('--budget <usd>', 'budget ceiling for this project (overrides MAX_BUDGET_USD)')
  .action((project: string, opts: { idea: string; mode: string; budget?: string }) => {
    cmdInit(
      project,
      opts.idea,
      opts.mode as 'full' | 'proof' | 'dry-run',
      opts.budget !== undefined ? Number(opts.budget) : undefined,
    );
  });

/**
 * Mirror this run into the project's log file.
 *
 * Terminal output scrolls away. A bug report needs a record of what actually
 * ran, in what order - see `npm run debug`.
 */
function withLog(project: string): string {
  const root = paths(project).root;
  if (existsSync(root)) attachProjectLog(root);
  return project;
}

program
  .command('debug')
  .description('Collect a diagnostic bundle for a bug report (no video, no secrets)')
  .argument('<project>', 'project name')
  .option('--output <path>', 'where to write the zip')
  .action(async (project: string, opts: { output?: string }) => {
    const result = await buildDebugBundle(project, {
      ...(opts.output !== undefined ? { outputPath: opts.output } : {}),
    });
    process.stdout.write(`\n  ${result.path}\n`);
    process.stdout.write(
      `  ${(result.sizeBytes / 1048576).toFixed(1)}MB · ${result.included.length} items · ` +
        `${result.redactions} redaction(s)\n\n`,
    );
    if (result.warnings.length > 0) {
      for (const w of result.warnings) process.stdout.write(`  ! ${w}\n`);
      process.stdout.write('\n');
    }
  });

program
  .command('status')
  .description('Show project stage, gates, budget and artifacts')
  .argument('<project>', 'project name')
  .action((project: string) => cmdStatus(withLog(project)));

program
  .command('set-budget')
  .description('Change the budget ceiling on an existing project')
  .argument('<project>', 'project name')
  .requiredOption('--budget <usd>', 'the new ceiling, in USD')
  .action((project: string, opts: { budget: string }) => {
    cmdSetBudget(withLog(project), Number(opts.budget));
  });

program
  .command('start')
  .description('Interactive setup: asks for the idea and budget, then fits a model to it')
  .option('--idea <text>', 'skip the idea prompt')
  .option('--budget <usd>', 'skip the budget prompt')
  .option('--runtime <seconds>', 'skip the runtime prompt')
  .option('--project <name>', 'project name (defaults to a slug of the idea)')
  .action(async (opts: Record<string, string>) => {
    const preset: Parameters<typeof runWizard>[0] = {};
    if (opts['idea']) preset.idea = opts['idea'];
    if (opts['budget']) preset.budgetUSD = Number(opts['budget']);
    if (opts['runtime']) preset.runtimeSeconds = Number(opts['runtime']);
    if (opts['project']) preset.projectName = opts['project'];
    await runWizard(preset);
  });

program
  .command('budget')
  .description('Show what a budget buys, without creating anything')
  .requiredOption('--budget <usd>', 'budget in USD')
  .option('--runtime <seconds>', 'target runtime in seconds', '90')
  .option('--no-character', 'no recurring character, so identity drift is acceptable')
  .action((opts: { budget: string; runtime: string; character?: boolean }) => {
    const req = {
      budgetUSD: Number(opts.budget),
      runtimeSeconds: Number(opts.runtime),
      needsCharacterConsistency: opts.character !== false,
    };
    process.stdout.write(`\n${formatFit(fitToBudget(req), req)}\n\n`);
  });

/* -------------------------------------------------------------------- plan */

const plan = program.command('plan').description('Validate a planning artifact');

for (const stage of ['story', 'audio', 'storyboard', 'edit', 'generation'] as const) {
  plan
    .command(stage)
    .description(`Validate the artifacts for the ${stage} stage and advance state`)
    .argument('<project>', 'project name')
    .action((project: string) => cmdPlan(withLog(project), stage as PlanStage));
}

program
  .command('readiness')
  .description('Would /run-video finish? Checks every layer - shots, frames, stills, audio (free)')
  .argument('<project>', 'project name')
  .action((project: string) => cmdReadiness(withLog(project)));

program
  .command('plan-contract')
  .description('Validate plan.json - the one file /run-video reads (free)')
  .argument('<project>', 'project name')
  .action((project: string) => cmdPlanContract(withLog(project)));

/* ------------------------------------------------------------- cost / gates */

program
  .command('cost')
  .description('Estimate cost from the generation plan')
  .argument('<project>', 'project name')
  .option('--dry-run', 'print the report without requesting approval')
  .option('--no-api', 'do not call the estimate endpoint')
  .option('--require-approval', 'stop for approval even when the estimate fits the budget')
  .action(async (
    project: string,
    opts: { dryRun?: boolean; api?: boolean; requireApproval?: boolean },
  ) => {
    withLog(project);
    await cmdCost(project, {
      ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
      ...(opts.requireApproval !== undefined ? { requireApproval: opts.requireApproval } : {}),
      allowApi: opts.api !== false,
    });
  });

program
  .command('approve')
  .description('Approve or reject a pending gate and resume')
  .argument('<project>', 'project name')
  .requiredOption('--gate <gate>', 'cost | look | review')
  .option('--reject', 'reject instead of approving')
  .option('--note <text>', 'reason for the decision')
  .action((project: string, opts: { gate: string; reject?: boolean; note?: string }) => {
    withLog(project);
    cmdApprove(
      project,
      opts.gate as GateNameT,
      opts.reject ? 'rejected' : 'approved',
      opts.note,
    );
  });

/* ---------------------------------------------------------- reference gate */

program
  .command('refcheck')
  .description('Verify the reference pack and drift samples (free - hashing and ffmpeg only)')
  .argument('<project>', 'project name')
  .option('--samples <dir>', 'directory of drift samples generated from the pack')
  .option('--no-character', 'this video contains no recurring person')
  .option(
    '--override-drift <reason>',
    'accept a FAILING drift test on a stated human judgement. Clears only the ' +
      'drift blocker; a missing pack or corrupt image still blocks. The failure ' +
      'and the reason are both recorded in reference-check.json.',
  )
  .action(async (
    project: string,
    opts: { samples?: string; character?: boolean; overrideDrift?: string },
  ) => {
    withLog(project);
    const p = paths(project);
    const sampleDir = opts.samples ?? join(p.references, 'drift-samples');
    const driftSamples = existsSync(sampleDir)
      ? readdirSync(sampleDir)
          .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
          .sort()
          .map((f) => join(sampleDir, f))
      : [];

    const check = await checkReferences(project, {
      needsCharacter: opts.character !== false,
      driftSamples,
      ...(opts.overrideDrift !== undefined ? { driftOverrideReason: opts.overrideDrift } : {}),
    });

    process.stdout.write(`\n${formatReferenceCheck(check)}\n\n`);
    // Non-zero so a scripted run stops here rather than generating against a
    // reference that was never going to work.
    if (!check.pass) {
      process.exitCode = 4;
      return;
    }

    // Write the human-readable report before raising the gate: the gate's
    // whole question is "does this look right", and nine JSON files plus a
    // folder of images is not a question anyone can answer.
    await cmdPlanReport(project);

    // The `contact-sheet` stage sits before gate-look precisely so the human
    // gets one page instead of twenty files. It was never built here, and the
    // only builder read frames from generated video that does not exist yet.
    const contactSheet = await buildPlanContactSheet(project);
    if (contactSheet) log.info(`Contact sheet: ${contactSheet}`);
    else log.warn('No contact sheet - no reference images or anchor frames to assemble.');

    // A passing check is the moment the look becomes reviewable, so it is
    // where the look gate is raised.
    //
    // Nothing used to raise it. Only the cost gate was ever requested, and
    // the stage that would have requested this one is `gen references`,
    // which is deliberately notImplemented because generation runs through
    // MCP. So `gate-look` was a defined stage no project could enter, and
    // `approve --gate look` always failed with "not reached yet - nothing to
    // approve": the gate was unreachable by construction rather than
    // pending. Harmless while nothing enforced it; a deadlock once
    // generateShot began to.
    cmdRequestLook(project, check, contactSheet);
  });

program
  .command('plan-report')
  .description('Write plan-report.md - what the code checked, and what you must look at (free)')
  .argument('<project>', 'project name')
  .action(async (project: string) => {
    withLog(project);
    await cmdPlanReport(project);
  });

/* --------------------------------------------------------------- generation */

const gen = program.command('gen').description('Paid generation stages');

gen
  .command('references')
  .description('Generate reference images and target frames')
  .argument('<project>', 'project name')
  .action((project: string) => notImplemented('gen:references', `project=${project}`));

gen
  .command('shots')
  .description('Generate video shots')
  .argument('<project>', 'project name')
  .action((project: string) => notImplemented('gen:shots', `project=${project}`));

/* ----------------------------------------------------------------------- qa */

const qa = program.command('qa').description('Quality assurance stages');

qa.command('machine')
  .description('Run machine QA (free, deterministic)')
  .argument('<project>', 'project name')
  .action(async (project: string) => {
    withLog(project);
    await cmdQaMachine(project);
  });

qa.command('final')
  .description('Run final QA on the render (report only)')
  .argument('<project>', 'project name')
  .action(async (project: string) => {
    withLog(project);
    await cmdQaFinal(project);
  });

// Vision QA needs a human or a vision model to judge the extracted frames,
// so it stays outside the deterministic CLI.
qa.command('vision')
  .description('Run vision QA')
  .argument('<project>', 'project name')
  .action((project: string) => notImplemented('qa:vision', `project=${project}`));

/* ------------------------------------------------------------ post / output */

program
  .command('render')
  .description('Normalise clips, compile the edit plan, and render via HyperFrames')
  .argument('<project>', 'project name')
  .action(async (project: string) => {
    withLog(project);
    await cmdRender(project);
  });

program
  .command('thumbnail')
  .description('Produce thumbnail.png from the final render')
  .argument('<project>', 'project name')
  .action(async (project: string) => {
    withLog(project);
    await cmdThumbnail(project);
  });

program
  .command('report')
  .description('Write cost.md from actual manifest spend')
  .argument('<project>', 'project name')
  .action((project: string) => {
    withLog(project);
    cmdReport(project);
  });

for (const [name, desc] of [
  ['review', 'Human accept/retry/fallback decisions'],
  ['upscale', 'Optional upscale of the final render'],
] as const) {
  program
    .command(name)
    .description(desc)
    .argument('<project>', 'project name')
    .action((project: string) => notImplemented(name, `project=${project}`));
}

/* ------------------------------------------------------------------- video */

program
  .command('video')
  .description('Run the pipeline end to end')
  .argument('[idea...]', 'the idea, in plain language')
  .option('--dry-run', 'plan and estimate only, spend nothing')
  .option('--proof', 'short proof run using production models')
  .option('--resume <project>', 'resume an existing project')
  .option('--project <name>', 'project name (defaults to a slug of the idea)')
  .action(async (idea: string[], opts: Record<string, unknown>) => {
    const mode = opts['dryRun'] ? 'dry-run' : opts['proof'] ? 'proof' : 'full';
    const resume = opts['resume'] as string | undefined;

    if (resume) {
      cmdStatus(resume);
      return;
    }

    const text = idea.join(' ').trim();
    if (!text) {
      log.error('Provide an idea, or --resume <project>.');
      process.exitCode = 1;
      return;
    }

    const project = (opts['project'] as string | undefined) ?? slugify(text);
    cmdInit(project, text, mode as 'full' | 'proof' | 'dry-run');

    // Planning artifacts are written by Claude, not generated here
    // (architecture section 2). Report what is still required.
    log.stage('Next steps');
    process.stdout.write(
      `  Project "${project}" is ready.\n\n` +
        `  Claude now writes the planning artifacts into\n` +
        `  projects/${project}/planning/, validated stage by stage:\n\n` +
        `    npm run plan:story      -- ${project}\n` +
        `    npm run plan:audio      -- ${project}\n` +
        `    npm run plan:storyboard -- ${project}\n` +
        `    npm run plan:edit       -- ${project}\n` +
        `    npm run plan:generation -- ${project}\n` +
        `    npm run cost            -- ${project}${mode === 'dry-run' ? ' --dry-run' : ''}\n\n`,
    );
  });

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/g, '') || 'project'
  );
}

/* --------------------------------------------------------------------- run */

function notImplemented(stage: string, detail: string): void {
  log.warn(`Stage "${stage}" is not implemented yet.`, { detail });
  process.exitCode = 2;
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof GatePending) {
      log.info(err.message);
      process.exitCode = 3;
      return;
    }
    if (err instanceof HardStop) {
      log.money(`HARD STOP - ${err.message}`, err.details);
      process.exitCode = 4;
      return;
    }
    if (err instanceof PipelineError) {
      log.error(`[${err.code}] ${err.message}`);
      process.exitCode = 1;
      return;
    }
    log.error((err as Error).stack ?? String(err));
    process.exitCode = 1;
  }
}

void main();
