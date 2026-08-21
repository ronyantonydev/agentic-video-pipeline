/**
 * Tier 2 vision QA. Architecture section 15.
 *
 * Extracts representative frames and builds a contact sheet for a human (or
 * Claude) to inspect. This tier FLAGS problems - it never spends retry
 * credits on its own (section 15: `autoSpendOnRetry: false` in v1).
 *
 * Frame extraction is free and local; only the judgement is delegated.
 */

import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { loadEnv } from '../config/env.js';
import { loadQualityPolicy, type QualityPolicy } from '../config/loader.js';
import { extractFrames, probe } from '../ffmpeg/probe.js';
import { paths } from '../state/paths.js';

const exec = promisify(execFile);

export type VisionFinding = {
  check: string;
  severity: 'info' | 'warn' | 'flag';
  note: string;
};

export type VisionQaResult = {
  shotId: string;
  framePaths: string[];
  contactSheet: string | null;
  /** Populated by whoever inspects the frames - not inferred here. */
  findings: VisionFinding[];
  decision: 'pending' | 'accept' | 'retry' | 'fallback';
};

/**
 * Prepare a shot for visual inspection.
 *
 * Deliberately does NOT judge the frames. Machine QA covers what can be
 * measured; anything requiring a look is presented, not guessed at.
 */
export async function prepareVisionQa(
  project: string,
  shotId: string,
  videoFile: string,
  policy: QualityPolicy = loadQualityPolicy(),
): Promise<VisionQaResult> {
  const outDir = join(paths(project).shotDir(shotId), 'qa-frames');
  mkdirSync(outDir, { recursive: true });

  const framePaths = await extractFrames(videoFile, outDir, policy.visionQa.framesPerShot);
  const contactSheet =
    framePaths.length > 0 ? await buildContactSheet(framePaths, join(outDir, 'sheet.jpg')) : null;

  return { shotId, framePaths, contactSheet, findings: [], decision: 'pending' };
}

/** Tile frames horizontally into one image for quick side-by-side reading. */
async function buildContactSheet(frames: string[], output: string): Promise<string | null> {
  if (frames.length === 0) return null;
  const env = loadEnv();

  const inputs = frames.flatMap((f) => ['-i', f]);
  const scaled = frames.map((_, i) => `[${i}:v]scale=480:-1[s${i}]`).join(';');
  const refs = frames.map((_, i) => `[s${i}]`).join('');

  try {
    await exec(env.ffmpegBin, [
      '-v', 'error', '-y',
      ...inputs,
      '-filter_complex', `${scaled};${refs}hstack=inputs=${frames.length}`,
      '-q:v', '3',
      output,
    ]);
    return output;
  } catch {
    return null;
  }
}

/**
 * Contact sheet across ALL shots, one row per shot.
 * This is what Gate 2 presents (section 33: storyboard/contact-sheet.png).
 */
export async function buildProjectContactSheet(
  project: string,
  shotIds: string[],
): Promise<string | null> {
  const env = loadEnv();
  const p = paths(project);
  const rows: string[] = [];

  for (const id of shotIds) {
    const sheet = join(p.shotDir(id), 'qa-frames', 'sheet.jpg');
    if (existsSync(sheet)) rows.push(sheet);
  }
  if (rows.length === 0) return null;

  mkdirSync(p.storyboard, { recursive: true });
  const output = p.contactSheet;

  const inputs = rows.flatMap((f) => ['-i', f]);
  const scaled = rows.map((_, i) => `[${i}:v]scale=1600:-1[s${i}]`).join(';');
  const refs = rows.map((_, i) => `[s${i}]`).join('');

  try {
    await exec(
      env.ffmpegBin,
      [
        '-v', 'error', '-y',
        ...inputs,
        '-filter_complex', `${scaled};${refs}vstack=inputs=${rows.length}`,
        output,
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    return output;
  } catch {
    return null;
  }
}

/**
 * Contact sheet for the LOOK gate, built from planning images.
 *
 * `buildProjectContactSheet` reads `shots/<id>/qa-frames/sheet.jpg`, which
 * only exists once video has been generated - so at the `contact-sheet`
 * stage, which sits *before* gate-look, it always returned null. The stage
 * that is meant to give the human one page to look at produced nothing.
 *
 * This builds the sheet from what does exist at that point: the reference
 * plates every shot inherits, and the anchor frames that decide the opening
 * and closing image of the shots carrying the most weight. Those are exactly
 * the images a wrong answer is most expensive on.
 *
 * Free - ffmpeg only, no generation.
 */
export async function buildPlanContactSheet(project: string): Promise<string | null> {
  const env = loadEnv();
  const p = paths(project);

  const isLive = (f: string) => /\.(png|jpe?g|webp)$/i.test(f) && !/-rejected(-|\.)/i.test(f);
  const fromDir = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir).filter(isLive).sort().map((f) => join(dir, f)) : [];

  // Order matters: identity first, then the world, then the specific moments.
  const tiles = [
    ...fromDir(p.referenceCategory('character')),
    ...fromDir(p.referenceCategory('environment')),
    ...fromDir(p.referenceCategory('style')),
    ...fromDir(p.referenceCategory('props')),
    ...fromDir(p.storyboardFrames),
  ];
  if (tiles.length === 0) return null;

  mkdirSync(p.storyboard, { recursive: true });
  const output = p.contactSheet;

  // A grid rather than a vstack: twenty-odd plates stacked vertically make a
  // strip nobody can read. Four across keeps each tile legible on one screen.
  const cols = 4;
  const rows = Math.ceil(tiles.length / cols);
  const scaled = tiles.map((_, i) => `[${i}:v]scale=640:360:force_original_aspect_ratio=decrease,` +
    `pad=640:360:(ow-iw)/2:(oh-ih)/2:color=0x1a1a1a[s${i}]`).join(';');

  // Pad the final row so xstack gets a complete grid.
  const blanks = rows * cols - tiles.length;
  const blankInputs = Array.from({ length: blanks }, () =>
    ['-f', 'lavfi', '-i', 'color=c=0x1a1a1a:s=640x360:d=1']).flat();
  const blankLabels = Array.from({ length: blanks }, (_, i) => `[${tiles.length + i}:v]`).join('');

  const layout = Array.from({ length: rows * cols }, (_, i) =>
    `${(i % cols) * 640}_${Math.floor(i / cols) * 360}`).join('|');

  try {
    await exec(
      env.ffmpegBin,
      [
        '-v', 'error', '-y',
        ...tiles.flatMap((f) => ['-i', f]),
        ...blankInputs,
        '-filter_complex',
        `${scaled};${tiles.map((_, i) => `[s${i}]`).join('')}${blankLabels}` +
          `xstack=inputs=${rows * cols}:layout=${layout}[out]`,
        '-map', '[out]',
        '-frames:v', '1',
        output,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return output;
  } catch {
    return null;
  }
}

/**
 * The checks a human or vision model should answer for each shot.
 * Read from policy so the list is configuration, not code.
 */
export function visionChecklist(policy: QualityPolicy = loadQualityPolicy()): string[] {
  return policy.visionQa.checks;
}

/** True when v1 policy forbids this tier from spending on its own. */
export function canAutoSpend(policy: QualityPolicy = loadQualityPolicy()): boolean {
  return policy.visionQa.autoSpendOnRetry;
}

export async function shotDurations(
  project: string,
  shotIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const id of shotIds) {
    const file = paths(project).shotFile(id, 'normalized.mp4');
    if (!existsSync(file)) continue;
    out.set(id, (await probe(file)).durationSeconds);
  }
  return out;
}
