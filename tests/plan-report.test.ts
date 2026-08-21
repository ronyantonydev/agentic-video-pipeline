import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlanReport, renderPlanReport } from '../src/reports/plan-report.js';
import { writeState } from '../src/state/store.js';
import { ensureProjectDirs, paths } from '../src/state/paths.js';
import { emptyState } from '../src/schemas/state.js';

const SETTINGS = { width: 1920, height: 1080, fps: 30, colorspace: 'bt709', aspectRatio: '16:9' };
const PROJECT = 'report-test';
const NOW = '2026-08-21T00:00:00.000Z';

let cwd: string;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'avp-report-'));
  cwd = process.cwd();
  process.chdir(tmp);
  ensureProjectDirs(PROJECT);
  writeState(PROJECT, emptyState({
    projectName: PROJECT, idea: 'a candle burning down', mode: 'full',
    maxBudgetUSD: 5, projectSettings: SETTINGS,
  }));
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
});

/** A real image, since the anchor checks decode what they are given. */
function makeImage(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=1',
    '-frames:v', '1', path,
  ], { stdio: 'ignore' });
}

describe('plan report', () => {
  it('reports missing planning files as a blocker', async () => {
    const r = await buildPlanReport(PROJECT, NOW);

    expect(r.ready).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/planning file/i);
    // A blocker must carry its fix - a report that only names the problem
    // has moved the confusion rather than removed it.
    expect(r.blockers.join(' ')).toMatch(/npm run plan:/);
  });

  it('does not demand audio-plan.json, which no stage writes', async () => {
    const r = await buildPlanReport(PROJECT, NOW);
    const planningCheck = r.codeChecks.find((c) => c.name === 'Planning files')!;

    // Regression: treating every schema key as required sent the user to fix
    // a file that is legitimately absent for a video with native audio.
    expect(planningCheck.detail).not.toMatch(/audio-plan/);
  });

  it('lists every reference image as a human check, never as passed', async () => {
    makeImage(join(paths(PROJECT).referenceCategory('environment'), 'place.png'));
    makeImage(join(paths(PROJECT).referenceCategory('style'), 'style.png'));

    const r = await buildPlanReport(PROJECT, NOW);

    const labels = r.humanChecks.map((h) => h.what).join(' ');
    expect(labels).toMatch(/Environment sheet/);
    expect(labels).toMatch(/Style sheet/);

    // The whole point: code never marks these done, and every one says what
    // to do when it is wrong.
    for (const h of r.humanChecks) {
      expect(h.lookFor.length).toBeGreaterThan(0);
      expect(h.ifWrong.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('never presents the drift score as a verdict', async () => {
    writeFileSync(
      join(paths(PROJECT).references, 'reference-check.json'),
      JSON.stringify({
        version: 1, ranAt: NOW, pass: true,
        characterPack: { present: true, imageCount: 6, meetsPackSize: true },
        driftTest: { samples: 5, meanSimilarity: 0.42, minSimilarity: 0.39, holds: false },
        sheets: { environment: 0, props: 0, style: 0 },
        blockers: [], warnings: [], ungroundedProps: [], driftOverride: null,
      }),
    );

    const r = await buildPlanReport(PROJECT, NOW);
    const drift = r.codeChecks.find((c) => c.name === 'Identity drift score')!;

    // It measured 0.42 and does not hold, but the metric cannot tell a face
    // from a prop, so it must never read as a failure verdict.
    expect(drift.status).toBe('warn');
    expect(drift.detail).toMatch(/ADVISORY/i);
  });

  it('states the cost as a range, so nobody buys only the minimum', async () => {
    // The report is what the user decides on. A plan whose cost lives in a
    // different file leaves them buying credits against a number they were
    // never shown - and buying the minimum means the first bad shot is fatal.
    mkdirSync(paths(PROJECT).planning, { recursive: true });
    writeFileSync(
      paths(PROJECT).planningFile('generation-plan.json'),
      JSON.stringify({
        items: Array.from({ length: 4 }, (_, i) => ({
          shotId: `shot_00${i + 1}`,
          modelId: 'seedance_2_0_mini',
        })),
      }),
    );

    const r = await buildPlanReport(PROJECT, NOW);
    expect(r.cost).not.toBeNull();
    expect(r.cost!.shotCount).toBe(4);
    // 4 shots at the measured 12.5cr.
    expect(r.cost!.shotCredits).toBe(50);
    // The range must be strictly wider than the minimum.
    expect(r.cost!.withRetriesCredits).toBeGreaterThan(r.cost!.minimumCredits);

    const md = renderPlanReport(r);
    expect(md).toContain('## What it costs');
    expect(md).toMatch(/with retries/i);
  });

  it('blocks when a shot has no known price rather than guessing one', async () => {
    mkdirSync(paths(PROJECT).planning, { recursive: true });
    writeFileSync(
      paths(PROJECT).planningFile('generation-plan.json'),
      JSON.stringify({ items: [{ shotId: 'shot_001', modelId: 'no-such-model' }] }),
    );

    const r = await buildPlanReport(PROJECT, NOW);
    const check = r.codeChecks.find((c) => c.name === 'Cost is fully priced')!;
    expect(check.status).toBe('fail');
    expect(r.blockers.join(' ')).toMatch(/no known cost/i);
  });

  it('blocks when plan.json is missing', async () => {
    // Nine valid artifacts still do not make a runnable plan: /run-video reads
    // one contract, and intent that lives only in the planning conversation is
    // lost without it.
    const r = await buildPlanReport(PROJECT, NOW);
    const check = r.codeChecks.find((c) => c.name === 'Run contract (plan.json)')!;
    expect(check.status).toBe('fail');
    expect(r.blockers.join(' ')).toMatch(/plan\.json missing/i);
  });

  it('warns when no shot defines an anchor frame', async () => {
    mkdirSync(paths(PROJECT).planning, { recursive: true });
    writeFileSync(
      paths(PROJECT).planningFile('storyboard.json'),
      JSON.stringify({
        frames: [
          { shotId: 'shot_001', description: 'd', imagePrompt: 'p', referenceImages: [] },
          { shotId: 'shot_002', description: 'd', imagePrompt: 'p', referenceImages: [] },
        ],
      }),
    );

    const r = await buildPlanReport(PROJECT, NOW);
    const check = r.codeChecks.find((c) => c.name === 'Anchor frames planned')!;
    // A wrong anchor costs ~100x the frame, so an absent one is worth saying.
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/none of 2 shots/i);
  });

  it('warns when every second of runtime is paid generation', async () => {
    mkdirSync(paths(PROJECT).planning, { recursive: true });
    writeFileSync(
      paths(PROJECT).planningFile('edit-plan.json'),
      JSON.stringify({
        totalDurationSeconds: 10,
        items: [
          {
            shotId: 'shot_001', startSeconds: 0, screenDurationSeconds: 10,
            motionSeconds: 10, speedFactor: 1, transitionIn: 'cut',
            transitionOut: 'cut', isStill: false,
          },
        ],
        music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
        captions: [],
      }),
    );

    const r = await buildPlanReport(PROJECT, NOW);
    const check = r.codeChecks.find((c) => c.name === 'Runtime split (generated vs composed)')!;
    // 100% motion passes the lint (floor is 55%) but means titles and stills
    // carry none of the runtime, so the video model is paid for every second.
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/55%/);
  });

  it('renders markdown that tells the user what to do next', async () => {
    const r = await buildPlanReport(PROJECT, NOW);
    const md = renderPlanReport(r);

    expect(md).toContain('# Plan report');
    expect(md).toContain('a candle burning down');
    // The two things a beginner needs: the approve command, and permission
    // to refuse.
    expect(md).toContain(`npm run approve -- ${PROJECT} --gate look`);
    expect(md).toMatch(/do not approve/i);
    expect(md).toContain('nothing in this report spent money');
  });
});
