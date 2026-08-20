/**
 * Timeline compilation.
 *
 * These guard a specific failure shape: the edit plan asks for something and
 * the compiler quietly does something else. Transitions were planned and then
 * dropped without a word - `transitionIn`/`transitionOut` appeared nowhere in
 * the compiler - so a plan calling for a crossfade rendered a hard cut and
 * nothing reported the difference. Music fades had the mirror-image bug: the
 * plan's music envelope was wired to the black picture overlay, leaving the
 * bed at flat gain for the whole runtime.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileComposition } from '../src/timeline/compile.js';
import type { EditPlan } from '../src/schemas/planning.js';

const exec = promisify(execFile);

let tmp: string;
let projectDir: string;
const PROJECT = 'compile-test';

/** A one-second clip, so the compiler finds real media to link. */
async function makeClip(path: string): Promise<void> {
  mkdirSync(join(path, '..'), { recursive: true });
  await exec('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', '1', '-shortest', '-y', path,
  ]);
}

function plan(overrides: Partial<EditPlan> = {}): EditPlan {
  return {
    totalDurationSeconds: 10,
    items: [
      {
        shotId: 'shot_001', startSeconds: 0, screenDurationSeconds: 5,
        motionSeconds: 5, speedFactor: 1,
        transitionIn: 'cut', transitionOut: 'cut', isStill: false,
      },
      {
        shotId: 'shot_002', startSeconds: 5, screenDurationSeconds: 5,
        motionSeconds: 5, speedFactor: 1,
        transitionIn: 'cut', transitionOut: 'cut', isStill: false,
      },
    ],
    music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
    captions: [],
    ...overrides,
  } as EditPlan;
}

const defaults = {
  video: { width: 1920, height: 1080, fps: 30, colorspace: 'bt709' },
} as never;

function compile(p: EditPlan, musicFile?: string): { html: string; warnings: string[] } {
  const out = mkdtempSync(join(tmp, 'comp-'));
  const r = compileComposition(p, {
    projectName: PROJECT,
    outputDir: out,
    defaults,
    ...(musicFile !== undefined ? { musicFile } : {}),
  });
  return { html: readFileSync(r.compositionPath, 'utf8'), warnings: r.warnings };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'compile-'));
  projectDir = join(process.cwd(), 'projects', PROJECT);
  for (const id of ['shot_001', 'shot_002']) {
    await makeClip(join(projectDir, 'shots', id, 'normalized.mp4'));
  }
}, 60_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
});

describe('transitions', () => {
  it('renders a plain cut with no timeline at all', () => {
    const { html } = compile(plan());
    // Nothing to animate, so the composition says so rather than
    // registering an empty timeline.
    expect(html).toContain('data-no-timeline');
    expect(html).not.toContain('<script>');
  });

  it('honours a crossfade instead of silently cutting', () => {
    const p = plan();
    p.items[0]!.transitionOut = 'crossfade';
    p.items[1]!.transitionIn = 'crossfade';
    const { html } = compile(p);

    // Opposing opacity envelopes: one down, one up, at the same instant.
    expect(html).toContain("tl.to('#wrap-shot_001', { autoAlpha: 0");
    expect(html).toContain("tl.to('#wrap-shot_002', { autoAlpha: 1");
    expect(html).toContain("tl.set('#wrap-shot_002', { autoAlpha: 0 }");
    // A real timeline now exists.
    expect(html).not.toContain('data-no-timeline');
    expect(html).toContain("window.__timelines['root']");
  });

  it('puts the two dissolving clips on DIFFERENT tracks', () => {
    // Same-track overlap is invalid in HyperFrames; the clips must part.
    const p = plan();
    p.items[0]!.transitionOut = 'crossfade';
    const { html } = compile(p);
    const tracks = [...html.matchAll(/data-shot-id="(shot_\d+)"[^>]*data-track-index="(\d+)"/g)]
      .map((m) => [m[1], m[2]]);
    expect(tracks[0]![1]).not.toBe(tracks[1]![1]);
  });

  it('extends the outgoing clip so the overlap is not black', () => {
    const p = plan();
    p.items[0]!.transitionOut = 'crossfade';
    const { html } = compile(p);
    // 5s of screen time + 0.5s held under the incoming shot.
    expect(html).toMatch(/data-shot-id="shot_001"[^>]*data-duration="5\.5"/);
    expect(html).toMatch(/data-shot-id="shot_002"[^>]*data-duration="5"/);
  });

  it('WARNS about a transition it cannot honour', () => {
    // The whole point. A wipe still renders as a cut - but it says so.
    const p = plan();
    p.items[0]!.transitionOut = 'wipe';
    const { warnings } = compile(p);
    expect(warnings.join(' ')).toMatch(/wipe.*not implemented.*hard cut/i);
  });

  it('does not warn about a plain cut', () => {
    const { warnings } = compile(plan());
    expect(warnings.join(' ')).not.toMatch(/not implemented/i);
  });
});

describe('music', () => {
  let music: string;

  beforeAll(async () => {
    music = join(tmp, 'bed.m4a');
    await exec('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', '10', '-y', music,
    ]);
  }, 30_000);

  it('gives the bed a fade envelope, not a flat gain', () => {
    const p = plan({ music: { gainDb: -12, fadeInSeconds: 1, fadeOutSeconds: 2 } });
    const { html } = compile(p, music);

    const m = /data-automation='([^']*)'/.exec(html);
    expect(m).not.toBeNull();
    const lanes = JSON.parse(m![1]!.replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
    const points = lanes.lanes[0].points;

    // Silent at the top, up by 1s, held, and back to silence at the end.
    expect(points[0]).toEqual({ t: 0, v: 0 });
    expect(points[1]!.t).toBe(1);
    expect(points[points.length - 1]).toEqual({ t: 10, v: 0 });
    expect(points[points.length - 2]!.t).toBe(8);
  });

  it('peaks at the planned dB, not full volume', () => {
    const p = plan({ music: { gainDb: -28, fadeInSeconds: 1, fadeOutSeconds: 1 } });
    const { html } = compile(p, music);
    const m = /data-automation='([^']*)'/.exec(html);
    const lanes = JSON.parse(m![1]!.replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
    const peak = Math.max(...lanes.lanes[0].points.map((pt: { v: number }) => pt.v));
    // -28dB = 10^(-28/20) ~= 0.0398
    expect(peak).toBeCloseTo(0.0398, 3);
  });

  it('emits a flat envelope when no fades are asked for', () => {
    const p = plan({ music: { gainDb: -6, fadeInSeconds: 0, fadeOutSeconds: 0 } });
    const { html } = compile(p, music);
    const m = /data-automation='([^']*)'/.exec(html);
    const lanes = JSON.parse(m![1]!.replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
    const vs = lanes.lanes[0].points.map((pt: { v: number }) => pt.v);
    expect(new Set(vs).size).toBe(1); // one level throughout
  });

  it('warns rather than rendering silence when the file is missing', () => {
    const { warnings } = compile(plan(), join(tmp, 'nope.m4a'));
    expect(warnings.join(' ')).toMatch(/music file not found/i);
  });

  it('clamps fades that would overlap on a short bed', () => {
    // 1s in + 1s out on a 10s bed is fine; 20s each is not. The envelope
    // must stay monotonic in t whatever the plan asks for.
    const p = plan({ music: { gainDb: -12, fadeInSeconds: 20, fadeOutSeconds: 20 } });
    const { html } = compile(p, music);
    const m = /data-automation='([^']*)'/.exec(html);
    const lanes = JSON.parse(m![1]!.replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
    const ts = lanes.lanes[0].points.map((pt: { t: number }) => pt.t);
    expect([...ts]).toEqual([...ts].sort((a, b) => a - b));
  });
});
