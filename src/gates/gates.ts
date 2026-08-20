/**
 * Human approval gates. Architecture section 21.
 *
 * Never block the CLI waiting for input. A gate writes state, prints what
 * the human needs to decide, and exits. Approval is a separate invocation.
 *
 * This is what makes a run survive a closed terminal, a sleeping laptop, or
 * an ended Claude session.
 */

import { updateState, readState } from '../state/store.js';
import { GatePending } from '../util/errors.js';
import { log } from '../util/logger.js';
import type { GateNameT, State } from '../schemas/state.js';

const GATE_STAGE = {
  cost: 'gate-cost',
  look: 'gate-look',
  review: 'review',
} as const;

/**
 * Mark a gate as awaiting a decision and stop the run.
 *
 * @throws GatePending always - the caller is expected to let this propagate
 *         to the CLI, which exits with code 3.
 */
export function requestApproval(
  project: string,
  gate: GateNameT,
  summary: string[],
): never {
  updateState(project, (s) => ({
    ...s,
    stage: GATE_STAGE[gate],
    gates: {
      ...s.gates,
      [gate]: { status: 'pending', requestedAt: new Date().toISOString() },
    },
  }));

  log.stage(`GATE ${gate.toUpperCase()} - approval required`);
  for (const line of summary) process.stdout.write(`  ${line}\n`);
  process.stdout.write('\n');

  throw new GatePending(gate, `npm run approve -- ${project} --gate ${gate}`);
}

/**
 * Record a decision. Called by `npm run approve`.
 *
 * @param by Who decided. 'human' is a person answering a gate that was
 *        already requested, so a not-reached gate is a mistake worth
 *        refusing. 'system' is the pipeline deciding at the moment the gate
 *        is reached - an estimate that fits the stated budget approves
 *        itself (section 5), and that decision is necessarily taken while
 *        the gate is still not-reached. Refusing it there made the
 *        auto-approve path unreachable: it always threw instead of
 *        continuing.
 */
export function decideGate(
  project: string,
  gate: GateNameT,
  decision: 'approved' | 'rejected',
  note?: string,
  by: 'human' | 'system' = 'human',
): State {
  const state = readState(project);
  const current = state.gates[gate];

  if (current.status === 'not-reached' && by === 'human') {
    throw new GatePending(
      gate,
      `Gate "${gate}" has not been reached yet - nothing to approve.`,
    );
  }

  if (current.status === 'approved' && decision === 'approved') {
    log.info(`Gate "${gate}" was already approved at ${current.decidedAt}.`);
    return state;
  }

  return updateState(project, (s) => ({
    ...s,
    gates: {
      ...s.gates,
      [gate]: {
        ...s.gates[gate],
        status: decision,
        decidedAt: new Date().toISOString(),
        decidedBy: by,
        ...(note !== undefined ? { note } : {}),
      },
    },
  }));
}

export function isApproved(project: string, gate: GateNameT): boolean {
  return readState(project).gates[gate].status === 'approved';
}

/**
 * Guard a stage behind its gate.
 *
 * @throws GatePending when approval has not been granted. Paid work must
 *         never run on an unapproved gate.
 */
export function requireApproval(project: string, gate: GateNameT): void {
  const state = readState(project);
  const status = state.gates[gate].status;

  if (status === 'approved') return;

  if (status === 'rejected') {
    throw new GatePending(
      gate,
      `Gate "${gate}" was rejected${state.gates[gate].note ? `: ${state.gates[gate].note}` : ''}. ` +
        `Revise the plan and re-run, or approve explicitly.`,
    );
  }

  throw new GatePending(gate, `npm run approve -- ${project} --gate ${gate}`);
}

/** Reset a gate so a revised plan can be re-approved. */
export function resetGate(project: string, gate: GateNameT): State {
  return updateState(project, (s) => ({
    ...s,
    gates: { ...s.gates, [gate]: { status: 'not-reached' } },
  }));
}
