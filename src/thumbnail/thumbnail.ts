/**
 * Thumbnail generation. Architecture section 30.
 *
 * Two strategies:
 *   extract  - pull the strongest frame from the final render
 *   generate - a dedicated paid image (deferred; extraction is free)
 *
 * Taken from the FINAL-resolution output, not from a source clip, so the
 * thumbnail matches what a viewer actually sees.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnv } from '../config/env.js';
import { probe, frameContrast } from '../ffmpeg/probe.js';
import { log } from '../util/logger.js';

const exec = promisify(execFile);

export type ThumbnailResult = {
  path: string;
  sourceTimeSeconds: number;
  width: number;
  height: number;
  /** Why this frame was chosen over the others sampled. */
  reason: string;
};

/**
 * Choose the most visually interesting frame and write it as the thumbnail.
 *
 * "Strongest" is scored on in-frame contrast: a flat or dark frame makes a
 * poor thumbnail regardless of what happens in the shot. Candidates are
 * sampled away from the very start and end, which are usually fades.
 */
export async function extractThumbnail(
  videoPath: string,
  outputPath: string,
  opts: { candidates?: number; skipEdgeFraction?: number } = {},
): Promise<ThumbnailResult> {
  const env = loadEnv();
  const info = await probe(videoPath);
  if (!info.video || info.durationSeconds <= 0) {
    throw new Error(`Cannot extract a thumbnail from ${videoPath}: no usable video`);
  }

  const candidates = opts.candidates ?? 12;
  const edge = opts.skipEdgeFraction ?? 0.08;
  const usableStart = info.durationSeconds * edge;
  const usableEnd = info.durationSeconds * (1 - edge);
  const span = usableEnd - usableStart;

  mkdirSync(dirname(outputPath), { recursive: true });
  const scratch = join(tmpdir(), `avp-thumb-${process.pid}`);
  mkdirSync(scratch, { recursive: true });

  let best = { time: usableStart + span / 2, score: -1 };

  for (let i = 0; i < candidates; i++) {
    const t = usableStart + (span * (i + 0.5)) / candidates;
    const probeFrame = join(scratch, `c${i}.png`);
    try {
      await exec(env.ffmpegBin, [
        '-v', 'error', '-y', '-ss', t.toFixed(3), '-i', videoPath,
        '-frames:v', '1', probeFrame,
      ]);
      // No fps argument: probeFrame is a single image, and an fps filter
      // on a still yields no samples at all.
      const contrast = await frameContrast(probeFrame);
      const score = contrast[0] ?? 0;
      if (score > best.score) best = { time: t, score };
    } catch {
      // A frame we cannot sample simply loses; no need to fail the run.
    }
  }

  await exec(env.ffmpegBin, [
    '-v', 'error', '-y',
    '-ss', best.time.toFixed(3),
    '-i', videoPath,
    '-frames:v', '1',
    '-q:v', '2',
    outputPath,
  ]);

  const out = await probe(outputPath).catch(() => null);
  const width = out?.video?.width ?? info.video.width;
  const height = out?.video?.height ?? info.video.height;

  log.info(
    `Thumbnail from ${best.time.toFixed(1)}s (contrast ${best.score.toFixed(3)}), ` +
      `${(statSync(outputPath).size / 1024).toFixed(0)}KB`,
  );

  return {
    path: outputPath,
    sourceTimeSeconds: best.time,
    width,
    height,
    reason: `highest in-frame contrast (${best.score.toFixed(3)}) of ${candidates} candidates`,
  };
}
