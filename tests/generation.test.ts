import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateShot, recoverInFlight } from '../src/orchestrator/generate.js';
import { FakeProvider } from '../src/higgsfield/fake-provider.js';
import { writeState, readState } from '../src/state/store.js';
import { ensureProjectDirs, paths } from '../src/state/paths.js';
import { readManifest, findInFlight, totalSpend, appendEntry } from '../src/manifest/store.js';
import { recordLearnedCost } from '../src/budget/cost.js';
import { budgetSnapshot, recordCreditBaseline } from '../src/budget/guard.js';
import { emptyState, type ManifestEntry } from '../src/schemas/state.js';
import { HardStop } from '../src/util/errors.js';
import type { GenerationItem } from '../src/schemas/planning.js';

const SETTINGS = { width: 1920, height: 1080, fps: 30, colorspace: 'bt709', aspectRatio: '16:9' };
const PROJECT = 'gen-test';

const OPTS = {
  maxSingleCallUSD: 3,
  poll: { initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 2, timeoutMs: 5000, sleep: async () => {} },
};

let cwd: string;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'avp-gen-'));
  cwd = process.cwd();
  process.chdir(tmp);
  ensureProjectDirs(PROJECT);
  writeState(PROJECT, emptyState({
    projectName: PROJECT, idea: 'test', mode: 'full',
    maxBudgetUSD: 20, projectSettings: SETTINGS,
  }));
  // Seed a known price so tests exercise the guard rather than cost lookup.
  // The query must match generateShot's exactly - learned costs are keyed by
  // full configuration, so a missing aspectRatio is a different key.
  recordLearnedCost(
    PROJECT,
    { modelId: 'test/model', kind: 'video', durationSeconds: 5, aspectRatio: '16:9', settings: {} },
    10,
    0.63,
  );
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
});

const item = (over: Partial<GenerationItem> = {}): GenerationItem => ({
  shotId: 'shot_001',
  modelId: 'test/model',
  requiredSeconds: 4.2,
  billableSeconds: 5,
  prompt: 'a man digging',
  aspectRatio: '16:9',
  usesStartFrame: false,
  usesEndFrame: false,
  nativeAudio: false,
  settings: {},
  ...over,
});

/** Stub start/end frames, so image2video requirements can be satisfied. */
function makeFrame(name: string): string {
  const p = join(tmp, name);
  mkdirSync(join(tmp), { recursive: true });
  writeFileSync(p, `frame:${name}`);
  return p;
}

describe('generation sequence', () => {
  it('completes a shot and records it end to end', async () => {
    const provider = new FakeProvider({ stubMedia: true, latencyPolls: 1 });
    const r = await generateShot(PROJECT, item(), provider, OPTS);

    expect(r.reused).toBe(false);
    expect(existsSync(r.localFile)).toBe(true);

    const entry = readManifest(PROJECT).entries[0]!;
    expect(entry.status).toBe('completed');
    expect(entry.localFile).toBe(r.localFile);
    expect(readState(PROJECT).shots['shot_001']?.status).toBe('downloaded');
  });

  it('writes the manifest entry before submitting', async () => {
    // Section 23: a crash between submit and completion must leave a
    // recoverable record. Verified by observing the entry mid-flight.
    let manifestAtSubmit: ManifestEntry[] = [];
    const provider = new FakeProvider({ stubMedia: true, latencyPolls: 0 });
    const original = provider.submitVideo.bind(provider);
    provider.submitVideo = async (req) => {
      manifestAtSubmit = readManifest(PROJECT).entries;
      return original(req);
    };

    await generateShot(PROJECT, item(), provider, OPTS);

    expect(manifestAtSubmit).toHaveLength(1);
    expect(manifestAtSubmit[0]!.status).toBe('submitted');
  });

  it('settles the reservation into spend', async () => {
    const provider = new FakeProvider({ stubMedia: true });
    await generateShot(PROJECT, item(), provider, OPTS);

    const snap = budgetSnapshot(PROJECT);
    expect(snap.reservedUSD).toBe(0);
    expect(snap.spentUSD).toBeGreaterThan(0);
  });

  it('settles at the authorized amount when no credit figure is reported', async () => {
    // Regression: settlement once scaled the estimate by an
    // actual/estimated credit RATIO. An unpaid provider reporting 1 credit
    // against a 10-credit estimate settled at a tenth of the real cost, so
    // the budget permitted ~10x the intended spend before stopping.
    const provider = new FakeProvider({ stubMedia: true });
    await generateShot(PROJECT, item(), provider, OPTS);

    // Learned cost for this configuration is 10 credits / $0.63.
    expect(budgetSnapshot(PROJECT).spentUSD).toBeCloseTo(0.63, 2);
  });

  it('reuses a paid asset instead of paying twice', async () => {
    // Architecture section 22.
    const provider = new FakeProvider({ stubMedia: true });
    const first = await generateShot(PROJECT, item(), provider, OPTS);
    const spentAfterFirst = budgetSnapshot(PROJECT).spentUSD;

    const second = await generateShot(PROJECT, item(), provider, OPTS);

    expect(second.reused).toBe(true);
    expect(second.assetHash).toBe(first.assetHash);
    expect(second.usdCharged).toBe(0);
    expect(budgetSnapshot(PROJECT).spentUSD).toBe(spentAfterFirst);
    expect(readManifest(PROJECT).entries).toHaveLength(1);
  });

  it('treats a changed prompt as a different asset', async () => {
    const provider = new FakeProvider({ stubMedia: true });
    const a = await generateShot(PROJECT, item(), provider, OPTS);
    const b = await generateShot(
      PROJECT,
      item({ shotId: 'shot_002', prompt: 'a woman digging' }),
      provider,
      OPTS,
    );
    expect(b.assetHash).not.toBe(a.assetHash);
    expect(b.reused).toBe(false);
  });

  it('treats a changed start frame as a different asset', async () => {
    const provider = new FakeProvider({ stubMedia: true });
    const frameA = makeFrame('a.png');
    const frameB = makeFrame('b.png');
    writeFileSync(frameB, 'different content');

    const a = await generateShot(PROJECT, item(), provider, OPTS, { startImage: frameA });
    const b = await generateShot(
      PROJECT, item({ shotId: 'shot_002' }), provider, OPTS, { startImage: frameB },
    );
    expect(b.assetHash).not.toBe(a.assetHash);
  });
});

describe('failure handling', () => {
  it('does not charge for a failed generation', async () => {
    // Higgsfield refunds failures, so the reservation must be released.
    const provider = new FakeProvider({ stubMedia: true, failureRate: 1 });
    await expect(generateShot(PROJECT, item(), provider, OPTS)).rejects.toThrow();

    const snap = budgetSnapshot(PROJECT);
    expect(snap.spentUSD).toBe(0);
    expect(snap.reservedUSD).toBe(0);
  });

  it('excludes a failed entry from spend accounting', async () => {
    const provider = new FakeProvider({ stubMedia: true, failureRate: 1 });
    await expect(generateShot(PROJECT, item(), provider, OPTS)).rejects.toThrow();
    expect(totalSpend(PROJECT).usd).toBe(0);
  });

  it('records the failure against the shot', async () => {
    const provider = new FakeProvider({ stubMedia: true, failureRate: 1 });
    await expect(generateShot(PROJECT, item(), provider, OPTS)).rejects.toThrow();
    expect(readState(PROJECT).shots['shot_001']?.status).toBe('failed');
  });

  it('releases the reservation when submission itself throws', async () => {
    // dop models require a start image; submitting without one must not
    // leave budget reserved. This model is priced from the REST catalogue,
    // so cost resolution succeeds and the failure comes from submit.
    const provider = new FakeProvider({ stubMedia: true });
    await expect(
      generateShot(
        PROJECT,
        item({ modelId: 'higgsfield-ai/dop/turbo' }),
        provider,
        { ...OPTS, poll: { ...OPTS.poll } },
      ),
    ).rejects.toThrow(/requires a start image/);
    expect(budgetSnapshot(PROJECT).reservedUSD).toBe(0);
  });

  it('propagates HardStop rather than swallowing it', async () => {
    recordLearnedCost(
      PROJECT,
      { modelId: 'expensive/model', kind: 'video', durationSeconds: 5, aspectRatio: '16:9', settings: {} },
      200,
      12.5,
    );
    const provider = new FakeProvider({ stubMedia: true });
    await expect(
      generateShot(PROJECT, item({ modelId: 'expensive/model' }), provider, OPTS),
    ).rejects.toThrow(HardStop);
    // Nothing was submitted.
    expect(readManifest(PROJECT).entries).toHaveLength(0);
  });

  it('stops when the budget is exhausted', async () => {
    // At 2 USD per shot against a 20 USD ceiling, the 11th call must be
    // refused. Priced via a learned cost so no FFmpeg work is involved.
    recordLearnedCost(
      PROJECT,
      { modelId: 'priced/model', kind: 'video', durationSeconds: 5, aspectRatio: '16:9', settings: {} },
      32,
      2,
    );
    const provider = new FakeProvider({ stubMedia: true, latencyPolls: 0 });

    let completed = 0;
    let stopped = false;
    for (let i = 0; i < 15; i++) {
      try {
        await generateShot(
          PROJECT,
          item({
            shotId: `shot_${String(i + 1).padStart(3, '0')}`,
            modelId: 'priced/model',
            prompt: `distinct prompt ${i}`,
          }),
          provider,
          OPTS,
        );
        completed += 1;
      } catch (err) {
        if (err instanceof HardStop) {
          stopped = true;
          break;
        }
        throw err;
      }
    }

    expect(stopped).toBe(true);
    expect(completed).toBe(10);
    expect(budgetSnapshot(PROJECT).spentUSD).toBeLessThanOrEqual(20);
  }, 30_000);
});

describe('crash recovery', () => {
  it('finds jobs left mid-flight', async () => {
    const provider = new FakeProvider({ stubMedia: true, latencyPolls: 99 });
    // Timeout leaves the entry in 'polling' deliberately.
    await expect(
      generateShot(PROJECT, item(), provider, { ...OPTS, poll: { ...OPTS.poll, timeoutMs: 0 } }),
    ).rejects.toThrow();

    const inFlight = findInFlight(PROJECT);
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]!.jobId).toBeDefined();
  });

  it('recovers an in-flight job without resubmitting', async () => {
    const provider = new FakeProvider({ stubMedia: true, latencyPolls: 2 });
    await expect(
      generateShot(PROJECT, item(), provider, { ...OPTS, poll: { ...OPTS.poll, timeoutMs: 0 } }),
    ).rejects.toThrow();

    const before = provider.jobCount;
    const result = await recoverInFlight(PROJECT, findInFlight(PROJECT), provider, OPTS);

    expect(result.recovered).toBe(1);
    // No new job was created - the paid work was re-attached, not repeated.
    expect(provider.jobCount).toBe(before);
    expect(readManifest(PROJECT).entries[0]!.status).toBe('completed');
  });

  it('marks an entry failed when no job id was recorded', async () => {
    // The crash landed between the manifest write and the provider response.
    const entry: ManifestEntry = {
      assetHash: 'a'.repeat(16), shotId: 'shot_001', kind: 'video',
      provider: 'fake', model: 'test/model', prompt: 'x', settings: {},
      submittedAt: new Date().toISOString(),
      estimatedCredits: 10, estimatedUSD: 0.63,
      actualCredits: null, actualUSD: null, status: 'submitted', accepted: null,
    };
    appendEntry(PROJECT, entry);

    const provider = new FakeProvider({ stubMedia: true });
    const result = await recoverInFlight(PROJECT, [entry], provider, OPTS);

    expect(result.failed).toBe(1);
    expect(readManifest(PROJECT).entries[0]!.status).toBe('failed');
  });
});

describe('fake provider', () => {
  it('produces real playable media by default', async () => {
    const provider = new FakeProvider({ latencyPolls: 0 });
    const r = await generateShot(PROJECT, item(), provider, OPTS);

    // A real MP4, not a placeholder - so machine QA is genuinely exercised.
    const { statSync } = await import('node:fs');
    expect(statSync(r.localFile).size).toBeGreaterThan(1000);
  }, 30_000);

  it('fails deterministically for the same prompt', async () => {
    const a = new FakeProvider({ stubMedia: true, failureRate: 0.5 });
    const b = new FakeProvider({ stubMedia: true, failureRate: 0.5 });

    const first = await a.submitVideo({
      modelSlug: 'test/model', prompt: 'reproducible', durationSeconds: 5, aspectRatio: '16:9',
    });
    const second = await b.submitVideo({
      modelSlug: 'test/model', prompt: 'reproducible', durationSeconds: 5, aspectRatio: '16:9',
    });

    let ra = await a.poll(first.jobId);
    while (ra.status === 'running' || ra.status === 'queued') ra = await a.poll(first.jobId);
    let rb = await b.poll(second.jobId);
    while (rb.status === 'running' || rb.status === 'queued') rb = await b.poll(second.jobId);

    expect(ra.status).toBe(rb.status);
  });

  it('never charges for a failure', async () => {
    const provider = new FakeProvider({ stubMedia: true, failureRate: 1 });
    const s = await provider.submitVideo({
      modelSlug: 'test/model', prompt: 'x', durationSeconds: 5, aspectRatio: '16:9',
    });
    let r = await provider.poll(s.jobId);
    while (r.status === 'running' || r.status === 'queued') r = await provider.poll(s.jobId);
    expect(r.status).toBe('failed');
    expect(r.actualCredits).toBe(0);
  });

  it('reports itself as unpaid', () => {
    expect(new FakeProvider().isPaid).toBe(false);
  });
});
