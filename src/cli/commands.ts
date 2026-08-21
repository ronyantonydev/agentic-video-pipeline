/**
 * Stage implementations behind the CLI verbs.
 *
 * Each stage validates, does its work, writes state, and returns. Nothing
 * here blocks on human input - gates throw GatePending instead.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadProjectDefaults, loadQualityPolicy } from '../config/loader.js';
import { loadEnv } from '../config/env.js';
import { ensureProjectDirs, isValidProjectName, paths } from '../state/paths.js';
import { readState, writeState, advanceStage, addWarning, stateExists } from '../state/store.js';
import { emptyState } from '../schemas/state.js';
import { writeFileAtomic, readJsonIfExists } from '../util/atomic.js';
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
import { buildPlanReport, renderPlanReport, writePlanReport } from '../reports/plan-report.js';
import { buildContinuityGraph, assertExecutableGraph, executionPlan } from '../planning/continuity-graph.js';
import { lintMotionRatio, formatLintResult } from '../planning/motion-lint.js';
import {
  estimateGenerationPlan, renderCostEstimateMarkdown, writeCostEstimate,
} from '../reports/cost-estimate.js';
import { requestApproval, decideGate } from '../gates/gates.js';
import { PlanSchema } from '../schemas/planning.js';
import { checkReadiness, formatReadiness } from '../planning/readiness.js';
import { isRejectedPlate, type ReferenceCheck } from '../qa/reference-gate.js';
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

/* -------------------------------------------------------------- set-budget */

/**
 * Change the ceiling on an existing project.
 *
 * The budget was previously fixed at init, which broke the plan-then-commit
 * flow: /plan-video prices several models *after* the project exists, so a
 * user who inits at $20 and then picks a $28 option had no supported way
 * forward except deleting the project. Raising it must still be an explicit
 * act with a stated number - never inferred from an estimate that overran.
 */
export function cmdSetBudget(project: string, maxBudgetUSD: number): void {
  if (!Number.isFinite(maxBudgetUSD) || maxBudgetUSD < 0) {
    throw new ValidationError(
      `Budget must be a non-negative number, got "${maxBudgetUSD}".`,
      'budget',
    );
  }

  const state = readState(project);
  const committed = state.budget.spentUSD + state.budget.reservedUSD;
  if (maxBudgetUSD < committed) {
    throw new ValidationError(
      `Cannot set the budget to $${maxBudgetUSD.toFixed(2)}: ` +
        `$${committed.toFixed(2)} is already spent or reserved on this project.`,
      'budget',
    );
  }

  const previous = state.budget.maxBudgetUSD;
  writeState(project, {
    ...state,
    budget: { ...state.budget, maxBudgetUSD },
  });

  log.info(
    `Budget for "${project}": $${previous.toFixed(2)} → $${maxBudgetUSD.toFixed(2)}`,
  );
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

/* ------------------------------------------------------------- plan report */

/**
 * Render the plan into one page a human can act on.
 *
 * Free - reads files and re-runs the cheap image checks. Spends nothing.
 */
export async function cmdPlanReport(project: string): Promise<void> {
  const report = await buildPlanReport(project);
  const file = writePlanReport(project, renderPlanReport(report));

  log.info(`Plan report: ${file}`);
  if (!report.ready) {
    log.warn(`${report.blockers.length} blocker(s) - see the report.`);
    // Non-zero so a scripted run stops rather than approving a broken plan.
    process.exitCode = 4;
    return;
  }
  log.info(`${report.humanChecks.length} thing(s) for you to look at before approving.`);
}

/* ------------------------------------------------------- the run contract */

/**
 * Validate plan.json and check it against the artifacts it summarises.
 *
 * plan.json is the one file `/run-video` reads. Validating its shape is not
 * enough: a contract that disagrees with the artifacts is worse than no
 * contract, because the run follows the contract and the human reviewed the
 * artifacts. So every claim it makes about shots, runtime and cost is
 * cross-checked against the file that owns that fact.
 */
export function cmdPlanContract(project: string): void {
  const raw = readJsonIfExists<unknown>(paths(project).plan, null);
  if (raw === null) {
    throw new ValidationError(
      `plan.json missing. It is the contract /run-video reads - without it the plan is ` +
        `incomplete, however many artifacts exist.`,
      'plan.json',
    );
  }

  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      `plan.json is invalid:\n  ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ')}`,
      'plan.json',
      parsed.error.issues.map((i) => i.message),
    );
  }
  const plan = parsed.data;

  const problems: string[] = [];

  // Against generation-plan.json: same shots, same models, same durations.
  const gen = validateArtifact(project, 'generation-plan.json').data;
  const genById = new Map(gen.items.map((i) => [i.shotId, i]));
  if (gen.items.length !== plan.shots.length) {
    problems.push(
      `plan.json has ${plan.shots.length} shot(s), generation-plan.json has ${gen.items.length}`,
    );
  }
  for (const s of plan.shots) {
    const g = genById.get(s.id);
    if (!g) {
      problems.push(`${s.id} is in plan.json but not in generation-plan.json`);
      continue;
    }
    if (g.modelId !== s.model) {
      problems.push(`${s.id}: plan says model ${s.model}, generation-plan says ${g.modelId}`);
    }
    if (Math.abs(g.billableSeconds - s.seconds) > 0.001) {
      problems.push(
        `${s.id}: plan says ${s.seconds}s, generation-plan bills ${g.billableSeconds}s`,
      );
    }
  }

  // Against edit-plan.json: the runtime split must be real, not asserted.
  const edit = validateArtifact(project, 'edit-plan.json').data;
  if (Math.abs(edit.totalDurationSeconds - plan.runtime.totalSeconds) > 0.01) {
    problems.push(
      `plan.json runtime is ${plan.runtime.totalSeconds}s, edit-plan is ` +
        `${edit.totalDurationSeconds}s`,
    );
  }
  const generatedInEdit = edit.items
    .filter((i) => !i.isStill)
    .reduce((sum, i) => sum + i.screenDurationSeconds, 0);
  if (Math.abs(generatedInEdit - plan.runtime.generatedSeconds) > 0.01) {
    problems.push(
      `plan.json claims ${plan.runtime.generatedSeconds}s generated, edit-plan has ` +
        `${round2(generatedInEdit)}s of non-still items`,
    );
  }

  if (problems.length > 0) {
    throw new ValidationError(
      `plan.json disagrees with the artifacts it summarises:\n  ${problems.join('\n  ')}`,
      'plan.json',
      problems,
    );
  }

  log.info(`plan.json valid - ${plan.shots.length} shot(s), ${plan.runtime.totalSeconds}s`);
  log.info(
    `  ${plan.runtime.generatedSeconds}s generated, ${plan.runtime.composedSeconds}s composed`,
  );
  log.info(
    `  ${plan.cost.minimumCredits}cr minimum, ${plan.cost.withRetriesCredits}cr with retries`,
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* --------------------------------------------------------------- gate look */

/**
 * Raise the look gate once the references pass their check.
 *
 * Called by `refcheck`, which is the first point where there is a look to
 * judge: the reference sheets exist on disk and have been verified readable.
 * Everything downstream inherits from them, so a wrong plate here is wrong
 * in every shot generated against it - cheap to redo now, expensive later.
 *
 * Throws GatePending, which the CLI reports as exit 3.
 */
export function cmdRequestLook(
  project: string,
  check: ReferenceCheck,
  contactSheet?: string | null,
): never {
  const p = paths(project);
  const sheets: string[] = [];
  for (const category of ['character', 'environment', 'props', 'style'] as const) {
    const dir = p.referenceCategory(category);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)
      .filter((n) => /\.(png|jpe?g|webp)$/i.test(n) && !isRejectedPlate(n))
      .sort()) {
      sheets.push(`  ${category}/${f}`);
    }
  }

  // Anchor frames decide the opening and closing image of the shots carrying
  // the most weight, and the model fills in between them - so a wrong frame
  // is wrong for the whole clip. They belong in front of the human at this
  // gate just as much as the plates do.
  const frames: string[] = existsSync(p.storyboardFrames)
    ? readdirSync(p.storyboardFrames)
        .filter((n) => /\.(png|jpe?g|webp)$/i.test(n) && !isRejectedPlate(n))
        .sort()
        .map((f) => `  storyboard/frames/${f}`)
    : [];

  requestApproval(project, 'look', [
    'Look at these before any video is generated. Every shot is generated',
    'against them, so a wrong plate here is wrong in all of them.',
    '',
    ...(sheets.length > 0 ? ['References:', ...sheets] : ['No reference images.']),
    ...(frames.length > 0
      ? ['', 'Anchor frames (a wrong one is wrong for the whole clip):', ...frames]
      : []),
    ...(contactSheet ? ['', 'All of them on one page:', `  ${contactSheet}`] : []),
    ...(check.warnings.length > 0
      ? ['', 'Warnings:', ...check.warnings.map((w) => `  ${w}`)]
      : []),
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

/* ------------------------------------------------------------- readiness */

/**
 * The whole question: would /run-video finish?
 *
 * Every other check answers one part well. This asks whether the parts add up,
 * which is where the holes hide - a plan can pass every schema and still be
 * missing the image a title card renders from.
 */
export function cmdReadiness(project: string): void {
  const result = checkReadiness(project);
  process.stdout.write(formatReadiness(result));
  if (!result.ready) {
    // Non-zero so a scripted run stops rather than proceeding to spend.
    process.exitCode = 4;
  }
}
