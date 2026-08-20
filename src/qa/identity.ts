/**
 * Identity drift detection.
 *
 * Two problems, both from real failures:
 *
 *   1. A character reference that does not actually hold. Discovered after
 *      paying for fourteen shots, or discovered for one credit by testing
 *      first. The drift test does the latter.
 *
 *   2. Drift WITHIN a clip. A generation can start on-model and end as
 *      someone else, so checking the start frame alone is not enough - the
 *      end frame has to be compared too.
 *
 * Comparison is perceptual-hash based: free, local, and good enough to catch
 * "that is a different person". It cannot judge whether a face is *the same*
 * with certainty, so a low score flags for human review rather than
 * triggering a paid retry (architecture section 15).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnv } from '../config/env.js';
import { probe } from '../ffmpeg/probe.js';
import { log } from '../util/logger.js';

const exec = promisify(execFile);

/** Grid size for the perceptual hash. 8x8 = 64 bits. */
const HASH_SIZE = 8;

export type DriftResult = {
  /** 0 = identical, 1 = nothing in common. */
  distance: number;
  /** 1 - distance, so higher is better. */
  similarity: number;
  pass: boolean;
};

export type DriftTestResult = {
  samples: number;
  meanSimilarity: number;
  minSimilarity: number;
  /** True when every sample stayed close enough to the master. */
  holds: boolean;
  /** Samples that drifted, by index. */
  outliers: number[];
  recommendation: string;
};

/**
 * Perceptual hash of an image: downscale to 8x8 greyscale, then record
 * whether each pixel is above the mean.
 *
 * Robust to resolution, compression and small colour shifts - which is what
 * we want, since the same character rendered twice is never pixel-identical.
 */
export async function perceptualHash(imagePath: string): Promise<bigint> {
  const env = loadEnv();
  if (!existsSync(imagePath)) throw new Error(`No such image: ${imagePath}`);

  // rawvideo gray gives one byte per pixel, so the values can be read
  // directly without decoding an image format.
  const { stdout } = await exec(
    env.ffmpegBin,
    [
      '-v', 'error',
      '-i', imagePath,
      '-vf', `scale=${HASH_SIZE}:${HASH_SIZE}:flags=area,format=gray`,
      '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'gray',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 },
  );

  const pixels = [...(stdout as unknown as Buffer)];
  const mean = pixels.reduce((a, b) => a + b, 0) / pixels.length;

  let hash = 0n;
  for (const p of pixels) hash = (hash << 1n) | (p > mean ? 1n : 0n);
  return hash;
}

/** Normalised Hamming distance between two hashes. */
export function hashDistance(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let bits = 0;
  while (diff > 0n) {
    bits += Number(diff & 1n);
    diff >>= 1n;
  }
  return bits / (HASH_SIZE * HASH_SIZE);
}

/**
 * Compare one image against the character master.
 *
 * `threshold` is a similarity floor, not a certainty. Framing and lighting
 * move this legitimately, so it is set loose enough that only a genuinely
 * different subject fails.
 */
export async function compareToMaster(
  imagePath: string,
  masterPath: string,
  threshold = 0.55,
): Promise<DriftResult> {
  const [a, b] = await Promise.all([perceptualHash(imagePath), perceptualHash(masterPath)]);
  const distance = hashDistance(a, b);
  const similarity = 1 - distance;
  return { distance, similarity, pass: similarity >= threshold };
}

/**
 * Check whether a clip ends as the same subject it started as.
 *
 * A generation can begin on-model and drift over eight seconds, which no
 * start-frame check would ever notice.
 */
export async function checkClipDrift(
  videoPath: string,
  threshold = 0.55,
): Promise<DriftResult & { firstFrame: string; lastFrame: string }> {
  const env = loadEnv();
  const info = await probe(videoPath);
  const scratch = join(tmpdir(), `avp-drift-${process.pid}-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });

  const firstFrame = join(scratch, 'first.png');
  const lastFrame = join(scratch, 'last.png');

  // Step in from both ends: the very first and last frames are often a fade
  // or an encoder flush rather than representative content.
  const start = Math.min(0.2, info.durationSeconds * 0.05);
  const end = Math.max(0, info.durationSeconds - 0.2);

  for (const [t, out] of [
    [start, firstFrame],
    [end, lastFrame],
  ] as const) {
    await exec(env.ffmpegBin, [
      '-v', 'error', '-y', '-ss', t.toFixed(3), '-i', videoPath, '-frames:v', '1', out,
    ]);
  }

  const result = await compareToMaster(lastFrame, firstFrame, threshold);
  return { ...result, firstFrame, lastFrame };
}

/**
 * The drift test. Architecture note: this is the cheapest check in the
 * pipeline and it guards the most expensive mistake.
 *
 * Generate a handful of cheap images from the character reference, compare
 * each to the master, and only commit to a full run if identity holds.
 * Discovering a bad reference here costs about one credit; discovering it
 * after fourteen shots costs two hundred and fifty.
 */
export async function runDriftTest(
  masterPath: string,
  samplePaths: string[],
  opts: { threshold?: number; minMeanSimilarity?: number } = {},
): Promise<DriftTestResult> {
  const threshold = opts.threshold ?? 0.55;
  const minMean = opts.minMeanSimilarity ?? 0.60;

  if (samplePaths.length === 0) {
    return {
      samples: 0,
      meanSimilarity: 0,
      minSimilarity: 0,
      holds: false,
      outliers: [],
      recommendation: 'No samples generated - cannot judge whether the reference holds.',
    };
  }

  const scores: number[] = [];
  const outliers: number[] = [];

  for (const [i, sample] of samplePaths.entries()) {
    try {
      const r = await compareToMaster(sample, masterPath, threshold);
      scores.push(r.similarity);
      if (!r.pass) outliers.push(i);
    } catch (err) {
      log.warn(`drift sample ${i} unreadable: ${(err as Error).message}`);
      scores.push(0);
      outliers.push(i);
    }
  }

  const meanSimilarity = scores.reduce((a, b) => a + b, 0) / scores.length;
  const minSimilarity = Math.min(...scores);
  const holds = outliers.length === 0 && meanSimilarity >= minMean;

  return {
    samples: samplePaths.length,
    meanSimilarity: round3(meanSimilarity),
    minSimilarity: round3(minSimilarity),
    holds,
    outliers,
    recommendation: holds
      ? `Reference holds across ${samplePaths.length} samples. Safe to commit to the full run.`
      : `Identity drifted on ${outliers.length} of ${samplePaths.length} samples ` +
        `(mean ${meanSimilarity.toFixed(2)}, worst ${minSimilarity.toFixed(2)}). ` +
        `Regenerate the character reference with more distinctive, fixable detail ` +
        `before spending on shots.`,
  };
}

export function formatDriftTest(result: DriftTestResult): string {
  const lines = [
    `Drift test: ${result.holds ? 'PASS' : 'FAIL'}`,
    `  ${result.samples} samples, mean similarity ${result.meanSimilarity.toFixed(2)}, ` +
      `worst ${result.minSimilarity.toFixed(2)}`,
  ];
  if (result.outliers.length > 0) {
    lines.push(`  drifted: sample ${result.outliers.join(', ')}`);
  }
  lines.push(`  ${result.recommendation}`);
  return lines.join('\n');
}

/** Where the six-image reference pack lives. */
export function referencePackPaths(characterDir: string): string[] {
  const angles = ['face-front', 'face-three-quarter', 'face-profile',
                  'body-front', 'body-three-quarter', 'body-back'];
  return angles.map((a) => join(characterDir, `${a}.png`));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
