import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestApproval, decideGate, isApproved, requireApproval, resetGate } from '../src/gates/gates.js';
import { writeState, readState } from '../src/state/store.js';
import { ensureProjectDirs } from '../src/state/paths.js';
import { emptyState } from '../src/schemas/state.js';
import { GatePending } from '../src/util/errors.js';

const SETTINGS = { width: 1920, height: 1080, fps: 30, colorspace: 'bt709', aspectRatio: '16:9' };
const PROJECT = 'gate-test';

let cwd: string;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'avp-gates-'));
  cwd = process.cwd();
  process.chdir(tmp);
  ensureProjectDirs(PROJECT);
  writeState(PROJECT, emptyState({
    projectName: PROJECT, idea: 'test', mode: 'full',
    maxBudgetUSD: 20, projectSettings: SETTINGS,
  }));
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe('gate lifecycle', () => {
  it('starts not-reached and unapproved', () => {
    expect(readState(PROJECT).gates.cost.status).toBe('not-reached');
    expect(isApproved(PROJECT, 'cost')).toBe(false);
  });

  it('requesting approval writes state and throws GatePending', () => {
    // Section 21: never block the CLI - write state, print, exit.
    expect(() => requestApproval(PROJECT, 'cost', ['$6.85'])).toThrow(GatePending);
    expect(readState(PROJECT).gates.cost.status).toBe('pending');
    expect(readState(PROJECT).stage).toBe('gate-cost');
  });

  it('records the resume command in the error', () => {
    try {
      requestApproval(PROJECT, 'cost', []);
      expect.unreachable();
    } catch (err) {
      expect((err as GatePending).resumeCommand).toContain('--gate cost');
    }
  });

  it('blocks work until approved', () => {
    expect(() => requestApproval(PROJECT, 'cost', [])).toThrow();
    expect(() => requireApproval(PROJECT, 'cost')).toThrow(GatePending);

    decideGate(PROJECT, 'cost', 'approved');
    expect(() => requireApproval(PROJECT, 'cost')).not.toThrow();
  });

  it('survives a process restart - state is on disk, not in memory', () => {
    expect(() => requestApproval(PROJECT, 'cost', [])).toThrow();
    decideGate(PROJECT, 'cost', 'approved', 'looks good');

    // A fresh read is what a later CLI invocation would do.
    const reloaded = readState(PROJECT);
    expect(reloaded.gates.cost.status).toBe('approved');
    expect(reloaded.gates.cost.note).toBe('looks good');
    expect(reloaded.gates.cost.decidedAt).toBeDefined();
  });

  it('keeps gates independent', () => {
    expect(() => requestApproval(PROJECT, 'cost', [])).toThrow();
    decideGate(PROJECT, 'cost', 'approved');

    // Approving cost must not unlock the look gate.
    expect(isApproved(PROJECT, 'look')).toBe(false);
    expect(() => requireApproval(PROJECT, 'look')).toThrow(GatePending);
  });

  it('blocks a rejected gate with its reason', () => {
    expect(() => requestApproval(PROJECT, 'cost', [])).toThrow();
    decideGate(PROJECT, 'cost', 'rejected', 'too expensive');

    try {
      requireApproval(PROJECT, 'cost');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/too expensive/);
    }
  });

  it('refuses to decide a gate that was never reached', () => {
    expect(() => decideGate(PROJECT, 'look', 'approved')).toThrow(GatePending);
  });

  it('treats a repeat approval as a no-op', () => {
    expect(() => requestApproval(PROJECT, 'cost', [])).toThrow();
    const first = decideGate(PROJECT, 'cost', 'approved');
    const second = decideGate(PROJECT, 'cost', 'approved');
    expect(second.gates.cost.decidedAt).toBe(first.gates.cost.decidedAt);
  });

  it('allows re-approval after a reset for a revised plan', () => {
    expect(() => requestApproval(PROJECT, 'cost', [])).toThrow();
    decideGate(PROJECT, 'cost', 'rejected', 'revise');
    resetGate(PROJECT, 'cost');

    expect(readState(PROJECT).gates.cost.status).toBe('not-reached');
    expect(() => requireApproval(PROJECT, 'cost')).toThrow(GatePending);
  });
});
