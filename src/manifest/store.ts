/**
 * manifest.json - the record of everything paid for.
 * Architecture sections 22, 23, 24.
 *
 * Two rules govern this file:
 *   1. An entry is written BEFORE a job is submitted, so a crash between
 *      submission and completion still leaves the job recoverable.
 *   2. Entries are never deleted or overwritten in place. A paid asset that
 *      vanishes from the manifest is money that cannot be accounted for.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { writeJsonAtomic } from '../util/atomic.js';
import { paths } from '../state/paths.js';
import { ValidationError, UnknownCostError } from '../util/errors.js';
import {
  ManifestSchema,
  emptyManifest,
  type Manifest,
  type ManifestEntry,
} from '../schemas/state.js';

export function readManifest(project: string): Manifest {
  const file = paths(project).manifest;
  if (!existsSync(file)) return emptyManifest(project);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ValidationError(
      `manifest.json is not valid JSON (${(err as Error).message}). ` +
        `This file records paid work - do not delete it. Recover from checkpoints/.`,
      'manifest.json',
    );
  }

  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ValidationError(
      `manifest.json failed validation:\n  ${issues.join('\n  ')}`,
      'manifest.json',
      issues,
    );
  }
  return parsed.data;
}

function writeManifest(project: string, manifest: Manifest): Manifest {
  const parsed = ManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ValidationError(
      `Refusing to write invalid manifest.json:\n  ${issues.join('\n  ')}`,
      'manifest.json',
      issues,
    );
  }
  writeJsonAtomic(paths(project).manifest, parsed.data);
  return parsed.data;
}

/**
 * Append a new entry. Call this BEFORE submitting the paid job.
 *
 * Throws if the assetHash already exists - that would mean paying twice for
 * an identical asset. Use `findByHash` first to reuse instead.
 */
export function appendEntry(project: string, entry: ManifestEntry): Manifest {
  const manifest = readManifest(project);

  const clash = manifest.entries.find((e) => e.assetHash === entry.assetHash);
  if (clash) {
    throw new ValidationError(
      `Asset ${entry.assetHash} already exists in the manifest (status: ${clash.status}). ` +
        `Reuse it rather than paying again.`,
      'manifest.json',
    );
  }

  return writeManifest(project, { ...manifest, entries: [...manifest.entries, entry] });
}

/**
 * Update an existing entry, identified by assetHash.
 *
 * Immutable fields are protected: once a job has been submitted with a given
 * prompt and model, rewriting that history would break cost accounting.
 */
export function updateEntry(
  project: string,
  assetHash: string,
  patch: Partial<Omit<ManifestEntry, 'assetHash' | 'prompt' | 'model' | 'provider' | 'submittedAt'>>,
): Manifest {
  const manifest = readManifest(project);
  const index = manifest.entries.findIndex((e) => e.assetHash === assetHash);
  if (index === -1) {
    throw new ValidationError(`No manifest entry with assetHash ${assetHash}`, 'manifest.json');
  }

  const entries = [...manifest.entries];
  entries[index] = { ...entries[index]!, ...patch };
  return writeManifest(project, { ...manifest, entries });
}

export function findByHash(project: string, assetHash: string): ManifestEntry | undefined {
  return readManifest(project).entries.find((e) => e.assetHash === assetHash);
}

/**
 * A previously completed, accepted asset that can be reused rather than
 * regenerated. Architecture section 22 - never pay twice.
 */
export function findReusable(project: string, assetHash: string): ManifestEntry | undefined {
  const entry = findByHash(project, assetHash);
  if (!entry) return undefined;
  if (entry.status !== 'completed') return undefined;
  if (!entry.localFile || !existsSync(entry.localFile)) return undefined;
  return entry;
}

/** Entries left mid-flight by a crash - recoverable by polling their jobId. */
export function findInFlight(project: string): ManifestEntry[] {
  return readManifest(project).entries.filter(
    (e) => e.status === 'submitted' || e.status === 'polling',
  );
}

/* -------------------------------------------------------------- asset hash */

/**
 * Stable identity for a generation. Architecture section 22.
 *
 * Any input that changes the output must be included, or two different
 * generations would collide and the second would silently reuse the first.
 */
export function computeAssetHash(input: {
  kind: 'video' | 'image' | 'audio';
  model: string;
  prompt: string;
  duration?: number;
  startFrameHash?: string;
  endFrameHash?: string;
  seed?: number;
  settings?: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify({
    kind: input.kind,
    model: input.model,
    prompt: input.prompt.trim(),
    duration: input.duration ?? null,
    startFrameHash: input.startFrameHash ?? null,
    endFrameHash: input.endFrameHash ?? null,
    seed: input.seed ?? null,
    settings: sortKeys(input.settings ?? {}),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** Hash file contents, so a changed reference image produces a new asset id. */
export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}

/** Key order must not affect the hash. */
function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const value = obj[key];
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? sortKeys(value as Record<string, unknown>)
        : value;
  }
  return out;
}

/* ------------------------------------------------------------- accounting */

/** Statuses Higgsfield does not charge for. Architecture: failed/nsfw are free. */
function isChargeable(entry: ManifestEntry): boolean {
  return (
    entry.status !== 'failed' && entry.status !== 'cancelled' && entry.status !== 'refunded'
  );
}

export type SpendTotals = {
  usd: number;
  credits: number;
  /** Chargeable entries whose cost is unknown. Their spend is NOT in the totals. */
  unpricedEntries: string[];
};

/**
 * Total spend, with unknown costs surfaced rather than silently counted as zero.
 *
 * Treating an unknown cost as 0 would understate spend and let a budget check
 * approve a call that should have been refused. Callers must decide what to do
 * about `unpricedEntries` - `assertFullyPriced` is the strict option.
 */
export function totalSpend(project: string): SpendTotals {
  const totals: SpendTotals = { usd: 0, credits: 0, unpricedEntries: [] };

  for (const e of readManifest(project).entries) {
    if (!isChargeable(e)) continue;

    const usd = e.actualUSD ?? e.estimatedUSD;
    const credits = e.actualCredits ?? e.estimatedCredits;

    if (usd === null && credits === null) {
      totals.unpricedEntries.push(e.assetHash);
      continue;
    }
    if (usd !== null) totals.usd += usd;
    if (credits !== null) totals.credits += credits;
  }

  return totals;
}

/**
 * Throw if any chargeable entry has no known cost.
 * Call this before a budget decision - see architecture section 19.
 */
export function assertFullyPriced(project: string): SpendTotals {
  const totals = totalSpend(project);
  if (totals.unpricedEntries.length > 0) {
    throw new UnknownCostError(
      totals.unpricedEntries.join(', '),
      `${totals.unpricedEntries.length} chargeable manifest entr` +
        `${totals.unpricedEntries.length === 1 ? 'y has' : 'ies have'} no recorded cost`,
    );
  }
  return totals;
}

export function totalSpentUSD(project: string): number {
  return totalSpend(project).usd;
}

export function totalSpentCredits(project: string): number {
  return totalSpend(project).credits;
}
