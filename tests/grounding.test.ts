/**
 * Prop grounding.
 *
 * The regression these guard: a prop reference shot on a seamless backdrop
 * has no ground plane, and the video model reproduces an object touching
 * nothing. oak-stool shot_004 rendered the finished stool hovering in mid-air
 * beside the bench because its reference floated on flat grey.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkGrounding } from '../src/qa/grounding.js';

const exec = promisify(execFile);

let dir: string;

/** A flat fill: the studio void that caused the bug. */
async function makeFlat(path: string): Promise<void> {
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=640x640', '-frames:v', '1', '-y', path]);
}

/**
 * A surface: a dark band across the bottom of the frame, standing in for a
 * bench edge or contact shadow.
 */
async function makeGrounded(path: string): Promise<void> {
  await exec('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=gray:s=640x640',
    '-vf', 'drawbox=x=0:y=560:w=640:h=80:color=black@1.0:t=fill',
    '-frames:v', '1', '-y', path,
  ]);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'grounding-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('prop grounding', () => {
  it('flags an object on a seamless backdrop', async () => {
    const p = join(dir, 'flat.png');
    await makeFlat(p);
    const r = await checkGrounding(p);
    expect(r.looksUngrounded).toBe(true);
    expect(r.borderSpread).not.toBeNull();
  });

  it('passes an image with a visible surface under it', async () => {
    const p = join(dir, 'grounded.png');
    await makeGrounded(p);
    const r = await checkGrounding(p);
    expect(r.looksUngrounded).toBe(false);
  });

  it('does not flag a missing file - absence is not a floating prop', async () => {
    const r = await checkGrounding(join(dir, 'nope.png'));
    expect(r.looksUngrounded).toBe(false);
    expect(r.detail).toContain('not found');
  });

  it('reports unmeasurable rather than guessing', async () => {
    // A text file is not an image; the border cannot be sampled.
    const p = join(dir, 'notanimage.png');
    await exec('sh', ['-c', `printf 'not an image' > ${JSON.stringify(p)}`]);
    const r = await checkGrounding(p);
    expect(r.looksUngrounded).toBe(false);
  });
});
