import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkReferences, readReferenceCheck, assertReferencesVerified,
} from '../src/qa/reference-gate.js';
import { generateShot } from '../src/orchestrator/generate.js';
import { FakeProvider } from '../src/higgsfield/fake-provider.js';
import { writeState } from '../src/state/store.js';
import { ensureProjectDirs, paths } from '../src/state/paths.js';
import { recordLearnedCost } from '../src/budget/cost.js';
import { budgetSnapshot } from '../src/budget/guard.js';
import { readManifest } from '../src/manifest/store.js';
import { emptyState, STAGES } from '../src/schemas/state.js';
import { ValidationError } from '../src/util/errors.js';
import type { GenerationItem } from '../src/schemas/planning.js';

const SETTINGS = { width: 1920, height: 1080, fps: 30, colorspace: 'bt709', aspectRatio: '16:9' };
const PROJECT = 'ref-gate';

let cwd: string;
let tmp: string;

function makeImage(path: string, filter = 'testsrc2=size=1280x720:rate=1'): string {
  mkdirSync(join(path, '..'), { recursive: true });
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', filter, '-frames:v', '1', path,
  ], { stdio: 'ignore' });
  return path;
}

/** A full six-image character pack. */
function makePack(project: string, count = 6): void {
  const dir = paths(project).referenceCategory('character');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) makeImage(join(dir, `ref-${i}.png`));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'avp-refgate-'));
  cwd = process.cwd();
  process.chdir(tmp);
  ensureProjectDirs(PROJECT);
  writeState(PROJECT, emptyState({
    projectName: PROJECT, idea: 'test', mode: 'full',
    maxBudgetUSD: 20, projectSettings: SETTINGS,
  }));
  recordLearnedCost(
    PROJECT,
    { modelId: 'test/model', kind: 'video', durationSeconds: 5, aspectRatio: '16:9', settings: {} },
    10, 0.63,
  );
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
});

const item = (over: Partial<GenerationItem> = {}): GenerationItem => ({
  shotId: 'shot_001', modelId: 'test/model',
  requiredSeconds: 4.2, billableSeconds: 5,
  prompt: 'a man digging', aspectRatio: '16:9',
  usesStartFrame: false, usesEndFrame: false, nativeAudio: false, settings: {},
  ...over,
});

const OPTS = {
  maxSingleCallUSD: 3,
  // This suite is about the REFERENCE gate. The human approval gates are a
  // separate guard with their own coverage, so opt out to keep the subject
  // of each test to one thing.
  requireApprovedGates: false,
  poll: { initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 2, timeoutMs: 5000, sleep: async () => {} },
};

describe('the stage exists and sits before generation', () => {
  it('reference-check precedes generate-shots', () => {
    // Position matters: resume compares indexes, so the gate must provably
    // come before the work it guards.
    expect(STAGES.indexOf('reference-check')).toBeLessThan(STAGES.indexOf('generate-shots'));
    expect(STAGES.indexOf('references')).toBeLessThan(STAGES.indexOf('reference-check'));
  });
});

describe('reference check', () => {
  it('blocks when no character reference exists', async () => {
    const check = await checkReferences(PROJECT);
    expect(check.pass).toBe(false);
    expect(check.blockers.join(' ')).toMatch(/no character reference/i);
  }, 60_000);

  it('passes with a full pack, warning about missing sheets', async () => {
    makePack(PROJECT);
    const check = await checkReferences(PROJECT);
    expect(check.pass).toBe(true);
    expect(check.characterPack.meetsPackSize).toBe(true);
    // Sheets degrade consistency but do not make generation impossible.
    expect(check.warnings.join(' ')).toMatch(/environment sheet/i);
  }, 120_000);

  it('ignores a superseded plate, so a reject is never offered for approval', async () => {
    // A plate that was looked at and replaced stays on disk as the evidence
    // for why its replacement exists. Listing it beside the live plate lets a
    // user approve the version that was already rejected.
    makePack(PROJECT);
    const styleDir = paths(PROJECT).referenceCategory('style');
    mkdirSync(styleDir, { recursive: true });
    makeImage(join(styleDir, 'style-sheet.png'));
    makeImage(join(styleDir, 'style-sheet-rejected-v1.png'));

    const check = await checkReferences(PROJECT);
    expect(check.sheets.style).toBe(1);
  }, 120_000);

  it('counts a short pack correctly when a reject sits beside it', async () => {
    // The reject must not pad the pack up to the recommended size either.
    makePack(PROJECT, 2);
    const dir = paths(PROJECT).referenceCategory('character');
    makeImage(join(dir, 'face-front-rejected-blurry.png'));

    const check = await checkReferences(PROJECT);
    expect(check.characterPack.imageCount).toBe(2);
    expect(check.characterPack.meetsPackSize).toBe(false);
  }, 120_000);

  it('warns rather than blocks on a short pack', async () => {
    // One reference held identity in wide shots on the real project and
    // failed in close-ups. That is a warning, not an impossibility.
    makePack(PROJECT, 1);
    const check = await checkReferences(PROJECT);
    expect(check.pass).toBe(true);
    expect(check.characterPack.meetsPackSize).toBe(false);
    expect(check.warnings.join(' ')).toMatch(/fewer than the 6/i);
  }, 60_000);

  it('blocks on a corrupt reference image', async () => {
    // A broken reference poisons every shot that uses it.
    const dir = paths(PROJECT).referenceCategory('character');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.png'), 'not an image');

    const check = await checkReferences(PROJECT);
    expect(check.pass).toBe(false);
    expect(check.blockers.join(' ')).toMatch(/broken\.png/);
  }, 60_000);

  it('skips the character requirement when no person appears', async () => {
    const check = await checkReferences(PROJECT, { needsCharacter: false });
    expect(check.pass).toBe(true);
  }, 60_000);

  it('records a passing drift test', async () => {
    makePack(PROJECT);
    const samples = [1, 2, 3].map((i) => makeImage(join(tmp, `s${i}.png`)));
    const check = await checkReferences(PROJECT, { driftSamples: samples });

    expect(check.driftTest).not.toBeNull();
    expect(check.driftTest!.holds).toBe(true);
    expect(check.pass).toBe(true);
  }, 180_000);

  it('warns but does NOT block when the drift score is low', async () => {
    // A low score is advisory, never a blocker.
    //
    // Measured 2026-08-20 on this project's own assets: five real samples of
    // the character scored 0.391-0.734 against the master while a photo of a
    // STOOL scored 0.500 - above two of the five. A 64-bit perceptual hash
    // averages ~0.5 between any two unrelated images, so every one of those
    // numbers is inside the noise floor. Face-cropping first, tested both
    // loosely and tightly aligned, widened the spread instead of separating
    // it. There is no threshold that tells a face from a stool.
    //
    // Blocking on that number stopped every run and was overridden every
    // time. The score is still recorded and surfaced as a smoke signal.
    makePack(PROJECT);
    const samples = [
      makeImage(join(tmp, 'd1.png'), 'color=c=gray:size=1280x720'),
      makeImage(join(tmp, 'd2.png'), 'color=c=gray:size=1280x720'),
    ];
    const check = await checkReferences(PROJECT, { driftSamples: samples });

    expect(check.driftTest!.holds).toBe(false);
    expect(check.pass).toBe(true); // <- continues
    expect(check.blockers).toHaveLength(0);
    expect(check.warnings.join(' ')).toMatch(/advisory only/i);
  }, 180_000);

  it('lets generation proceed after a low drift score', async () => {
    // The end-to-end promise: a low score never stops a run.
    makePack(PROJECT);
    const samples = [
      makeImage(join(tmp, 'e1.png'), 'color=c=gray:size=1280x720'),
      makeImage(join(tmp, 'e2.png'), 'color=c=gray:size=1280x720'),
    ];
    await checkReferences(PROJECT, { driftSamples: samples });
    expect(() => assertReferencesVerified(PROJECT)).not.toThrow();
  }, 180_000);

  it('warns when the drift test was not run at all', async () => {
    makePack(PROJECT);
    const check = await checkReferences(PROJECT);
    expect(check.warnings.join(' ')).toMatch(/drift test not run/i);
  }, 120_000);

  it('persists the result to disk', async () => {
    makePack(PROJECT);
    await checkReferences(PROJECT);
    expect(readReferenceCheck(PROJECT)?.pass).toBe(true);
  }, 120_000);
});

describe('the gate', () => {
  it('refuses when no check has been run', () => {
    // "Not checked" is as unsafe as "checked and bad".
    expect(() => assertReferencesVerified(PROJECT)).toThrow(ValidationError);
    expect(() => assertReferencesVerified(PROJECT)).toThrow(/have not been verified/i);
  });

  it('refuses when the check failed', async () => {
    await checkReferences(PROJECT);   // no pack, so it fails
    expect(() => assertReferencesVerified(PROJECT)).toThrow(/refusing to generate/i);
  }, 60_000);

  it('allows once the check passes', async () => {
    makePack(PROJECT);
    await checkReferences(PROJECT);
    expect(() => assertReferencesVerified(PROJECT)).not.toThrow();
  }, 120_000);
});

describe('generation is blocked by the gate', () => {
  it('refuses to spend when references were never verified', async () => {
    // This is the behaviour the whole gate exists for: an instruction Claude
    // might skip becomes a code path it cannot.
    const provider = new FakeProvider({ stubMedia: true });

    await expect(generateShot(PROJECT, item(), provider, OPTS))
      .rejects.toThrow(/have not been verified/i);

    const snap = budgetSnapshot(PROJECT);
    expect(snap.spentUSD).toBe(0);
    expect(snap.reservedUSD).toBe(0);
    expect(readManifest(PROJECT).entries).toHaveLength(0);
  }, 60_000);

  it('generates once references are verified', async () => {
    makePack(PROJECT);
    await checkReferences(PROJECT);

    const provider = new FakeProvider({ stubMedia: true });
    const r = await generateShot(PROJECT, item(), provider, OPTS);

    expect(r.reused).toBe(false);
    expect(budgetSnapshot(PROJECT).spentUSD).toBeGreaterThan(0);
  }, 120_000);

  it('can be disabled explicitly, and says so in the type', async () => {
    // An escape hatch has to exist for tests and for shots with no
    // character, but it must be deliberate rather than the default.
    const provider = new FakeProvider({ stubMedia: true });
    const r = await generateShot(
      PROJECT, item(), provider, { ...OPTS, requireVerifiedReferences: false },
    );
    expect(r.reused).toBe(false);
  }, 60_000);
});
