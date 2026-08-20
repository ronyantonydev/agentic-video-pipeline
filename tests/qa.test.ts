import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe, frameContrast, frameLuminance, ProbeError } from '../src/ffmpeg/probe.js';
import { normalizeClip, conformsToProject } from '../src/ffmpeg/normalize.js';
import { runMachineQa, summarizeQa } from '../src/qa/machine.js';
import { loadProjectDefaults } from '../src/config/loader.js';

let dir: string;

/** Build a fixture with ffmpeg so QA runs against real media, not mocks. */
function makeVideo(name: string, filter: string, seconds = 2): string {
  const path = join(dir, name);
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', filter,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', path,
  ], { stdio: 'ignore' });
  return path;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'avp-qa-'));
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('ffmpeg portability', () => {
  it('uses only filters present in every ffmpeg build', () => {
    // CI caught this: `gradients` exists in Homebrew's ffmpeg 7.x but not in
    // Ubuntu's build, so a test passed locally and failed on push. Anything
    // used by the suite or by the fake provider must be core.
    const sources = [
      readFileSync(new URL('./qa.test.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../src/higgsfield/fake-provider.ts', import.meta.url), 'utf8'),
    ].join('\n');

    // Strip comments, which legitimately name the filter while explaining it.
    const code = sources.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    // Only lavfi INPUT sources matter - those are what a missing filter
    // breaks. Matching bare filter names would collide with ordinary
    // identifiers, so the pattern requires the `-i` position.
    const lavfiSources = [...code.matchAll(/'-i',\s*[`'"]([a-z0-9_]+)[=:]/g)].map((m) => m[1]);

    // Present in every ffmpeg build, including the one Ubuntu ships.
    const CORE = new Set(['testsrc2', 'testsrc', 'color', 'anullsrc', 'sine', 'smptebars']);

    for (const filter of new Set(lavfiSources)) {
      expect(CORE.has(filter!), `lavfi source "${filter}" may be absent from some builds`)
        .toBe(true);
    }
  });
});

describe('probe', () => {
  it('reads stream properties', async () => {
    const info = await probe(makeVideo('a.mp4', 'testsrc2=size=640x480:rate=25'));
    expect(info.video?.width).toBe(640);
    expect(info.video?.height).toBe(480);
    expect(info.video?.fps).toBeCloseTo(25, 1);
    expect(info.audio?.codec).toBe('aac');
  }, 60_000);

  it('throws on a missing file rather than returning empty data', async () => {
    await expect(probe(join(dir, 'nope.mp4'))).rejects.toThrow(ProbeError);
  });

  it('throws on a corrupt file', async () => {
    const bad = join(dir, 'corrupt.mp4');
    writeFileSync(bad, 'this is not a video');
    await expect(probe(bad)).rejects.toThrow(ProbeError);
  });
});

describe('blank detection measures contrast WITHIN a frame', () => {
  // The bug this guards: an earlier version compared average luminance
  // BETWEEN frames. That is near-zero for any correctly exposed shot under
  // constant light, so it flagged 8 perfectly good clips as blank.

  it('reports high contrast for a detailed image', async () => {
    const c = await frameContrast(makeVideo('detail.mp4', 'testsrc2=size=640x480:rate=10'));
    expect(c.length).toBeGreaterThan(0);
    expect(Math.max(...c)).toBeGreaterThan(0.05);
  }, 60_000);

  it('reports near-zero contrast for a flat fill', async () => {
    const c = await frameContrast(makeVideo('flat.mp4', 'color=c=gray:size=640x480:rate=10'));
    expect(c.length).toBeGreaterThan(0);
    expect(Math.max(...c)).toBeLessThan(0.05);
  }, 60_000);

  it('does not confuse a static shot with a blank one', async () => {
    // A still image with real content: constant over time, high contrast
    // within the frame. The old check called this blank.
    //
    // Built from testsrc2 with a frozen frame rather than the `gradients`
    // source: gradients is absent from Ubuntu's ffmpeg build, so the test
    // passed locally and failed in CI. Every filter used here - testsrc2,
    // trim, loop - is core.
    const still = makeVideo(
      'still.mp4',
      'testsrc2=size=640x480:rate=10,trim=end_frame=1,loop=loop=-1:size=1,fps=10',
    );
    const luma = await frameLuminance(still);
    const contrast = await frameContrast(still);

    const lumaRange = Math.max(...luma) - Math.min(...luma);
    expect(lumaRange).toBeLessThan(0.05);          // barely varies over time
    expect(Math.max(...contrast)).toBeGreaterThan(0.05); // but is not blank
  }, 60_000);
});

describe('normalisation', () => {
  it('conforms a mismatched clip to the locked project format', async () => {
    const src = makeVideo('src.mp4', 'testsrc2=size=640x360:rate=24');
    const out = join(dir, 'norm.mp4');
    const result = await normalizeClip(src, out);

    const d = loadProjectDefaults();
    expect(result.after.video?.width).toBe(d.video.width);
    expect(result.after.video?.height).toBe(d.video.height);
    expect(result.after.video?.fps).toBeCloseTo(d.video.fps, 1);
    expect(result.upscaled).toBe(true);
    expect(conformsToProject(result.after).ok).toBe(true);
  }, 120_000);

  it('gives a silent source an audio track', async () => {
    // Without this, concatenation drops audio from every later clip.
    const silent = join(dir, 'silent.mp4');
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi',
      '-i', 'testsrc2=size=320x240:rate=10:duration=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', silent,
    ], { stdio: 'ignore' });

    expect((await probe(silent)).audio).toBeNull();
    const result = await normalizeClip(silent, join(dir, 'silent-norm.mp4'));
    expect(result.after.audio).not.toBeNull();
  }, 120_000);

  it('pads rather than crops, preserving composition', async () => {
    // A 1:1 source in a 16:9 project must keep its full frame.
    const square = makeVideo('square.mp4', 'testsrc2=size=480x480:rate=10', 1);
    const result = await normalizeClip(square, join(dir, 'square-norm.mp4'));
    expect(result.after.video?.width).toBe(1920);
    expect(result.after.video?.height).toBe(1080);
  }, 120_000);
});

describe('machine QA', () => {
  it('passes a healthy clip', async () => {
    const src = makeVideo('good.mp4', 'testsrc2=size=640x480:rate=25', 3);
    const norm = join(dir, 'good-norm.mp4');
    await normalizeClip(src, norm);

    const r = await runMachineQa('shot_001', norm, { expectedDurationSeconds: 3, expectAudio: true });
    expect(r.pass).toBe(true);
    expect(r.checks.find((c) => c.name === 'not-blank')?.status).toBe('pass');
  }, 180_000);

  it('fails a blank clip', async () => {
    // Checked on the ORIGINAL, not the normalised copy: padding a 4:3 source
    // into 16:9 adds black bars, and those bars are themselves high contrast
    // against the picture. On a padded file this check can only catch a clip
    // that is blank edge to edge - a documented limitation in machine.ts.
    const flat = makeVideo('blank.mp4', 'color=c=gray:size=1920x1080:rate=25', 2);

    const r = await runMachineQa('shot_002', flat, {});
    expect(r.checks.find((c) => c.name === 'not-blank')?.status).toBe('fail');
  }, 180_000);

  it('still detects a blank clip after normalisation when it fills the frame', async () => {
    // 16:9 source needs no padding, so no bars are introduced.
    const flat = makeVideo('blank169.mp4', 'color=c=gray:size=1920x1080:rate=25', 2);
    const norm = join(dir, 'blank169-norm.mp4');
    await normalizeClip(flat, norm);

    const r = await runMachineQa('shot_005', norm, {});
    expect(r.checks.find((c) => c.name === 'not-blank')?.status).toBe('fail');
  }, 180_000);

  it('fails an unreadable file without throwing', async () => {
    const bad = join(dir, 'broken.mp4');
    writeFileSync(bad, 'garbage');
    const r = await runMachineQa('shot_003', bad, {});
    expect(r.pass).toBe(false);
    expect(r.checks[0]?.name).toBe('readable');
  });

  it('flags a duration outside tolerance', async () => {
    const src = makeVideo('short.mp4', 'testsrc2=size=640x480:rate=25', 2);
    const norm = join(dir, 'short-norm.mp4');
    await normalizeClip(src, norm);

    const r = await runMachineQa('shot_004', norm, { expectedDurationSeconds: 8 });
    expect(r.checks.find((c) => c.name === 'duration')?.status).toBe('fail');
  }, 180_000);

  it('summarises a mixed batch', () => {
    const s = summarizeQa([
      { shotId: 'a', file: '', pass: true, checks: [], info: null },
      { shotId: 'b', file: '', pass: false, checks: [], info: null },
    ]);
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.failedShots).toEqual(['b']);
  });
});
