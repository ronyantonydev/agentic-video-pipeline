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
  cmdInit, cmdPlan, cmdCost, cmdApprove, cmdStatus, type PlanStage,
} from './commands.js';
import type { GateNameT } from '../schemas/state.js';

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
  .action((project: string, opts: { idea: string; mode: string }) => {
    cmdInit(project, opts.idea, opts.mode as 'full' | 'proof' | 'dry-run');
  });

program
  .command('status')
  .description('Show project stage, gates, budget and artifacts')
  .argument('<project>', 'project name')
  .action((project: string) => cmdStatus(project));

/* -------------------------------------------------------------------- plan */

const plan = program.command('plan').description('Validate a planning artifact');

for (const stage of ['story', 'audio', 'storyboard', 'edit', 'generation'] as const) {
  plan
    .command(stage)
    .description(`Validate the artifacts for the ${stage} stage and advance state`)
    .argument('<project>', 'project name')
    .action((project: string) => cmdPlan(project, stage as PlanStage));
}

/* ------------------------------------------------------------- cost / gates */

program
  .command('cost')
  .description('Estimate cost from the generation plan')
  .argument('<project>', 'project name')
  .option('--dry-run', 'print the report without requesting approval')
  .option('--no-api', 'do not call the estimate endpoint')
  .action(async (project: string, opts: { dryRun?: boolean; api?: boolean }) => {
    await cmdCost(project, {
      ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
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
    cmdApprove(
      project,
      opts.gate as GateNameT,
      opts.reject ? 'rejected' : 'approved',
      opts.note,
    );
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

for (const tier of ['machine', 'vision', 'final'] as const) {
  qa.command(tier)
    .description(`Run ${tier} QA`)
    .argument('<project>', 'project name')
    .action((project: string) => notImplemented(`qa:${tier}`, `project=${project}`));
}

/* ------------------------------------------------------------ post / output */

for (const [name, desc] of [
  ['review', 'Human accept/retry/fallback decisions'],
  ['render', 'Compile edit plan and render via HyperFrames'],
  ['upscale', 'Optional upscale of the final render'],
  ['thumbnail', 'Produce thumbnail.png'],
  ['report', 'Write cost.md and qa-report.json'],
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
