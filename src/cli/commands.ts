/**
 * Stage implementations behind the CLI verbs.
 *
 * Each stage validates, does its work, writes state, and returns. Nothing
 * here blocks on human input - gates throw GatePending instead.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadProjectDefaults, loadQualityPolicy } from '../config/loader.js';
import { loadEnv } from '../config/env.js';
import { ensureProjectDirs, isValidProjectName, paths } from '../state/paths.js';
import { readState, writeState, advanceStage, addWarning, stateExists } from '../state/store.js';
import { emptyState } from '../schemas/state.js';
import { writeFileAtomic } from '../util/atomic.js';
import {
  validateArtifact, surveyArtifacts, validateCrossReferences, artifactIsValid,
} from '../planning/validate.js';
import { runMachineQa, formatQaResult, summarizeQa } from '../qa/machine.js';
import { runFinalQa, formatFinalQa } from '../qa/final.js';
import { normalizeClip } from '../ffmpeg/normalize.js';
import { compileComposition } from '../timeline/compile.js';
import { renderComposition } from '../timeline/render.js';
import { extractThumbnail } from '../thumbnail/thumbnail.js';
import { renderCostReport, writeCostReport } from '../reports/cost-report.js';
import { buildContinuityGraph, assertExecutableGraph, executionPlan } from '../planning/continuity-graph.js';
import { lintMotionRatio, formatLintResult } from '../planning/motion-lint.js';
import {
  estimateGenerationPlan, renderCostEstimateMarkdown, writeCostEstimate,
} from '../reports/cost-estimate.js';
import { requestApproval, decideGate } from '../gates/gates.js';
import { ValidationError } from '../util/errors.js';
import { log } from '../util/logger.js';
import type { GateNameT } from '../schemas/state.js';

/* -------------------------------------------------------------------- init */

/**
 * @param maxBudgetUSD The user's stated budget. This is the source of truth -
 *        `MAX_BUDGET_USD` in the environment is only a fallback for
 *        non-interactive callers. Reading env first meant a user who answered
 *        "$8" got a project carrying the env default of $20, so the guard
 *        protected a number they never chose.
 */
export function cmdInit(
  project: string,
  idea: string,
  mode: 'full' | 'proof' | 'dry-run',
  maxBudgetUSD?: number,
): void {
  if (!isValidProjectName(project)) {
    throw new ValidationError(
      `Invalid project name "${project}". Use kebab-case: a-z, 0-9, hyphens.`,
      'project-name',
    );
  }
  if (stateExists(project)) {
    log.warn(`Project "${project}" already exists; leaving it untouched.`);
    return;
  }

  const defaults = loadProjectDefaults();
  const env = loadEnv();
  const p = ensureProjectDirs(project);

  writeState(
    project,
    emptyState({
      projectName: project,
      idea,
      mode,
      maxBudgetUSD: maxBudgetUSD ?? env.MAX_BUDGET_USD,
      projectSettings: {
        width: defaults.video.width,
        height: defaults.video.height,
        fps: defaults.video.fps,
        colorspace: defaults.video.colorspace,
        aspectRatio: defaults.video.aspectRatio,
      },
    }),
  );

  writeFileAtomic(p.idea, `# ${project}\n\n${idea}\n`);
  log.info(`Initialised project "${project}" at ${p.root}`);
}

/* -------------------------------------------------------------------- plan */

const PLAN_STAGE_ARTIFACTS = {
  story: ['story.json'],
  audio: ['music.json', 'beat-grid.json'],
  storyboard: ['progression.json', 'continuity.json', 'shotlist.json', 'storyboard.json'],
  edit: ['edit-plan.json'],
  generation: ['generation-plan.json'],
} as const;

export type PlanStage = keyof typeof PLAN_STAGE_ARTIFACTS;

/**
 * Validate the artifacts a planning stage owns, then advance.
 * Claude writes them; this only checks and records.
 */
export function cmdPlan(project: string, stage: PlanStage): void {
  const artifacts = PLAN_STAGE_ARTIFACTS[stage];
  for (const name of artifacts) {
    validateArtifact(project, name);
    log.info(`planning/${name} valid`);
  }

  const problems = validateCrossReferences(project);
  if (problems.length > 0) {
    throw new ValidationError(
      `Planning artifacts disagree:\n  ${problems.join('\n  ')}`,
      'cross-reference',
      problems,
    );
  }

  // The shotlist defines the dependency graph, so validate it as soon as
  // it exists rather than at generation time.
  if (artifacts.includes('shotlist.json' as never)) {
    const policy = loadQualityPolicy();
    const graph = buildContinuityGraph(validateArtifact(project, 'shotlist.json').data, policy.continuity);
    assertExecutableGraph(graph);
    for (const issue of graph.issues) {
      log.warn(issue.message);
      addWarning(project, issue.message);
    }
    const exec = executionPlan(graph);
    log.info(
      `Continuity: ${exec.parallelBatch.length} parallel, ` +
        `${exec.serialChains.length} chain(s), longest ${graph.longestChain}`,
    );
  }

  // Motion lint #1 - after edit planning (section 18).
  if (stage === 'edit') {
    const result = lintMotionRatio(
      validateArtifact(project, 'edit-plan.json').data,
      loadQualityPolicy(),
      1,
    );
    process.stdout.write(`${formatLintResult(result)}\n`);
    if (!result.pass) {
      throw new ValidationError(
        `Motion-ratio lint #1 failed. The edit would look like a slideshow.`,
        'edit-plan.json',
        result.violations.map((v) => v.message),
      );
    }
    advanceStage(project, 'motion-lint-1');
  }

  const stageMap = {
    story: 'story', audio: 'beat-grid', storyboard: 'storyboard',
    edit: 'edit-plan', generation: 'generation-plan',
  } as const;
  advanceStage(project, stageMap[stage]);
}

/* -------------------------------------------------------------------- cost */

/**
 * @param opts.requireApproval Force the gate to stop even when the estimate
 *        fits. Default false: the user stated a budget, and an estimate that
 *        fits inside it needs no second confirmation - asking again is asking
 *        them to re-approve a number they already chose. The gate still stops
 *        for anything they did NOT agree to: over budget, or unpriced shots.
 */
export async function cmdCost(
  project: string,
  opts: { dryRun?: boolean; allowApi?: boolean; requireApproval?: boolean } = {},
): Promise<void> {
  const state = readState(project);
  const plan = validateArtifact(project, 'generation-plan.json').data;

  log.stage('Cost estimation');
  const estimate = await estimateGenerationPlan(project, plan, {
    allowApi: opts.allowApi ?? true,
  });

  const runtime = estimate.lineItems.reduce((s, l) => s + l.billableSeconds, 0);
  const markdown = renderCostEstimateMarkdown(project, estimate, {
    idea: state.idea,
    mode: state.mode,
    totalRuntimeSeconds: runtime,
  });
  const file = writeCostEstimate(project, markdown);

  log.money(
    `Estimated ${estimate.totalCredits} credits / $${estimate.totalUSD.toFixed(2)} ` +
      `against a $${estimate.maxBudgetUSD.toFixed(2)} budget`,
  );
  log.info(`Report: ${file}`);

  advanceStage(project, 'cost-estimate');

  if (opts.dryRun) {
    process.stdout.write(`\n${markdown}\n`);
    return;
  }

  if (estimate.unpricedCount > 0) {
    throw new ValidationError(
      `${estimate.unpricedCount} shot(s) have no known cost. ` +
        `Refusing to request approval for an unknown total.`,
      'generation-plan.json',
    );
  }

  // Inside the budget the user stated: record the approval and continue.
  // The ceiling is still enforced per-call by the spend guard; this only
  // removes a confirmation of something already confirmed.
  if (estimate.fitsInBudget && !opts.requireApproval) {
    decideGate(
      project,
      'cost',
      'approved',
      `auto-approved: $${estimate.totalUSD.toFixed(2)} fits the stated ` +
        `$${estimate.maxBudgetUSD.toFixed(2)} budget`,
      'system',
    );
    advanceStage(project, 'references');
    log.money(
      `Within budget - approved automatically ` +
        `($${estimate.totalUSD.toFixed(2)} of $${estimate.maxBudgetUSD.toFixed(2)}, ` +
        `$${(estimate.maxBudgetUSD - estimate.totalUSD).toFixed(2)} left for retries)`,
    );
    return;
  }

  requestApproval(project, 'cost', [
    `Estimated cost: ${estimate.totalCredits} credits (~$${estimate.totalUSD.toFixed(2)})`,
    `Budget:         $${estimate.maxBudgetUSD.toFixed(2)}`,
    `Status:         OVER BUDGET by $${estimate.overageUSD.toFixed(2)}`,
    ``,
    `Full breakdown: ${file}`,
  ]);
}

/* ----------------------------------------------------------------- approve */

export function cmdApprove(
  project: string,
  gate: GateNameT,
  decision: 'approved' | 'rejected',
  note?: string,
): void {
  decideGate(project, gate, decision, note);
  log.info(`Gate "${gate}" ${decision}.`);

  if (decision === 'approved') {
    const next = { cost: 'references', look: 'generate-shots', review: 'motion-lint-2' } as const;
    advanceStage(project, next[gate]);
  }
}

/* --------------------------------------------------------------- finishing */
/*
 * These stages were stubbed as `notImplemented` in the CLI even though the
 * modules behind them were complete. Wiring them here is what turns a set of
 * generated clips into a finished file - nothing below spends money.
 */

/** Where a shot's clip lives, preferring the normalised copy. */
function shotMedia(project: string, shotId: string): string | null {
  const p = paths(project);
  for (const name of ['normalized.mp4', 'original.mp4']) {
    const f = p.shotFile(shotId, name);
    if (existsSync(f)) return f;
  }
  return null;
}

/** Tier 1 QA: free, deterministic, and it never spends on a retry. */
export async function cmdQaMachine(project: string): Promise<void> {
  const plan = validateArtifact(project, 'edit-plan.json').data;
  const genPlan = validateArtifact(project, 'generation-plan.json').data;
  const policy = loadQualityPolicy();
  const byShot = new Map(genPlan.items.map((i) => [i.shotId, i]));

  log.stage('Machine QA');
  const results = [];

  for (const item of plan.items) {
    const file = shotMedia(project, item.shotId);
    if (!file) {
      throw new ValidationError(
        `No clip found for ${item.shotId}. Generate the shots before running QA.`,
        'qa-machine',
      );
    }
    const gen = byShot.get(item.shotId);
    const result = await runMachineQa(item.shotId, file, {
      policy,
      ...(gen ? { expectedDurationSeconds: gen.billableSeconds } : {}),
      expectAudio: gen?.nativeAudio ?? false,
      // A person is on screen in every shot of this kind of video, so the
      // last frame is worth comparing to the first (verify-realism rule 7).
      checkIdentityDrift: true,
    });
    results.push(result);
    process.stdout.write(`${formatQaResult(result)}\n`);
  }

  const summary = summarizeQa(results);
  writeFileAtomic(paths(project).qaReport, JSON.stringify({ results, summary }, null, 2));
  log.info(`Machine QA: ${summary.passed} passed, ${summary.failed} failed`);
  advanceStage(project, 'qa-machine');
}

/** Normalise, compile to a HyperFrames composition, and render. Free. */
export async function cmdRender(project: string): Promise<void> {
  const p = paths(project);
  const plan = validateArtifact(project, 'edit-plan.json').data;
  const defaults = loadProjectDefaults();

  log.stage('Render');

  // Conform every clip to the project format first: the model returns 720p
  // and the project is 1080p, so compiling straight from the source would
  // bake a resolution mismatch into the timeline.
  for (const item of plan.items) {
    const original = p.shotFile(item.shotId, 'original.mp4');
    const normalized = p.shotFile(item.shotId, 'normalized.mp4');
    if (!existsSync(original)) {
      throw new ValidationError(
        `Missing ${original}. Generate the shots before rendering.`,
        'render',
      );
    }
    if (!existsSync(normalized)) {
      const r = await normalizeClip(original, normalized, defaults);
      log.info(
        `${item.shotId}: ${r.before.video?.width}x${r.before.video?.height} -> ` +
          `${r.after.video?.width}x${r.after.video?.height}` +
          (r.upscaled ? ' (upscaled)' : ''),
      );
    }
  }

  const audioPlan = artifactIsValid(project, 'audio-plan.json')
    ? validateArtifact(project, 'audio-plan.json').data
    : null;
  const musicFile = audioPlan?.musicFile ?? plan.music.file;

  const compiled = compileComposition(plan, {
    projectName: project,
    defaults,
    outputDir: join(p.root, 'composition'),
    ...(musicFile !== undefined ? { musicFile } : {}),
    title: project,
  });
  for (const w of compiled.warnings) {
    log.warn(w);
    addWarning(project, w);
  }
  log.info(
    `Composition: ${compiled.clipCount} clip(s), ${compiled.stillCount} still(s), ` +
      `${compiled.totalDurationSeconds}s`,
  );

  const rendered = await renderComposition({
    projectDir: compiled.projectDir,
    outputPath: p.finalVideo,
    fps: defaults.video.fps,
  });
  log.info(
    `Rendered ${rendered.outputPath} (${rendered.durationSeconds.toFixed(2)}s, ` +
      `${(rendered.elapsedMs / 1000).toFixed(1)}s elapsed)`,
  );
  advanceStage(project, 'render');
}

export async function cmdThumbnail(project: string): Promise<void> {
  const p = paths(project);
  if (!existsSync(p.finalVideo)) {
    throw new ValidationError(`No final render at ${p.finalVideo}. Render first.`, 'thumbnail');
  }
  const result = await extractThumbnail(p.finalVideo, p.thumbnail);
  log.info(
    `Thumbnail: ${result.path} @ ${result.sourceTimeSeconds.toFixed(2)}s - ${result.reason}`,
  );
  advanceStage(project, 'thumbnail');
}

/** Report-only by policy: never triggers paid regeneration. */
export async function cmdQaFinal(project: string): Promise<void> {
  const p = paths(project);
  const plan = validateArtifact(project, 'edit-plan.json').data;
  if (!existsSync(p.finalVideo)) {
    throw new ValidationError(`No final render at ${p.finalVideo}. Render first.`, 'qa-final');
  }
  const report = await runFinalQa(p.finalVideo, plan);
  process.stdout.write(`\n${formatFinalQa(report)}\n\n`);
  advanceStage(project, 'qa-final');
}

/** Actual spend, read from the manifest - never the estimate. */
export function cmdReport(project: string): void {
  const file = writeCostReport(project);
  log.info(`Cost report: ${file}`);
  process.stdout.write(`\n${renderCostReport(project)}\n`);
  advanceStage(project, 'report');
}

/* ------------------------------------------------------------------ status */

export function cmdStatus(project: string): void {
  const state = readState(project);
  const p = paths(project);

  process.stdout.write(`\n  Project:  ${state.projectName}\n`);
  process.stdout.write(`  Idea:     ${state.idea}\n`);
  process.stdout.write(`  Mode:     ${state.mode}\n`);
  process.stdout.write(`  Stage:    ${state.stage}\n`);
  process.stdout.write(
    `  Budget:   $${state.budget.spentUSD.toFixed(2)} spent, ` +
      `$${state.budget.reservedUSD.toFixed(2)} reserved of ` +
      `$${state.budget.maxBudgetUSD.toFixed(2)}\n`,
  );

  process.stdout.write('\n  Gates:\n');
  for (const [name, gate] of Object.entries(state.gates)) {
    process.stdout.write(`    ${name.padEnd(8)} ${gate.status}\n`);
  }

  process.stdout.write('\n  Planning artifacts:\n');
  for (const a of surveyArtifacts(project)) {
    const icon = !a.exists ? '·' : a.valid ? '✓' : '✗';
    process.stdout.write(`    ${icon}  ${a.name}\n`);
  }

  if (state.warnings.length > 0) {
    process.stdout.write('\n  Warnings:\n');
    for (const w of state.warnings) process.stdout.write(`    ! ${w}\n`);
  }

  if (existsSync(p.costEstimate)) {
    process.stdout.write(`\n  Cost estimate: ${p.costEstimate}\n`);
  }
  process.stdout.write('\n');
}

/* ------------------------------------------------------------------- guard */

// The former `assertGateApproved` wrapper lived here and was called by
// nothing, so the gates it was meant to enforce were never enforced.
// `generateShot` now calls `requireApproval` directly, at the point where
// money is actually about to move.
