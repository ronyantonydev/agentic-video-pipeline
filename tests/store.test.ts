import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readState, writeState, updateState, advanceStage, addWarning, setShotStatus, stateExists,
} from '../src/state/store.js';
import {
  readManifest, appendEntry, updateEntry, findByHash, findReusable, findInFlight,
  totalSpentUSD, totalSpentCredits, computeAssetHash, totalSpend, assertFullyPriced,
} from '../src/manifest/store.js';
import { ensureProjectDirs, paths, isValidProjectName } from '../src/state/paths.js';
import { emptyState, type ManifestEntry } from '../src/schemas/state.js';
import { ValidationError, UnknownCostError } from '../src/util/errors.js';

const SETTINGS = { width: 1920, height: 1080, fps: 30, colorspace: 'bt709', aspectRatio: '16:9' };
const PROJECT = 'test-project';

let cwd: string;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'avp-store-'));
  cwd = process.cwd();
  process.chdir(tmp);
  ensureProjectDirs(PROJECT);
  writeState(PROJECT, emptyState({
    projectName: PROJECT, idea: 'a man builds an underground house',
    mode: 'full', maxBudgetUSD: 20, projectSettings: SETTINGS,
  }));
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
});

const entry = (over: Partial<ManifestEntry> = {}): ManifestEntry => ({
  assetHash: computeAssetHash({ kind: 'video', model: 'kling3_0', prompt: 'digging', duration: 5 }),
  shotId: 'shot_001',
  kind: 'video',
  provider: 'Kling',
  model: 'kling3_0',
  prompt: 'digging',
  settings: {},
  submittedAt: new Date().toISOString(),
  estimatedCredits: 45,
  estimatedUSD: 2.82,
  actualCredits: null,
  actualUSD: null,
  status: 'submitted',
  accepted: null,
  ...over,
});

describe('project paths', () => {
  it('creates the full skeleton', () => {
    const p = paths(PROJECT);
    for (const dir of [p.planning, p.references, p.shots, p.reports, p.output, p.logs]) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  it('validates project names', () => {
    expect(isValidProjectName('underground-house')).toBe(true);
    expect(isValidProjectName('a1')).toBe(true);
    expect(isValidProjectName('Bad-Name')).toBe(false);
    expect(isValidProjectName('../escape')).toBe(false);
    expect(isValidProjectName('-leading')).toBe(false);
    expect(isValidProjectName('')).toBe(false);
  });
});

describe('state store', () => {
  it('round-trips', () => {
    expect(stateExists(PROJECT)).toBe(true);
    expect(readState(PROJECT).idea).toBe('a man builds an underground house');
  });

  it('refuses to persist invalid state', () => {
    // Budget invariant is enforced on write, not merely on read.
    expect(() =>
      updateState(PROJECT, (s) => ({ ...s, budget: { ...s.budget, spentUSD: 999 } })),
    ).toThrow(ValidationError);

    // Original file remains valid and unchanged.
    expect(readState(PROJECT).budget.spentUSD).toBe(0);
  });

  it('rejects a corrupt state file rather than silently resetting', () => {
    writeFileSync(paths(PROJECT).state, '{ not json');
    expect(() => readState(PROJECT)).toThrow(ValidationError);
  });

  it('advances stages and records history', () => {
    advanceStage(PROJECT, 'story');
    advanceStage(PROJECT, 'music');
    const s = readState(PROJECT);
    expect(s.stage).toBe('music');
    expect(s.completedStages).toContain('init');
    expect(s.completedStages).toContain('story');
  });

  it('allows moving backwards without losing completed history', () => {
    advanceStage(PROJECT, 'storyboard');
    advanceStage(PROJECT, 'story');
    const s = readState(PROJECT);
    expect(s.stage).toBe('story');
    expect(s.completedStages).toContain('init');
  });

  it('deduplicates warnings', () => {
    addWarning(PROJECT, 'long continuity chain');
    addWarning(PROJECT, 'long continuity chain');
    expect(readState(PROJECT).warnings).toHaveLength(1);
  });

  it('tracks per-shot status and attempts', () => {
    setShotStatus(PROJECT, 'shot_001', 'submitted', { attempts: 1 });
    setShotStatus(PROJECT, 'shot_001', 'qa-flagged', { failureClass: 'prompt-issue' });
    const shot = readState(PROJECT).shots['shot_001'];
    expect(shot?.status).toBe('qa-flagged');
    expect(shot?.failureClass).toBe('prompt-issue');
  });

  it('updates the timestamp on write', async () => {
    const before = readState(PROJECT).updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    advanceStage(PROJECT, 'story');
    expect(readState(PROJECT).updatedAt).not.toBe(before);
  });
});

describe('manifest store', () => {
  it('starts empty', () => {
    expect(readManifest(PROJECT).entries).toHaveLength(0);
  });

  it('appends an entry', () => {
    appendEntry(PROJECT, entry());
    expect(readManifest(PROJECT).entries).toHaveLength(1);
  });

  it('refuses to append a duplicate asset hash', () => {
    // Paying twice for an identical asset is the exact failure section 22 forbids.
    appendEntry(PROJECT, entry());
    expect(() => appendEntry(PROJECT, entry())).toThrow(/already exists/i);
    expect(readManifest(PROJECT).entries).toHaveLength(1);
  });

  it('updates an entry by hash', () => {
    const e = entry();
    appendEntry(PROJECT, e);
    updateEntry(PROJECT, e.assetHash, { status: 'completed', actualCredits: 45, actualUSD: 2.82 });
    expect(findByHash(PROJECT, e.assetHash)?.status).toBe('completed');
    expect(findByHash(PROJECT, e.assetHash)?.actualCredits).toBe(45);
  });

  it('throws when updating an unknown hash', () => {
    expect(() => updateEntry(PROJECT, 'deadbeef', { status: 'completed' })).toThrow(ValidationError);
  });

  it('never loses an entry across updates', () => {
    const a = entry({ assetHash: 'aaaaaaaaaaaaaaaa' });
    const b = entry({ assetHash: 'bbbbbbbbbbbbbbbb', shotId: 'shot_002' });
    appendEntry(PROJECT, a);
    appendEntry(PROJECT, b);
    updateEntry(PROJECT, a.assetHash, { status: 'completed' });
    expect(readManifest(PROJECT).entries).toHaveLength(2);
  });

  it('finds in-flight jobs for crash recovery', () => {
    appendEntry(PROJECT, entry({ assetHash: 'a'.repeat(16), status: 'submitted' }));
    appendEntry(PROJECT, entry({ assetHash: 'b'.repeat(16), status: 'polling' }));
    appendEntry(PROJECT, entry({ assetHash: 'c'.repeat(16), status: 'completed' }));
    expect(findInFlight(PROJECT).map((e) => e.status).sort()).toEqual(['polling', 'submitted']);
  });

  it('only reuses a completed asset whose file actually exists', () => {
    const e = entry({ status: 'completed', localFile: join(tmp, 'missing.mp4') });
    appendEntry(PROJECT, e);
    // File is absent, so it must not be treated as reusable.
    expect(findReusable(PROJECT, e.assetHash)).toBeUndefined();

    writeFileSync(join(tmp, 'missing.mp4'), 'video');
    expect(findReusable(PROJECT, e.assetHash)).toBeDefined();
  });

  it('does not reuse a submitted-but-incomplete asset', () => {
    const e = entry({ status: 'submitted' });
    appendEntry(PROJECT, e);
    expect(findReusable(PROJECT, e.assetHash)).toBeUndefined();
  });
});

describe('manifest accounting', () => {
  it('prefers actual cost over estimate', () => {
    const e = entry({ estimatedUSD: 2.82, actualUSD: 3.10, status: 'completed' });
    appendEntry(PROJECT, e);
    expect(totalSpentUSD(PROJECT)).toBeCloseTo(3.10, 2);
  });

  it('falls back to the estimate while a job is in flight', () => {
    appendEntry(PROJECT, entry({ estimatedUSD: 2.82, actualUSD: null, status: 'polling' }));
    expect(totalSpentUSD(PROJECT)).toBeCloseTo(2.82, 2);
  });

  it('excludes failed and refunded work', () => {
    // Higgsfield does not charge for failed generations, so counting them
    // would block spending that is actually still available.
    appendEntry(PROJECT, entry({ assetHash: 'a'.repeat(16), estimatedUSD: 5, status: 'failed' }));
    appendEntry(PROJECT, entry({ assetHash: 'b'.repeat(16), estimatedUSD: 5, status: 'refunded' }));
    appendEntry(PROJECT, entry({ assetHash: 'c'.repeat(16), estimatedUSD: 5, status: 'cancelled' }));
    appendEntry(PROJECT, entry({ assetHash: 'd'.repeat(16), estimatedUSD: 5, status: 'completed' }));
    expect(totalSpentUSD(PROJECT)).toBe(5);
  });

  it('tracks credits alongside dollars', () => {
    appendEntry(PROJECT, entry({ assetHash: 'a'.repeat(16), estimatedCredits: 45, status: 'completed' }));
    appendEntry(PROJECT, entry({ assetHash: 'b'.repeat(16), estimatedCredits: 2, status: 'completed' }));
    expect(totalSpentCredits(PROJECT)).toBe(47);
  });

  it('never counts an unknown cost as zero', () => {
    // Silently treating unknown as $0 would understate spend and let a budget
    // check approve a call it should refuse.
    appendEntry(PROJECT, entry({
      assetHash: 'a'.repeat(16), estimatedUSD: 5, estimatedCredits: 80, status: 'completed',
    }));
    appendEntry(PROJECT, entry({
      assetHash: 'b'.repeat(16), estimatedUSD: null, estimatedCredits: null,
      actualUSD: null, actualCredits: null, status: 'completed',
    }));

    const totals = totalSpend(PROJECT);
    expect(totals.usd).toBe(5);
    expect(totals.unpricedEntries).toEqual(['b'.repeat(16)]);
  });

  it('refuses a budget decision while any chargeable entry is unpriced', () => {
    appendEntry(PROJECT, entry({
      assetHash: 'b'.repeat(16), estimatedUSD: null, estimatedCredits: null,
      actualUSD: null, actualCredits: null, status: 'polling',
    }));
    expect(() => assertFullyPriced(PROJECT)).toThrow(UnknownCostError);
  });

  it('ignores unpriced entries that were never charged', () => {
    appendEntry(PROJECT, entry({
      assetHash: 'b'.repeat(16), estimatedUSD: null, estimatedCredits: null,
      actualUSD: null, actualCredits: null, status: 'failed',
    }));
    expect(totalSpend(PROJECT).unpricedEntries).toHaveLength(0);
    expect(() => assertFullyPriced(PROJECT)).not.toThrow();
  });
});
