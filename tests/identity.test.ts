import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  perceptualHash, hashDistance, compareToMaster, checkClipDrift,
  runDriftTest, referencePackPaths,
} from '../src/qa/identity.js';

let dir: string;

/** Build an image fixture with core lavfi sources only. */
function makeImage(name: string, filter: string): string {
  const path = join(dir, name);
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', filter, '-frames:v', '1', path,
  ], { stdio: 'ignore' });
  return path;
}

function makeVideo(name: string, filter: string, seconds = 2): string {
  const path = join(dir, name);
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', filter, '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path,
  ], { stdio: 'ignore' });
  return path;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'avp-identity-'));
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('perceptual hashing', () => {
  it('produces a stable hash for the same image', async () => {
    const img = makeImage('a.png', 'testsrc2=size=320x240:rate=1');
    const [h1, h2] = await Promise.all([perceptualHash(img), perceptualHash(img)]);
    expect(h1).toBe(h2);
  }, 60_000);

  it('is unchanged by resolution', async () => {
    // A reference photo and a video frame are never the same size, so the
    // hash has to survive scaling or it would flag every comparison.
    const small = makeImage('small.png', 'testsrc2=size=320x240:rate=1');
    const large = makeImage('large.png', 'testsrc2=size=1280x960:rate=1');
    expect(hashDistance(await perceptualHash(small), await perceptualHash(large)))
      .toBeLessThan(0.15);
  }, 60_000);

  it('separates genuinely different images', async () => {
    const a = makeImage('src.png', 'testsrc2=size=320x240:rate=1');
    const b = makeImage('flat.png', 'color=c=gray:size=320x240:rate=1');
    expect(hashDistance(await perceptualHash(a), await perceptualHash(b)))
      .toBeGreaterThan(0.3);
  }, 60_000);

  it('throws on a missing image rather than returning a hash', async () => {
    await expect(perceptualHash(join(dir, 'nope.png'))).rejects.toThrow(/No such image/);
  });
});

describe('hamming distance', () => {
  it('is zero for identical hashes', () => {
    expect(hashDistance(0xdeadbeefn, 0xdeadbeefn)).toBe(0);
  });

  it('counts differing bits, normalised', () => {
    // One bit different out of 64.
    expect(hashDistance(0n, 1n)).toBeCloseTo(1 / 64, 5);
  });

  it('is symmetric', () => {
    expect(hashDistance(0xffn, 0x0fn)).toBe(hashDistance(0x0fn, 0xffn));
  });
});

describe('comparison against a master', () => {
  it('passes an image that matches', async () => {
    const master = makeImage('master.png', 'testsrc2=size=640x480:rate=1');
    const same = makeImage('same.png', 'testsrc2=size=640x480:rate=1');
    const r = await compareToMaster(same, master);
    expect(r.pass).toBe(true);
    expect(r.similarity).toBeGreaterThan(0.9);
  }, 60_000);

  it('fails an image that does not', async () => {
    const master = makeImage('m2.png', 'testsrc2=size=640x480:rate=1');
    const other = makeImage('o2.png', 'color=c=gray:size=640x480:rate=1');
    expect((await compareToMaster(other, master)).pass).toBe(false);
  }, 60_000);
});

describe('clip drift', () => {
  it('passes a clip that stays on subject', async () => {
    const steady = makeVideo('steady.mp4', 'testsrc2=size=320x240:rate=10');
    const d = await checkClipDrift(steady);
    expect(d.similarity).toBeGreaterThan(0.5);
  }, 120_000);

  it('detects a clip whose content changes completely', async () => {
    // The failure this exists for: a generation that starts on-model and
    // ends as something else. No start-frame check would see it.
    const drifting = join(dir, 'drift.mp4');
    execFileSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=2',
      '-f', 'lavfi', '-i', 'color=c=black:size=320x240:rate=10:duration=2',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1[out]',
      '-map', '[out]', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', drifting,
    ], { stdio: 'ignore' });

    expect((await checkClipDrift(drifting)).pass).toBe(false);
  }, 120_000);
});

describe('drift test', () => {
  it('passes when every sample holds', async () => {
    const master = makeImage('dm.png', 'testsrc2=size=640x480:rate=1');
    const samples = [1, 2, 3].map((i) => makeImage(`ds${i}.png`, 'testsrc2=size=640x480:rate=1'));
    const r = await runDriftTest(master, samples);
    expect(r.holds).toBe(true);
    expect(r.outliers).toHaveLength(0);
    expect(r.recommendation).toMatch(/safe to commit/i);
  }, 120_000);

  it('fails and names the samples that drifted', async () => {
    const master = makeImage('dm2.png', 'testsrc2=size=640x480:rate=1');
    const samples = [
      makeImage('ok.png', 'testsrc2=size=640x480:rate=1'),
      makeImage('bad.png', 'color=c=gray:size=640x480:rate=1'),
    ];
    const r = await runDriftTest(master, samples);
    expect(r.holds).toBe(false);
    expect(r.outliers).toContain(1);
    expect(r.recommendation).toMatch(/before spending/i);
  }, 120_000);

  it('refuses to judge with no samples rather than passing by default', async () => {
    // An empty result must not read as "identity holds" - that would let a
    // broken reference through to a full paid run.
    const r = await runDriftTest(makeImage('dm3.png', 'testsrc2=size=320x240:rate=1'), []);
    expect(r.holds).toBe(false);
    expect(r.recommendation).toMatch(/cannot judge/i);
  }, 60_000);

  it('counts an unreadable sample as drifted, not as absent', async () => {
    const master = makeImage('dm4.png', 'testsrc2=size=320x240:rate=1');
    const broken = join(dir, 'broken.png');
    writeFileSync(broken, 'not an image');

    const r = await runDriftTest(master, [broken]);
    expect(r.holds).toBe(false);
    expect(r.outliers).toContain(0);
  }, 60_000);
});

describe('reference pack', () => {
  it('names six images: three face, three body', () => {
    // One front-facing reference held identity in wide shots but not in
    // close-ups or odd angles. Three face angles lock identity; three body
    // shots lock outfit and proportion.
    const paths = referencePackPaths('/tmp/char');
    expect(paths).toHaveLength(6);
    expect(paths.filter((p) => p.includes('face'))).toHaveLength(3);
    expect(paths.filter((p) => p.includes('body'))).toHaveLength(3);
  });
});
