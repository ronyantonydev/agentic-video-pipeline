/**
 * Higgsfield REST client.
 *
 * Deliberately in code rather than behind Claude's MCP tools: architecture
 * section 2 requires that deterministic code owns every paid call.
 *
 * Phase 3 uses only the estimate endpoint, which spends nothing. Generation
 * lands in Phase 6.
 */

import { loadEnv } from '../config/env.js';
import { log } from '../util/logger.js';

export type EstimateRequest = {
  model: string;
  kind: 'video' | 'image' | 'audio';
  prompt?: string;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
  settings?: Record<string, unknown>;
};

export type EstimateResponse = {
  /** Null when the response carried only a USD figure. Never defaulted to 0. */
  credits: number | null;
  usd: number | null;
  source: 'api';
  raw: unknown;
};

export class HiggsfieldError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'HiggsfieldError';
  }
}

/**
 * Verified against the live API on 2026-08-20:
 *   GET  /models                       -> catalogue with base_credits
 *   POST /estimate/{slug}              -> exact quote for that model
 *   Authorization: Key {id}:{secret}
 *
 * Slugs are path segments ("higgsfield-ai/soul/standard"), not a `model`
 * field in the body.
 */
function authHeaders(): Record<string, string> {
  const env = loadEnv();
  return {
    'Content-Type': 'application/json',
    Authorization: `Key ${env.HIGGSFIELD_API_KEY}:${env.HIGGSFIELD_API_SECRET}`,
  };
}

export type CatalogModel = {
  slug: string;
  title: string;
  baseCredits: number;
  operationTypes: string[];
  outputType: 'video' | 'image' | 'audio' | string;
};

/**
 * Fetch the REST catalogue. This is the authoritative list of what the API
 * key can actually generate - it differs from the MCP model list.
 */
export async function listModels(timeoutMs = 15_000): Promise<CatalogModel[] | null> {
  const env = loadEnv();
  if (!env.hasHiggsfieldCredentials) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL('/models', env.HIGGSFIELD_API_BASE), {
      headers: authHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const body = (await res.json()) as { items?: unknown[] };
    if (!Array.isArray(body.items)) return null;

    return body.items.flatMap((raw) => {
      const m = raw as Record<string, unknown>;
      const slug = typeof m['slug'] === 'string' ? m['slug'] : null;
      if (!slug) return [];
      return [
        {
          slug,
          title: typeof m['title'] === 'string' ? m['title'] : slug,
          baseCredits: Number(m['base_credits'] ?? 0),
          operationTypes: Array.isArray(m['operation_type'])
            ? (m['operation_type'] as string[])
            : [],
          outputType: typeof m['output_type'] === 'string' ? m['output_type'] : 'unknown',
        },
      ];
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(
  path: string,
  body: unknown,
  timeoutMs = 20_000,
): Promise<{ ok: boolean; status: number; text: string }> {
  const env = loadEnv();
  const url = new URL(path, env.HIGGSFIELD_API_BASE).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask Higgsfield what a generation will cost, before committing to it.
 *
 * Returns null when the endpoint is unavailable or unauthenticated - the
 * caller then falls back to learned costs, and refuses if none exist.
 * Never invents a number.
 */
export async function estimateCost(req: EstimateRequest): Promise<EstimateResponse | null> {
  const env = loadEnv();
  if (!env.hasHiggsfieldCredentials) {
    log.debug('No Higgsfield credentials; skipping estimate endpoint.');
    return null;
  }

  const payload = {
    ...(req.prompt !== undefined ? { prompt: req.prompt } : {}),
    ...(req.durationSeconds !== undefined ? { duration: req.durationSeconds } : {}),
    ...(req.aspectRatio !== undefined ? { aspect_ratio: req.aspectRatio } : {}),
    ...(req.resolution !== undefined ? { resolution: req.resolution } : {}),
    ...(req.settings ?? {}),
  };

  // The model slug is a path segment, not a body field.
  const path = `/estimate/${req.model.replace(/^\/+/, '')}`;

  try {
    const res = await postJson(path, payload);
    if (!res.ok) {
      log.debug(`Estimate ${path} returned ${res.status}`, { body: res.text.slice(0, 200) });
      return null;
    }

    const parsed = parseEstimate(res.text);
    if (parsed) {
      log.debug('Estimate resolved', { model: req.model, credits: parsed.credits });
      return parsed;
    }
    log.warn(`Estimate ${path} returned an unrecognised shape`, { body: res.text.slice(0, 200) });
  } catch (err) {
    log.debug(`Estimate ${path} failed: ${(err as Error).message}`);
  }

  return null;
}

/**
 * Extract credits/USD from a response whose exact field names are not
 * contractually fixed. Returns null rather than guessing.
 */
export function parseEstimate(text: string): EstimateResponse | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;

  const flat = body as Record<string, unknown>;
  const nested =
    typeof flat['estimate'] === 'object' && flat['estimate'] !== null
      ? (flat['estimate'] as Record<string, unknown>)
      : flat;

  const credits = firstNumber(nested, ['credits', 'credit', 'cost_credits', 'creditCost']);
  const usd = firstNumber(nested, ['usd', 'cost_usd', 'usdCost', 'price_usd', 'dollars']);

  if (credits === null && usd === null) return null;

  // A cost of zero from a paid endpoint is more likely a parse miss than a
  // free generation, so treat it as unusable rather than as "free".
  if (credits !== null && credits <= 0 && (usd === null || usd <= 0)) return null;

  // Both fields stay nullable. Reporting a missing credits value as 0 would
  // defeat the credit-floor check in the budget guard.
  return { credits, usd, source: 'api', raw: body };
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

/** True when credentials are present and the API authenticates them. */
export async function checkConnectivity(): Promise<boolean> {
  return (await listModels(8000)) !== null;
}
