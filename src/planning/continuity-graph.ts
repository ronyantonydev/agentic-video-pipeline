/**
 * Continuity graph validation. Architecture section 13.
 *
 * The rule that matters: a bad shot_04 must never cause paid generation of
 * shot_05. That requires knowing, before spending, which shots depend on
 * which - and refusing to execute a graph that cannot be satisfied.
 */

import type { Shot, Shotlist } from '../schemas/planning.js';
import { ValidationError } from '../util/errors.js';

export type GraphIssue = { severity: 'error' | 'warning'; message: string; shotId?: string };

export type ContinuityGraph = {
  /** Shots with no previous-shot dependency - safe to run concurrently. */
  parallelizable: Shot[];
  /** Ordered chains that must execute serially, each element depending on the last. */
  chains: Shot[][];
  issues: GraphIssue[];
  longestChain: number;
};

/**
 * Build and validate the dependency graph.
 *
 * Errors mean the plan cannot execute. Warnings (long chains) are allowed
 * through because drift is a quality risk, not a correctness failure.
 */
export function buildContinuityGraph(
  shotlist: Shotlist,
  opts: { maxChainLength: number; warnOnChainLengthAbove: number },
): ContinuityGraph {
  const shots = shotlist.shots;
  const byId = new Map(shots.map((s) => [s.id, s]));
  const issues: GraphIssue[] = [];

  // 1. Every previousShot reference must resolve.
  for (const shot of shots) {
    if (shot.continuityMode !== 'previous-shot') continue;

    const ref = shot.previousShot;
    if (!ref) {
      issues.push({
        severity: 'error',
        message: `${shot.id} is previous-shot but names no previousShot`,
        shotId: shot.id,
      });
      continue;
    }
    if (!byId.has(ref)) {
      issues.push({
        severity: 'error',
        message: `${shot.id} depends on ${ref}, which does not exist`,
        shotId: shot.id,
      });
      continue;
    }
    if (ref === shot.id) {
      issues.push({
        severity: 'error',
        message: `${shot.id} depends on itself`,
        shotId: shot.id,
      });
    }
  }

  // 2. No cycles. A cycle would deadlock execution - nothing could start.
  for (const cycle of findCycles(shots, byId)) {
    issues.push({
      severity: 'error',
      message: `continuity cycle: ${cycle.join(' -> ')}`,
      shotId: cycle[0],
    });
  }

  // 3. A dependency must be generated before its dependant.
  for (const shot of shots) {
    if (shot.continuityMode !== 'previous-shot' || !shot.previousShot) continue;
    const dep = byId.get(shot.previousShot);
    if (dep && dep.index >= shot.index) {
      issues.push({
        severity: 'error',
        message:
          `${shot.id} (index ${shot.index}) depends on ${dep.id} (index ${dep.index}), ` +
          `which comes later - a dependency cannot follow its dependant`,
        shotId: shot.id,
      });
    }
  }

  const hasErrors = issues.some((i) => i.severity === 'error');
  const chains = hasErrors ? [] : buildChains(shots, byId);
  const longestChain = chains.reduce((max, c) => Math.max(max, c.length), 0);

  // 4. Long chains accumulate visual drift. Warn, do not fail (section 13).
  for (const chain of chains) {
    if (chain.length > opts.maxChainLength) {
      issues.push({
        severity: 'warning',
        message:
          `chain of ${chain.length} shots (${chain[0]!.id}...${chain[chain.length - 1]!.id}) ` +
          `exceeds the ${opts.maxChainLength}-shot limit; visual drift is likely`,
        shotId: chain[0]!.id,
      });
    } else if (chain.length > opts.warnOnChainLengthAbove) {
      issues.push({
        severity: 'warning',
        message: `chain of ${chain.length} shots starting at ${chain[0]!.id} may drift`,
        shotId: chain[0]!.id,
      });
    }
  }

  const chained = new Set(chains.flat().map((s) => s.id));
  const parallelizable = shots.filter((s) => !chained.has(s.id));

  return { parallelizable, chains, issues, longestChain };
}

/** Throw if the graph cannot execute. Warnings pass through. */
export function assertExecutableGraph(graph: ContinuityGraph): void {
  const errors = graph.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new ValidationError(
      `Continuity graph is not executable:\n  ${errors.map((e) => e.message).join('\n  ')}`,
      'shotlist.json',
      errors.map((e) => e.message),
    );
  }
}

/**
 * Walk each previous-shot dependency to its root, collecting cycles.
 * Uses colour marking rather than a visited set so a shared tail is not
 * mistaken for a cycle.
 */
function findCycles(shots: Shot[], byId: Map<string, Shot>): string[][] {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>(shots.map((s) => [s.id, WHITE]));
  const cycles: string[][] = [];

  function visit(id: string, path: string[]): void {
    const state = colour.get(id);
    if (state === BLACK) return;
    if (state === GREY) {
      const start = path.indexOf(id);
      cycles.push([...path.slice(start), id]);
      return;
    }

    colour.set(id, GREY);
    const shot = byId.get(id);
    if (shot?.continuityMode === 'previous-shot' && shot.previousShot) {
      if (byId.has(shot.previousShot)) visit(shot.previousShot, [...path, id]);
    }
    colour.set(id, BLACK);
  }

  for (const shot of shots) visit(shot.id, []);
  return cycles;
}

/**
 * Group dependent shots into ordered execution chains.
 * Only called on a graph already known to be acyclic.
 */
function buildChains(shots: Shot[], byId: Map<string, Shot>): Shot[][] {
  const dependants = new Map<string, string>();
  for (const shot of shots) {
    if (shot.continuityMode === 'previous-shot' && shot.previousShot) {
      dependants.set(shot.previousShot, shot.id);
    }
  }

  const isDependency = new Set(dependants.keys());
  const dependsOnSomething = new Set(
    shots
      .filter((s) => s.continuityMode === 'previous-shot' && s.previousShot)
      .map((s) => s.id),
  );

  // A chain starts at a shot that others depend on but which depends on nothing.
  const chains: Shot[][] = [];
  for (const shot of shots) {
    if (dependsOnSomething.has(shot.id)) continue;
    if (!isDependency.has(shot.id)) continue;

    const chain: Shot[] = [shot];
    let nextId = dependants.get(shot.id);
    while (nextId) {
      const next = byId.get(nextId);
      if (!next) break;
      chain.push(next);
      nextId = dependants.get(nextId);
    }
    chains.push(chain);
  }

  return chains;
}

/**
 * Execution order: parallel batches first, then each chain in sequence.
 * Architecture section 14.
 */
export function executionPlan(graph: ContinuityGraph): {
  parallelBatch: string[];
  serialChains: string[][];
} {
  return {
    parallelBatch: graph.parallelizable.map((s) => s.id),
    serialChains: graph.chains.map((c) => c.map((s) => s.id)),
  };
}
