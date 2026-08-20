import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordDecision, pendingReview, reviewSummary, applyFallbacks,
  fallbackSourceFor, completeReview,
} from '../src/qa/review.js';
import { lintAfterFallbacks } from '../src/planning/motion-lint.js';
import { visionChecklist, canAutoSpend } from '../src/qa/vision.js';
import { writeState, readState } from '../src/state/store.js';
import { appendEntry, readManifest, computeAssetHash } from '../src/manifest/store.js';
import { ensureProjectDirs, paths } from '../src/state/paths.js';
import { emptyState, type ManifestEntry } from '../src/schemas/state.js';
import { loadQualityPolicy } from '../src/config/loader.js';
import { ValidationError } from '../src/util/errors.js';
import type { EditPlan } from '../src/schemas/planning.js';

const SETTINGS = { width: 1920, height: 1080, fps: 30, colorspace: 'bt709', aspectRatio: '16:9' };
const PROJECT = 'review-test';

let cwd: string;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'avp-review-'));
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

const entryFor = (shotId: string): ManifestEntry => ({
  assetHash: computeAssetHash({ kind: 'video', model: 'm', prompt: shotId, duration: 5 }),
  shotId, kind: 'video', provider: 'p', model: 'm', prompt: shotId, settings: {},
  submittedAt: new Date().toISOString(),
  estimatedCredits: 20, estimatedUSD: 1.25, actualCredits: 20, actualUSD: 1.25,
  status: 'completed', accepted: null,
});

describe('review decisions', () => {
  it('accepts a shot and marks the manifest entry accepted', () => {
    appendEntry(PROJECT, entryFor('shot_001'));
    recordDecision(PROJECT, 'shot_001', 'accept', { note: 'good' });

    expect(readState(PROJECT).shots['shot_001']?.status).toBe('accepted');
    const entry = readManifest(PROJECT).entries[0]!;
    expect(entry.accepted).toBe(true);
    expect(entry.qualityNote).toBe('good');
  });

  it('flags a retry without spending anything', () => {
    // Section 15: v1 vision QA never autonomously spends retry credits.
    appendEntry(PROJECT, entryFor('shot_002'));
    recordDecision(PROJECT, 'shot_002', 'retry', { failureClass: 'continuity-issue' });

    const shot = readState(PROJECT).shots['shot_002'];
    expect(shot?.status).toBe('qa-flagged');
    expect(shot?.failureClass).toBe('continuity-issue');
    expect(readManifest(PROJECT).entries[0]!.accepted).toBe(false);
  });

  it('records a fallback distinctly from a retry', () => {
    recordDecision(PROJECT, 'shot_003', 'fallback', { failureClass: 'model-capability-issue' });
    expect(readState(PROJECT).shots['shot_003']?.status).toBe('fallback-still');
  });

  it('rejects a failure class not in the policy', () => {
    // Free-text classes would make the failure data useless for the
    // automation that section 16 plans to build from it.
    expect(() =>
      recordDecision(PROJECT, 'shot_004', 'retry', { failureClass: 'looks-bad' }),
    ).toThrow(ValidationError);
  });

  it('accepts every class the policy declares', () => {
    for (const [i, cls] of loadQualityPolicy().failureClasses.entries()) {
      expect(() =>
        recordDecision(PROJECT, `shot_${String(i + 10).padStart(3, '0')}`, 'retry', {
          failureClass: cls,
        }),
      ).not.toThrow();
    }
  });

  it('lists only flagged shots as pending', () => {
    recordDecision(PROJECT, 'shot_001', 'accept');
    recordDecision(PROJECT, 'shot_002', 'retry', { failureClass: 'prompt-issue' });
    recordDecision(PROJECT, 'shot_003', 'fallback');

    expect(pendingReview(PROJECT)).toEqual(['shot_002']);
  });

  it('summarises decisions by category', () => {
    recordDecision(PROJECT, 'shot_001', 'accept');
    recordDecision(PROJECT, 'shot_002', 'accept');
    recordDecision(PROJECT, 'shot_003', 'fallback');
    const s = reviewSummary(PROJECT);
    expect(s.accepted).toHaveLength(2);
    expect(s.fallback).toEqual(['shot_003']);
  });

  it('refuses to close the review while a shot is still pending', () => {
    recordDecision(PROJECT, 'shot_001', 'retry', { failureClass: 'prompt-issue' });
    expect(() => completeReview(PROJECT)).toThrow(/awaiting a decision/);
  });

  it('closes the review once everything is decided', () => {
    recordDecision(PROJECT, 'shot_001', 'accept');
    completeReview(PROJECT);
    expect(readState(PROJECT).gates.review.status).toBe('approved');
  });
});

/* ------------------------------------------------------------- fallbacks */

const item = (id: string, over: Partial<EditPlan['items'][number]> = {}) => ({
  shotId: id, startSeconds: 0, screenDurationSeconds: 6, motionSeconds: 5,
  speedFactor: 1, transitionIn: 'cut', transitionOut: 'cut', isStill: false, ...over,
});

const plan = (ids: string[]): EditPlan => ({
  totalDurationSeconds: ids.length * 6,
  items: ids.map((id) => item(id)),
  music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
  captions: [],
});

describe('fallback handling', () => {
  it('converts a failed shot into an animated still', () => {
    // Section 17: one difficult shot must not block the whole project.
    const result = applyFallbacks(plan(['shot_001', 'shot_002']), ['shot_002']);
    const fb = result.items.find((i) => i.shotId === 'shot_002')!;
    expect(fb.isStill).toBe(true);
    expect(fb.motionSeconds).toBe(0);
    expect(fb.kenBurns?.enabled).toBe(true);
  });

  it('leaves other shots untouched', () => {
    const result = applyFallbacks(plan(['shot_001', 'shot_002']), ['shot_002']);
    expect(result.items.find((i) => i.shotId === 'shot_001')!.isStill).toBe(false);
  });

  it('does not mutate the original plan', () => {
    const original = plan(['shot_001']);
    applyFallbacks(original, ['shot_001']);
    expect(original.items[0]!.isStill).toBe(false);
  });

  it('is caught by motion lint #2 when fallbacks pile up', () => {
    // The exact scenario section 18 exists for: each fallback looks
    // reasonable alone, but together they produce a slideshow.
    const policy = loadQualityPolicy();
    const four = plan(['shot_001', 'shot_002', 'shot_003', 'shot_004']);

    expect(lintAfterFallbacks(four, [], policy).pass).toBe(true);
    expect(lintAfterFallbacks(four, ['shot_002', 'shot_003', 'shot_004'], policy).pass).toBe(false);
  });

  it('finds a still to animate, preferring the shot start frame', () => {
    const p = paths(PROJECT);
    mkdirSync(p.shotDir('shot_001'), { recursive: true });
    writeFileSync(p.shotFile('shot_001', 'start.png'), 'img');

    expect(fallbackSourceFor(PROJECT, 'shot_001')).toContain('start.png');
  });

  it('returns null when no still exists', () => {
    expect(fallbackSourceFor(PROJECT, 'shot_099')).toBeNull();
  });
});

describe('vision QA policy', () => {
  it('declares the checks a reviewer must answer', () => {
    const checks = visionChecklist();
    expect(checks).toContain('correct-character');
    expect(checks).toContain('progression-plausible');
    expect(checks.length).toBeGreaterThan(5);
  });

  it('forbids autonomous spending in v1', () => {
    // Section 15. If this ever returns true, vision QA could burn credits
    // on retries without a human deciding.
    expect(canAutoSpend()).toBe(false);
  });
});
