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
  .option('--idea <text>', 'one-line idea')
  .action((project: string) => {
    notImplemented('init', `project=${project}`);
  });

/* -------------------------------------------------------------------- plan */

const plan = program.command('plan').description('Validate a planning artifact');

for (const stage of ['story', 'audio', 'storyboard', 'edit', 'generation'] as const) {
  plan
    .command(stage)
    .description(`Validate planning/${stage}*.json and advance state`)
    .argument('<project>', 'project name')
    .action((project: string) => notImplemented(`plan:${stage}`, `project=${project}`));
}

/* ------------------------------------------------------------- cost / gates */

program
  .command('cost')
  .description('Estimate cost from the generation plan')
  .argument('<project>', 'project name')
  .action((project: string) => notImplemented('cost', `project=${project}`));

program
  .command('approve')
  .description('Approve a pending gate and resume')
  .argument('<project>', 'project name')
  .requiredOption('--gate <gate>', 'cost | look | review')
  .action((project: string, opts: { gate: string }) =>
    notImplemented('approve', `project=${project} gate=${opts.gate}`),
  );

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
  .action((idea: string[], opts: Record<string, unknown>) => {
    const mode = opts['dryRun'] ? 'dry-run' : opts['proof'] ? 'proof' : 'full';
    notImplemented('video', `mode=${mode} idea="${idea.join(' ')}"`);
  });

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
