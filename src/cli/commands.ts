/**
 * Stage implementations behind the CLI verbs.
 *
 * Each stage validates, does its work, writes state, and returns. Nothing
 * here blocks on human input - gates throw GatePending instead.
 */

import { existsSync } from 'node:fs';
import { loadProjectDefaults, loadQualityPolicy } from '../config/loader.js';
import { loadEnv } from '../config/env.js';
import { ensureProjectDirs, isValidProjectName, paths } from '../state/paths.js';
import { readState, writeState, advanceStage, addWarning, stateExists } from '../state/store.js';
import { emptyState } from '../schemas/state.js';
import { writeFileAtomic } from '../util/atomic.js';
import { validateArtifact, surveyArtifacts, validateCrossReferences } from '../planning/validate.js';
import { buildContinuityGraph, assertExecutableGraph, executionPlan } from '../planning/continuity-graph.js';
import { lintMotionRatio, formatLintResult } from '../planning/motion-lint.js';
import {
  estimateGenerationPlan, renderCostEstimateMarkdown, writeCostEstimate,
} from '../reports/cost-estimate.js';
import { requestApproval, decideGate, requireApproval } from '../gates/gates.js';
import { ValidationError } from '../util/errors.js';
import { log } from '../util/logger.js';
import type { GateNameT } from '../schemas/state.js';

/* -------------------------------------------------------------------- init */

export function cmdInit(project: string, idea: string, mode: 'full' | 'proof' | 'dry-run'): void {
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
      maxBudgetUSD: env.MAX_BUDGET_USD,
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

export async function cmdCost(
  project: string,
  opts: { dryRun?: boolean; allowApi?: boolean } = {},
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

  requestApproval(project, 'cost', [
    `Estimated cost: ${estimate.totalCredits} credits (~$${estimate.totalUSD.toFixed(2)})`,
    `Budget:         $${estimate.maxBudgetUSD.toFixed(2)}`,
    estimate.fitsInBudget
      ? `Status:         fits`
      : `Status:         OVER BUDGET by $${estimate.overageUSD.toFixed(2)}`,
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

/** Used by generation stages to refuse work on an unapproved gate. */
export function assertGateApproved(project: string, gate: GateNameT): void {
  requireApproval(project, gate);
}
