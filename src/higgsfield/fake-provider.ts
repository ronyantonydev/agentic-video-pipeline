/**
 * Fake provider. Costs nothing, produces real media.
 *
 * It shells out to FFmpeg to synthesise genuine MP4s and PNGs rather than
 * writing placeholder bytes, so machine QA, normalisation, and rendering all
 * exercise real code paths in Phase 5. The only thing not proven is the
 * network call itself.
 *
 * Failure injection is deterministic - derived from the prompt hash - so a
 * test that reproduces a failure keeps reproducing it.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnv } from '../config/env.js';
import { loadProjectDefaults } from '../config/loader.js';
import { log } from '../util/logger.js';
import {
  ProviderError,
  type GenerationProvider,
  type SubmitVideoRequest,
  type SubmitImageRequest,
  type SubmitAudioRequest,
  type SubmitResult,
  type PollResult,
  type JobStatus,
} from './provider.js';

const exec = promisify(execFile);

type FakeJob = {
  jobId: string;
  kind: 'video' | 'image' | 'audio';
  status: JobStatus;
  createdAt: number;
  /** Polls remaining before the job reports completion. */
  pollsRemaining: number;
  localPath: string;
  credits: number;
  failureReason?: string;
};

export type FakeProviderOptions = {
  /** Polls before a job completes. 0 completes immediately. */
  latencyPolls?: number;
  /** Fraction of jobs that fail, selected deterministically by prompt. */
  failureRate?: number;
  /** Directory for synthesised assets. */
  workDir?: string;
  /** Skip FFmpeg and write tiny stub files. Much faster for unit tests. */
  stubMedia?: boolean;
};

export class FakeProvider implements GenerationProvider {
  readonly name = 'fake';
  readonly isPaid = false;

  private jobs = new Map<string, FakeJob>();
  private counter = 0;
  private readonly opts: Required<FakeProviderOptions>;

  constructor(opts: FakeProviderOptions = {}) {
    this.opts = {
      latencyPolls: opts.latencyPolls ?? 1,
      failureRate: opts.failureRate ?? 0,
      workDir: opts.workDir ?? join(tmpdir(), 'avp-fake-assets'),
      stubMedia: opts.stubMedia ?? false,
    };
    mkdirSync(this.opts.workDir, { recursive: true });
  }

  /* ------------------------------------------------------------- submit */

  async submitVideo(req: SubmitVideoRequest): Promise<SubmitResult> {
    // Mirror the real API's contract: image2video models reject a request
    // with no start image, and we want that failure in Phase 5, not Phase 6.
    if (req.modelSlug.includes('/dop/') && !req.startImage) {
      throw new ProviderError(`${req.modelSlug} requires a start image`, undefined, false);
    }
    if (req.modelSlug.includes('first-last-frame') && !req.endImage) {
      throw new ProviderError(
        `${req.modelSlug} requires an end image`,
        undefined,
        false,
      );
    }
    return this.enqueue('video', req.prompt, req.durationSeconds, req);
  }

  async submitImage(req: SubmitImageRequest): Promise<SubmitResult> {
    return this.enqueue('image', req.prompt, 0, req);
  }

  async submitAudio(req: SubmitAudioRequest): Promise<SubmitResult> {
    return this.enqueue('audio', req.prompt, req.durationSeconds, req);
  }

  private async enqueue(
    kind: 'video' | 'image' | 'audio',
    prompt: string,
    durationSeconds: number,
    req: { modelSlug: string; seed?: number },
  ): Promise<SubmitResult> {
    this.counter += 1;
    const jobId = `fake_${kind}_${String(this.counter).padStart(4, '0')}`;
    const submittedAt = new Date().toISOString();

    const ext = kind === 'video' ? 'mp4' : kind === 'image' ? 'png' : 'wav';
    const localPath = join(this.opts.workDir, `${jobId}.${ext}`);

    const willFail = this.deterministicFailure(prompt, req.seed);

    this.jobs.set(jobId, {
      jobId,
      kind,
      status: 'queued',
      createdAt: Date.now(),
      pollsRemaining: this.opts.latencyPolls,
      localPath,
      credits: 0,
      ...(willFail ? { failureReason: 'synthetic failure (deterministic)' } : {}),
    });

    if (!willFail) {
      await this.synthesise(kind, localPath, durationSeconds, prompt);
    }

    log.debug(`fake provider queued ${jobId}`, { model: req.modelSlug, kind });
    return { jobId, status: 'queued', submittedAt };
  }

  /* --------------------------------------------------------------- poll */

  async poll(jobId: string): Promise<PollResult> {
    const job = this.jobs.get(jobId);
    if (!job) throw new ProviderError(`Unknown job ${jobId}`, jobId, false);

    if (job.status === 'completed' || job.status === 'failed') {
      return this.describe(job);
    }

    if (job.pollsRemaining > 0) {
      job.pollsRemaining -= 1;
      job.status = 'running';
      return { jobId, status: 'running', progress: 0.5 };
    }

    // Failures charge nothing, matching Higgsfield's documented behaviour.
    job.status = job.failureReason ? 'failed' : 'completed';
    job.credits = job.failureReason ? 0 : 1;
    return this.describe(job);
  }

  private describe(job: FakeJob): PollResult {
    if (job.status === 'failed') {
      return {
        jobId: job.jobId,
        status: 'failed',
        actualCredits: 0,
        error: job.failureReason ?? 'unknown',
      };
    }
    return {
      jobId: job.jobId,
      status: job.status,
      resultUrl: `file://${job.localPath}`,
      actualCredits: job.credits,
      progress: 1,
    };
  }

  /* ----------------------------------------------------------- download */

  async download(resultUrl: string, destPath: string): Promise<void> {
    const source = resultUrl.startsWith('file://') ? resultUrl.slice('file://'.length) : resultUrl;
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(source, destPath);
  }

  async balance(): Promise<number | null> {
    return null; // Fake provider has no balance.
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job && job.status !== 'completed') job.status = 'cancelled';
  }

  /* ------------------------------------------------------------ helpers */

  /**
   * Same prompt and seed always produce the same verdict, so a reproduced
   * failure stays reproduced.
   */
  private deterministicFailure(prompt: string, seed?: number): boolean {
    if (this.opts.failureRate <= 0) return false;
    const hash = createHash('sha256').update(`${prompt}:${seed ?? 0}`).digest();
    return (hash[0]! / 255) < this.opts.failureRate;
  }

  /** Produce real media so downstream QA and rendering are genuinely exercised. */
  private async synthesise(
    kind: 'video' | 'image' | 'audio',
    path: string,
    durationSeconds: number,
    prompt: string,
  ): Promise<void> {
    if (this.opts.stubMedia) {
      writeFileSync(path, `stub:${kind}:${prompt.slice(0, 40)}`);
      return;
    }

    const env = loadEnv();
    const d = loadProjectDefaults();
    const { width, height, fps } = d.video;

    // Hue derived from the prompt so different shots look different, which
    // makes frozen-frame and black-frame QA meaningful.
    const hue = createHash('md5').update(prompt).digest()[0]! % 360;

    try {
      if (kind === 'video') {
        const dur = Math.max(1, durationSeconds);
        await exec(env.ffmpegBin, [
          '-y', '-loglevel', 'error',
          '-f', 'lavfi',
          '-i', `testsrc2=size=${width}x${height}:rate=${fps}:duration=${dur}`,
          '-f', 'lavfi',
          '-i', `sine=frequency=${220 + hue}:duration=${dur}`,
          '-c:v', 'libx264', '-pix_fmt', d.video.pixelFormat, '-preset', 'ultrafast',
          '-c:a', 'aac', '-shortest',
          path,
        ]);
      } else if (kind === 'image') {
        await exec(env.ffmpegBin, [
          '-y', '-loglevel', 'error',
          '-f', 'lavfi',
          '-i', `gradients=size=${width}x${height}:duration=1:speed=0.1`,
          '-frames:v', '1',
          path,
        ]);
      } else {
        const dur = Math.max(1, durationSeconds);
        await exec(env.ffmpegBin, [
          '-y', '-loglevel', 'error',
          '-f', 'lavfi', '-i', `sine=frequency=${220 + hue}:duration=${dur}`,
          '-c:a', 'pcm_s16le',
          path,
        ]);
      }
    } catch (err) {
      throw new ProviderError(
        `Failed to synthesise fake ${kind}: ${(err as Error).message}`,
        undefined,
        false,
      );
    }
  }

  /** Test helper: how many jobs this provider has seen. */
  get jobCount(): number {
    return this.jobs.size;
  }
}
