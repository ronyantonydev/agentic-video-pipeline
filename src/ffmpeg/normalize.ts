/**
 * Normalisation. Architecture section 26.
 *
 * Different AI models return different resolutions, frame rates and colour
 * spaces. None of that goes into the timeline directly - every clip is
 * conformed to the project settings locked at init, so the editor is
 * working with one consistent format.
 *
 * Free and local. No credits.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadEnv } from '../config/env.js';
import { loadProjectDefaults, type ProjectDefaults } from '../config/loader.js';
import { probe, type MediaInfo } from './probe.js';
import { log } from '../util/logger.js';

const exec = promisify(execFile);

export type NormalizeResult = {
  input: string;
  output: string;
  before: MediaInfo;
  after: MediaInfo;
  /** True when the source already matched and was only remuxed. */
  wasConformant: boolean;
  upscaled: boolean;
};

/**
 * Conform one clip to the project format.
 *
 * Scaling preserves aspect ratio and pads rather than cropping - cropping
 * would silently discard framing the shot was composed for.
 */
export async function normalizeClip(
  input: string,
  output: string,
  defaults: ProjectDefaults = loadProjectDefaults(),
): Promise<NormalizeResult> {
  const env = loadEnv();
  const before = await probe(input);

  if (!before.video) {
    throw new Error(`${input} has no video stream`);
  }

  const { width, height, fps, pixelFormat, colorspace } = defaults.video;
  const wasConformant =
    before.video.width === width &&
    before.video.height === height &&
    Math.abs(before.video.fps - fps) < 0.01;

  const upscaled = before.video.width < width || before.video.height < height;

  mkdirSync(dirname(output), { recursive: true });

  // scale -> pad keeps the full frame and letterboxes if the aspect differs.
  // setsar=1 avoids non-square pixels leaking into the timeline.
  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${fps}`,
  ].join(',');

  // Every input must be declared before any output option. A silent source
  // needs a second (generated) input, so inputs are assembled first and the
  // filter/codec options appended afterwards.
  const args = ['-v', 'error', '-y', '-i', input];

  if (!before.audio) {
    // A clip with no audio still needs a silent track, or concatenation
    // later will drop audio from every clip after the gap.
    args.push(
      '-f', 'lavfi',
      '-i', `anullsrc=channel_layout=stereo:sample_rate=${defaults.audio.sampleRate}`,
    );
  }

  args.push(
    '-map', '0:v:0',
    '-map', before.audio ? '0:a:0' : '1:a:0',
    '-vf', vf,
    '-c:v', defaults.encoding.videoCodec,
    '-crf', String(defaults.encoding.crf),
    '-preset', defaults.encoding.preset,
    '-pix_fmt', pixelFormat,
    '-colorspace', colorspace,
    '-color_primaries', colorspace,
    '-color_trc', colorspace === 'bt709' ? 'bt709' : 'iec61966-2-1',
    '-c:a', defaults.audio.codec,
    '-b:a', defaults.audio.bitrate,
    '-ar', String(defaults.audio.sampleRate),
    '-ac', String(defaults.audio.channels),
  );

  if (!before.audio) args.push('-shortest');

  args.push('-movflags', '+faststart', output);

  await exec(env.ffmpegBin, args, { maxBuffer: 16 * 1024 * 1024 });

  const after = await probe(output);
  return { input, output, before, after, wasConformant, upscaled };
}

/** Extract the final frame, used as the start frame of a chained shot (§13). */
export async function extractEndFrame(video: string, output: string): Promise<void> {
  const env = loadEnv();
  const info = await probe(video);
  mkdirSync(dirname(output), { recursive: true });

  // Step back slightly from the true end: the last frame is sometimes a
  // partial or duplicated flush frame.
  const t = Math.max(0, info.durationSeconds - 0.1);
  await exec(env.ffmpegBin, [
    '-v', 'error', '-y',
    '-ss', t.toFixed(3),
    '-i', video,
    '-frames:v', '1',
    output,
  ]);
}

/** Verify a normalised file actually matches the locked settings. */
export function conformsToProject(
  info: MediaInfo,
  defaults: ProjectDefaults = loadProjectDefaults(),
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const v = info.video;

  if (!v) {
    problems.push('no video stream');
    return { ok: false, problems };
  }
  if (v.width !== defaults.video.width || v.height !== defaults.video.height) {
    problems.push(
      `resolution ${v.width}x${v.height}, expected ` +
        `${defaults.video.width}x${defaults.video.height}`,
    );
  }
  if (Math.abs(v.fps - defaults.video.fps) > 0.02) {
    problems.push(`fps ${v.fps.toFixed(2)}, expected ${defaults.video.fps}`);
  }
  if (v.pixelFormat !== defaults.video.pixelFormat) {
    problems.push(`pixel format ${v.pixelFormat}, expected ${defaults.video.pixelFormat}`);
  }
  if (!info.audio) {
    problems.push('no audio stream');
  }

  return { ok: problems.length === 0, problems };
}

/** Normalise many clips, reporting per-clip outcomes. */
export async function normalizeBatch(
  jobs: { input: string; output: string }[],
  defaults: ProjectDefaults = loadProjectDefaults(),
): Promise<{ results: NormalizeResult[]; failures: { input: string; error: string }[] }> {
  const results: NormalizeResult[] = [];
  const failures: { input: string; error: string }[] = [];

  for (const job of jobs) {
    if (!existsSync(job.input)) {
      failures.push({ input: job.input, error: 'missing' });
      continue;
    }
    try {
      const r = await normalizeClip(job.input, job.output, defaults);
      results.push(r);
      log.debug(
        `normalised ${job.input}: ${r.before.video?.width}x${r.before.video?.height}` +
          ` -> ${r.after.video?.width}x${r.after.video?.height}`,
      );
    } catch (err) {
      failures.push({ input: job.input, error: (err as Error).message.slice(0, 200) });
    }
  }

  return { results, failures };
}
