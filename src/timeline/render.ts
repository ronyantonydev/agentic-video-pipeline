/**
 * Drive the HyperFrames CLI. Architecture section 27.
 *
 * Lint before render: a composition mistake caught by `hyperframes lint`
 * costs seconds, whereas discovering it after a multi-minute headless-Chrome
 * render costs the whole render.
 *
 * Free and local - HyperFrames renders on this machine.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../util/logger.js';
import { probe, type MediaInfo } from '../ffmpeg/probe.js';

const exec = promisify(execFile);

export type RenderOptions = {
  /** Project directory containing hyperframes.json and index.html. */
  projectDir: string;
  outputPath: string;
  fps: number;
  /** Rendering is CPU-bound; leave headroom for the rest of the machine. */
  workers?: number;
  quality?: 'draft' | 'standard' | 'high';
  timeoutMs?: number;
};

export type RenderResult = {
  outputPath: string;
  info: MediaInfo;
  durationSeconds: number;
  elapsedMs: number;
};

export class RenderError extends Error {
  constructor(
    message: string,
    readonly stage: 'lint' | 'render' | 'verify',
    readonly output?: string,
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

/** Validate a composition without rendering it. */
export async function lintComposition(projectDir: string): Promise<string> {
  try {
    const { stdout, stderr } = await exec(
      'npx',
      ['hyperframes', 'lint', projectDir],
      { maxBuffer: 16 * 1024 * 1024, timeout: 180_000 },
    );
    return `${stdout}${stderr}`.trim();
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new RenderError(
      `Composition failed lint: ${(e.stderr || e.stdout || e.message).slice(0, 600)}`,
      'lint',
      `${e.stdout ?? ''}${e.stderr ?? ''}`,
    );
  }
}

/**
 * Render the composition to MP4.
 *
 * @throws RenderError when HyperFrames fails or produces no usable file.
 */
export async function renderComposition(opts: RenderOptions): Promise<RenderResult> {
  if (!existsSync(opts.projectDir)) {
    throw new RenderError(`Project directory not found: ${opts.projectDir}`, 'render');
  }
  mkdirSync(dirname(opts.outputPath), { recursive: true });

  const args = [
    'hyperframes', 'render', opts.projectDir,
    '--output', opts.outputPath,
    '--fps', String(opts.fps),
  ];
  if (opts.workers) args.push('--workers', String(opts.workers));
  if (opts.quality) args.push('--quality', opts.quality);

  log.info(`Rendering ${opts.projectDir} -> ${opts.outputPath}`);
  const started = Date.now();

  try {
    await exec('npx', args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 1_800_000,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new RenderError(
      `Render failed: ${(e.stderr || e.stdout || e.message).slice(0, 800)}`,
      'render',
      `${e.stdout ?? ''}${e.stderr ?? ''}`,
    );
  }

  const elapsedMs = Date.now() - started;

  if (!existsSync(opts.outputPath)) {
    throw new RenderError('Render reported success but produced no file', 'verify');
  }

  // Probing here rather than trusting the exit code: a truncated or
  // audio-less render exits zero but is not a finished video.
  let info: MediaInfo;
  try {
    info = await probe(opts.outputPath);
  } catch (err) {
    throw new RenderError(`Render output is unreadable: ${(err as Error).message}`, 'verify');
  }

  if (!info.video || info.durationSeconds <= 0) {
    throw new RenderError('Render output has no usable video stream', 'verify');
  }

  log.info(
    `Rendered ${info.durationSeconds.toFixed(1)}s in ${(elapsedMs / 1000).toFixed(0)}s ` +
      `(${(info.sizeBytes / 1048576).toFixed(1)}MB)`,
  );

  return { outputPath: opts.outputPath, info, durationSeconds: info.durationSeconds, elapsedMs };
}

/** Sensible worker count: leave two cores for the rest of the machine. */
export function defaultWorkers(): number {
  const cpus = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
    ?.hardwareConcurrency;
  const total = cpus ?? 4;
  return Math.max(1, total - 2);
}
