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
