/**
 * ffprobe wrappers. Read-only inspection of media files.
 *
 * Everything here is free and local - no network, no credits.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { loadEnv } from '../config/env.js';

const exec = promisify(execFile);

export type MediaInfo = {
  path: string;
  sizeBytes: number;
  durationSeconds: number;
  video: {
    codec: string;
    width: number;
    height: number;
    fps: number;
    pixelFormat: string;
    frameCount: number | null;
  } | null;
  audio: {
    codec: string;
    sampleRate: number;
    channels: number;
  } | null;
};

export class ProbeError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'ProbeError';
  }
}

/** Parse "30000/1001" style rationals into a number. */
function parseRate(raw: string | undefined): number {
  if (!raw) return 0;
  const [num, den] = raw.split('/').map(Number);
  if (!num) return 0;
  return den ? num / den : num;
}

export async function probe(file: string): Promise<MediaInfo> {
  if (!existsSync(file)) throw new ProbeError(file, 'file does not exist');

  const env = loadEnv();
  let stdout: string;
  try {
    ({ stdout } = await exec(env.ffprobeBin, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      file,
    ]));
  } catch (err) {
    // ffprobe failing outright is the signature of a corrupt or truncated file.
    throw new ProbeError(file, `unreadable (${(err as Error).message.slice(0, 120)})`);
  }

  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Record<string, unknown>[];
  };

  const streams = data.streams ?? [];
  const v = streams.find((s) => s['codec_type'] === 'video');
  const a = streams.find((s) => s['codec_type'] === 'audio');

  return {
    path: file,
    sizeBytes: statSync(file).size,
    durationSeconds: Number(data.format?.duration ?? 0),
    video: v
      ? {
          codec: String(v['codec_name'] ?? 'unknown'),
          width: Number(v['width'] ?? 0),
          height: Number(v['height'] ?? 0),
          fps: parseRate(v['r_frame_rate'] as string),
          pixelFormat: String(v['pix_fmt'] ?? 'unknown'),
          frameCount: v['nb_frames'] ? Number(v['nb_frames']) : null,
        }
      : null,
    audio: a
      ? {
          codec: String(a['codec_name'] ?? 'unknown'),
          sampleRate: Number(a['sample_rate'] ?? 0),
          channels: Number(a['channels'] ?? 0),
        }
      : null,
  };
}

/**
 * Mean luminance per frame, sampled.
 *
 * Used to detect black frames and frozen video without decoding every pixel
 * in JavaScript - ffmpeg's signalstats does the work.
 */
export async function frameLuminance(
  file: string,
  sampleFps = 2,
): Promise<number[]> {
  const env = loadEnv();
  try {
    const { stderr } = await exec(
      env.ffmpegBin,
      [
        '-v', 'info',
        '-i', file,
        '-vf', `fps=${sampleFps},signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
        '-f', 'null', '-',
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    return [...stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]) / 255);
  } catch {
    // A file we cannot analyse is reported as having no samples; the QA
    // layer decides what that means rather than guessing here.
    return [];
  }
}

/**
 * Spatial contrast per frame: the spread of luminance WITHIN each image.
 *
 * This is what distinguishes a real photograph from a flat fill. Averaging
 * luminance across a frame and then comparing frames measures how the
 * exposure drifts over time, which is near-zero for any correctly exposed
 * shot under constant light - it says nothing about whether the frame has
 * content in it.
 */
export async function frameContrast(file: string, sampleFps?: number): Promise<number[]> {
  const env = loadEnv();
  try {
    // An `fps` filter on a single-frame image yields nothing, so a still is
    // measured without one. Passing fps=1 to a PNG silently returned an empty
    // array, which made every thumbnail candidate score zero.
    const filters = ['signalstats', 'metadata=print'];
    if (sampleFps !== undefined) filters.unshift(`fps=${sampleFps}`);

    // No `key=` filter: restricting metadata=print to a single key suppresses
    // every other stat, and the spread needs two of them.
    const { stderr } = await exec(
      env.ffmpegBin,
      ['-v', 'info', '-i', file, '-vf', filters.join(','), '-f', 'null', '-'],
      { maxBuffer: 64 * 1024 * 1024 },
    );

    // YLOW/YHIGH are the 10th/90th percentile within each frame - more
    // robust than YMIN/YMAX, which a single hot pixel can saturate.
    const lows = [...stderr.matchAll(/lavfi\.signalstats\.YLOW=([\d.]+)/g)].map((m) => Number(m[1]));
    const highs = [...stderr.matchAll(/lavfi\.signalstats\.YHIGH=([\d.]+)/g)].map((m) => Number(m[1]));
    if (lows.length > 0 && lows.length === highs.length) {
      return lows.map((lo, i) => (highs[i]! - lo) / 255);
    }

    const mins = [...stderr.matchAll(/lavfi\.signalstats\.YMIN=([\d.]+)/g)].map((m) => Number(m[1]));
    const maxs = [...stderr.matchAll(/lavfi\.signalstats\.YMAX=([\d.]+)/g)].map((m) => Number(m[1]));
    if (mins.length > 0 && mins.length === maxs.length) {
      return mins.map((lo, i) => (maxs[i]! - lo) / 255);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Frame-to-frame difference, sampled. Near-zero over a run means frozen video.
 * Returns one value per sampled frame pair.
 */
export async function frameDifferences(file: string, sampleFps = 2): Promise<number[]> {
  const env = loadEnv();
  try {
    const { stderr } = await exec(
      env.ffmpegBin,
      [
        '-v', 'info',
        '-i', file,
        '-vf', `fps=${sampleFps},tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
        '-f', 'null', '-',
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    return [...stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]) / 255);
  } catch {
    return [];
  }
}

/** Extract representative frames for vision QA. Returns written paths. */
export async function extractFrames(
  file: string,
  outDir: string,
  count: number,
): Promise<string[]> {
  const env = loadEnv();
  const info = await probe(file);
  if (info.durationSeconds <= 0) return [];

  const { mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  mkdirSync(outDir, { recursive: true });

  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    // Sample evenly, avoiding the very first and last frames which are
    // often atypical (fade-in, encoder flush).
    const t = ((i + 0.5) / count) * info.durationSeconds;
    const out = join(outDir, `frame_${String(i + 1).padStart(2, '0')}.jpg`);
    await exec(env.ffmpegBin, [
      '-v', 'error', '-y',
      '-ss', t.toFixed(3),
      '-i', file,
      '-frames:v', '1',
      '-q:v', '3',
      out,
    ]);
    paths.push(out);
  }
  return paths;
}
