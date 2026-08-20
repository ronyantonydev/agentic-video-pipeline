import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateAnchor, validateShotAnchors, generateValidatedAnchor,
} from '../src/qa/anchor.js';

let dir: string;

function makeImage(name: string, filter: string): string {
  const path = join(dir, name);
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', filter, '-frames:v', '1', path,
  ], { stdio: 'ignore' });
  return path;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'avp-anchor-'));
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('anchor validation', () => {
  it('passes a healthy anchor', async () => {
    const img = makeImage('good.png', 'testsrc2=size=1280x720:rate=1');
    const v = await validateAnchor(img);
    expect(v.pass).toBe(true);
  }, 60_000);

  it('fails a missing file', async () => {
    const v = await validateAnchor(join(dir, 'nope.png'));
    expect(v.pass).toBe(false);
    expect(v.checks[0]?.name).toBe('exists');
  });

  it('fails a corrupt file', async () => {
    const bad = join(dir, 'corrupt.png');
    writeFileSync(bad, 'not an image');
    const v = await validateAnchor(bad);
    expect(v.pass).toBe(false);
  });

  it('fails a blank image', async () => {
    // A generation that produced a file but no picture. Feeding this to a
    // video model spends 20 credits on nothing.
    const flat = makeImage('flat.png', 'color=c=gray:size=1280x720');
    const v = await validateAnchor(flat);
    expect(v.checks.find((c) => c.name === 'not-blank')?.status).toBe('fail');
    expect(v.pass).toBe(false);
  }, 60_000);

  it('fails an image too small to anchor a shot', async () => {
    const tiny = makeImage('tiny.png', 'testsrc2=size=200x150:rate=1');
    const v = await validateAnchor(tiny);
    expect(v.checks.find((c) => c.name === 'resolution')?.status).toBe('fail');
  }, 60_000);

  it('respects a custom resolution floor', async () => {
    const img = makeImage('mid.png', 'testsrc2=size=640x480:rate=1');
    expect((await validateAnchor(img, { minWidth: 1920 })).pass).toBe(false);
    expect((await validateAnchor(img, { minWidth: 320 })).pass).toBe(true);
  }, 60_000);
});

describe('composition check is a smoke signal, not an identity test', () => {
  // Measured on the real project: an empty landscape scored 80% against the
  // character master while a correct close-up scored 47%. A perceptual hash
  // compares light and dark structure, not who is in frame. Treating it as
  // an identity check would block correct close-ups and pass wrong ones.

  it('warns rather than fails when composition differs', async () => {
    const master = makeImage('master.png', 'testsrc2=size=1280x720:rate=1');
    const different = makeImage('diff.png', 'smptebars=size=1280x720:rate=1');

    const v = await validateAnchor(different, { masterPath: master });
    const composition = v.checks.find((c) => c.name === 'composition');

    expect(composition).toBeDefined();
    expect(composition!.status).not.toBe('fail');
    // A differing composition must never block on its own.
    expect(v.pass).toBe(true);
  }, 60_000);

  it('still blocks on a technical failure even when composition matches', async () => {
    const master = makeImage('m2.png', 'color=c=gray:size=1280x720');
    const blank = makeImage('b2.png', 'color=c=gray:size=1280x720');

    const v = await validateAnchor(blank, { masterPath: master });
    // Identical to the master, so composition is perfect - and it is still
    // a blank image, which is what actually matters.
    expect(v.pass).toBe(false);
  }, 60_000);

  it('skips the check when no master is given', async () => {
    const img = makeImage('nomaster.png', 'testsrc2=size=1280x720:rate=1');
    const v = await validateAnchor(img);
    expect(v.checks.find((c) => c.name === 'composition')).toBeUndefined();
    expect(v.identitySimilarity).toBeNull();
  }, 60_000);
});

describe('validating both anchors of a shot', () => {
  it('passes when both are healthy', async () => {
    const a = makeImage('s1.png', 'testsrc2=size=1280x720:rate=1');
    const b = makeImage('e1.png', 'testsrc2=size=1280x720:rate=1');
    expect((await validateShotAnchors(a, b)).pass).toBe(true);
  }, 60_000);

  it('names which frame failed and why', async () => {
    const good = makeImage('s2.png', 'testsrc2=size=1280x720:rate=1');
    const flat = makeImage('e2.png', 'color=c=gray:size=1280x720');

    const r = await validateShotAnchors(good, flat);
    expect(r.pass).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/end frame/);
    expect(r.blockers.join(' ')).toMatch(/not-blank/);
  }, 60_000);

  it('handles a shot with only a start frame', async () => {
    const a = makeImage('s3.png', 'testsrc2=size=1280x720:rate=1');
    const r = await validateShotAnchors(a, undefined);
    expect(r.pass).toBe(true);
    expect(r.end).toBeNull();
  }, 60_000);
});

describe('retry loop', () => {
  it('returns the first anchor that passes', async () => {
    let calls = 0;
    const r = await generateValidatedAnchor(async () => {
      calls += 1;
      return makeImage(`retry-${calls}.png`, 'testsrc2=size=1280x720:rate=1');
    });
    expect(r.gaveUp).toBe(false);
    expect(r.attempts).toBe(1);
    expect(calls).toBe(1);
  }, 60_000);

  it('retries a failing anchor and succeeds', async () => {
    let calls = 0;
    const r = await generateValidatedAnchor(async () => {
      calls += 1;
      // First two attempts produce a blank; the third is usable.
      return calls < 3
        ? makeImage(`bad-${calls}.png`, 'color=c=gray:size=1280x720')
        : makeImage('finally.png', 'testsrc2=size=1280x720:rate=1');
    });
    expect(r.gaveUp).toBe(false);
    expect(r.attempts).toBe(3);
    expect(r.history).toHaveLength(3);
  }, 120_000);

  it('gives up at the cap rather than looping', async () => {
    // Three failures means the prompt is wrong, not the generation. A fourth
    // attempt would spend credits on a request that cannot succeed.
    let calls = 0;
    const r = await generateValidatedAnchor(
      async () => {
        calls += 1;
        return makeImage(`always-bad-${calls}.png`, 'color=c=gray:size=1280x720');
      },
      { maxAttempts: 3 },
    );

    expect(r.gaveUp).toBe(true);
    expect(r.path).toBeNull();
    expect(calls).toBe(3);
    expect(r.reason).toMatch(/prompt or the character reference/i);
  }, 120_000);

  it('records a generation error as a failed attempt rather than throwing', async () => {
    const r = await generateValidatedAnchor(
      async () => {
        throw new Error('provider refused');
      },
      { maxAttempts: 2 },
    );
    expect(r.gaveUp).toBe(true);
    expect(r.history).toHaveLength(2);
    expect(r.history[0]?.checks[0]?.detail).toMatch(/provider refused/);
  }, 60_000);

  it('honours a custom attempt cap', async () => {
    let calls = 0;
    await generateValidatedAnchor(
      async () => {
        calls += 1;
        return makeImage(`cap-${calls}.png`, 'color=c=gray:size=1280x720');
      },
      { maxAttempts: 5 },
    );
    expect(calls).toBe(5);
  }, 180_000);
});
