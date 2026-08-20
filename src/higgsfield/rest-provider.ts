/**
 * The real Higgsfield REST backend. This one spends money.
 *
 * Contract verified against the live API on 2026-08-20:
 *   POST /{slug}                       -> { request_id, status, status_url }
 *   GET  /requests/{id}/status         -> { status, images|videos: [{url}] }
 *   POST /requests/{id}/cancel
 *   Authorization: Key {id}:{secret}
 *
 * Terminal states: completed, failed, nsfw, canceled (US spelling from the API).
 * failed and nsfw are not charged - refunds are automatic.
 *
 * This class must never enforce budget policy. The guard runs before submit
 * is ever reached; a provider that silently declined a call for cost reasons
 * would hide the refusal from the ledger.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { loadEnv } from '../config/env.js';
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

type SubmitResponse = {
  status?: string;
  request_id?: string;
  status_url?: string;
  cancel_url?: string;
};

type StatusResponse = {
  status?: string;
  request_id?: string;
  images?: { url?: string }[];
  videos?: { url?: string }[];
  audios?: { url?: string }[];
  results?: { url?: string }[];
  credits?: number | string;
  error?: string;
  detail?: unknown;
};

export class RestProvider implements GenerationProvider {
  readonly name = 'higgsfield';
  readonly isPaid = true;

  /** status_url per request id, as returned by submit. */
  private statusUrls = new Map<string, string>();

  constructor(private readonly timeoutMs = 60_000) {}

  private headers(): Record<string, string> {
    const env = loadEnv();
    if (!env.hasHiggsfieldCredentials) {
      throw new ProviderError(
        'HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET are required for paid generation.',
      );
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Key ${env.HIGGSFIELD_API_KEY}:${env.HIGGSFIELD_API_SECRET}`,
    };
  }

  /* ------------------------------------------------------------- submit */

  async submitVideo(req: SubmitVideoRequest): Promise<SubmitResult> {
    // Fail before the network call rather than paying for a rejected request.
    if (!req.startImage) {
      throw new ProviderError(`${req.modelSlug} requires a start image (image_url).`);
    }
    if (req.modelSlug.includes('first-last-frame') && !req.endImage) {
      throw new ProviderError(`${req.modelSlug} requires an end image (end_image_url).`);
    }

    return this.submit(req.modelSlug, {
      prompt: req.prompt,
      image_url: req.startImage,
      ...(req.endImage ? { end_image_url: req.endImage } : {}),
      ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
      duration: req.durationSeconds,
      aspect_ratio: req.aspectRatio,
      ...(req.resolution ? { resolution: req.resolution } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      ...(req.settings ?? {}),
    });
  }

  async submitImage(req: SubmitImageRequest): Promise<SubmitResult> {
    return this.submit(req.modelSlug, {
      prompt: req.prompt,
      ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
      aspect_ratio: req.aspectRatio,
      ...(req.resolution ? { resolution: req.resolution } : {}),
      ...(req.referenceImages?.length ? { image_urls: req.referenceImages } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      ...(req.settings ?? {}),
    });
  }

  async submitAudio(req: SubmitAudioRequest): Promise<SubmitResult> {
    return this.submit(req.modelSlug, {
      prompt: req.prompt,
      duration: req.durationSeconds,
      ...(req.settings ?? {}),
    });
  }

  private async submit(slug: string, body: Record<string, unknown>): Promise<SubmitResult> {
    const env = loadEnv();
    const url = new URL(`/${slug.replace(/^\/+/, '')}`, env.HIGGSFIELD_API_BASE);

    log.money(`Submitting to ${slug}`);

    const res = await this.fetchJson(url.toString(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    const parsed = res.body as SubmitResponse;
    const requestId = parsed.request_id;

    if (!res.ok || !requestId) {
      throw new ProviderError(
        `Submit to ${slug} failed (${res.status}): ${JSON.stringify(parsed).slice(0, 300)}`,
        undefined,
        res.status >= 500,
      );
    }

    if (parsed.status_url) this.statusUrls.set(requestId, parsed.status_url);

    return {
      jobId: requestId,
      status: normalizeStatus(parsed.status),
      submittedAt: new Date().toISOString(),
    };
  }

  /* --------------------------------------------------------------- poll */

  async poll(jobId: string): Promise<PollResult> {
    const env = loadEnv();
    const url =
      this.statusUrls.get(jobId) ??
      new URL(`/requests/${jobId}/status`, env.HIGGSFIELD_API_BASE).toString();

    const res = await this.fetchJson(url, { headers: this.headers() });
    const body = res.body as StatusResponse;

    if (!res.ok) {
      // A transient 5xx must not be read as a failed generation - that would
      // discard a job that is running and already charged.
      throw new ProviderError(
        `Status check for ${jobId} failed (${res.status})`,
        jobId,
        res.status >= 500 || res.status === 429,
      );
    }

    const status = normalizeStatus(body.status);
    const resultUrl = firstUrl(body);

    if (status === 'completed' && !resultUrl) {
      throw new ProviderError(
        `Job ${jobId} reported completed but returned no output URL: ` +
          `${JSON.stringify(body).slice(0, 200)}`,
        jobId,
        true,
      );
    }

    const credits = toNumber(body.credits);

    return {
      jobId,
      status,
      ...(resultUrl ? { resultUrl } : {}),
      // Failures and nsfw are refunded automatically, so charge is zero.
      actualCredits: status === 'completed' ? credits : 0,
      ...(body.error ? { error: body.error } : {}),
    };
  }

  /* ----------------------------------------------------------- download */

  async download(resultUrl: string, destPath: string): Promise<void> {
    mkdirSync(dirname(destPath), { recursive: true });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs * 5);
    try {
      const res = await fetch(resultUrl, { signal: controller.signal });
      if (!res.ok || !res.body) {
        throw new ProviderError(`Download failed (${res.status}) for ${resultUrl}`);
      }
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(destPath));
    } finally {
      clearTimeout(timer);
    }
  }

  async cancel(jobId: string): Promise<void> {
    const env = loadEnv();
    const url = new URL(`/requests/${jobId}/cancel`, env.HIGGSFIELD_API_BASE).toString();
    try {
      await this.fetchJson(url, { method: 'POST', headers: this.headers() });
    } catch (err) {
      log.warn(`Cancel of ${jobId} failed: ${(err as Error).message}`);
    }
  }

  /* ------------------------------------------------------------ helpers */

  private async fetchJson(
    url: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = { detail: text.slice(0, 300) };
      }
      return { ok: res.ok, status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Map the API's vocabulary onto ours. Note "canceled" - US spelling. */
export function normalizeStatus(raw: string | undefined): JobStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'completed':
    case 'succeeded':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'nsfw':
      return 'nsfw';
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    case 'in_progress':
    case 'processing':
    case 'running':
      return 'running';
    default:
      return 'queued';
  }
}

/** Output arrays vary by media type; take the first URL found. */
export function firstUrl(body: StatusResponse): string | undefined {
  for (const key of ['videos', 'images', 'audios', 'results'] as const) {
    const entry = body[key]?.[0]?.url;
    if (typeof entry === 'string' && entry.length > 0) return entry;
  }
  return undefined;
}

function toNumber(value: number | string | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}
