import { describe, it, expect } from 'vitest';
import { runParallel, runChain, runExecutionPlan, summarize } from '../src/orchestrator/scheduler.js';
import { pollUntilSettled, PollTimeout, isTerminal, isChargeableOutcome } from '../src/orchestrator/poller.js';
import type { GenerationProvider, PollResult } from '../src/higgsfield/provider.js';

const noSleep = async () => {};
const POLL = {
  initialDelayMs: 10, maxDelayMs: 100, backoffFactor: 2,
  timeoutMs: 10_000, sleep: noSleep,
};

describe('parallel scheduling', () => {
  it('respects the concurrency cap', async () => {
    let active = 0;
    let peak = 0;
    const ids = Array.from({ length: 12 }, (_, i) => `shot_${i}`);

    await runParallel(
      ids,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return 'ok';
      },
      { maxConcurrency: 3 },
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('processes every shot', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `shot_${i}`);
    const results = await runParallel(ids, async (id) => id, { maxConcurrency: 3 });
    expect(results).toHaveLength(7);
    expect(summarize(results).fulfilled).toBe(7);
  });

  it('returns results in input order despite out-of-order completion', async () => {
    const ids = ['a', 'b', 'c', 'd'];
    const results = await runParallel(
      ids,
      async (id) => {
        await new Promise((r) => setTimeout(r, id === 'a' ? 20 : 1));
        return id;
      },
      { maxConcurrency: 4 },
    );
    expect(results.map((r) => r.shotId)).toEqual(ids);
  });

  it('does not abandon the batch when one shot fails', async () => {
    // Other shots may already be paid for; discarding them would waste money.
    const results = await runParallel(
      ['a', 'b', 'c'],
      async (id) => {
        if (id === 'b') throw new Error('boom');
        return id;
      },
      { maxConcurrency: 2 },
    );
    const s = summarize(results);
    expect(s.fulfilled).toBe(2);
    expect(s.rejected).toBe(1);
  });

  it('skips remaining work once aborted', async () => {
    const signal = { aborted: false };
    const results = await runParallel(
      Array.from({ length: 10 }, (_, i) => `s${i}`),
      async (id) => {
        if (id === 's2') signal.aborted = true;
        return id;
      },
      { maxConcurrency: 1, signal },
    );
    expect(summarize(results).skipped).toBeGreaterThan(0);
  });

  it('handles an empty batch', async () => {
    expect(await runParallel([], async () => 'x', { maxConcurrency: 3 })).toEqual([]);
  });
});

describe('chain scheduling', () => {
  it('runs strictly in order, passing the previous result forward', async () => {
    const seen: string[] = [];
    await runChain(
      ['shot_001', 'shot_002', 'shot_003'],
      async (id, prev) => {
        seen.push(`${id}<-${prev ?? 'none'}`);
        return id;
      },
      { maxConcurrency: 4 },
    );
    expect(seen).toEqual(['shot_001<-none', 'shot_002<-shot_001', 'shot_003<-shot_002']);
  });

  it('stops the chain at the first failure', async () => {
    // Architecture section 13: a bad shot_04 must never cause paid
    // generation of shot_05, whose start frame would not exist.
    const attempted: string[] = [];
    const results = await runChain(
      ['shot_001', 'shot_002', 'shot_003', 'shot_004'],
      async (id) => {
        attempted.push(id);
        if (id === 'shot_002') throw new Error('QA failed');
        return id;
      },
      { maxConcurrency: 4 },
    );

    expect(attempted).toEqual(['shot_001', 'shot_002']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'skipped', 'skipped']);
  });

  it('explains why a downstream shot was skipped', async () => {
    const results = await runChain(
      ['shot_001', 'shot_002'],
      async (id) => {
        if (id === 'shot_001') throw new Error('bad');
        return id;
      },
      { maxConcurrency: 1 },
    );
    const skipped = results.find((r) => r.status === 'skipped');
    expect(skipped && 'reason' in skipped ? skipped.reason : '').toMatch(/shot_001/);
  });
});

describe('execution plan', () => {
  it('runs the parallel batch before any chain', async () => {
    const order: string[] = [];
    await runExecutionPlan(
      { parallelBatch: ['p1', 'p2'], serialChains: [['c1', 'c2']] },
      {
        parallel: async (id) => { order.push(`par:${id}`); return id; },
        chained: async (id) => { order.push(`chain:${id}`); return id; },
      },
      { maxConcurrency: 2 },
    );
    const firstChain = order.findIndex((o) => o.startsWith('chain:'));
    const lastPar = order.map((o) => o.startsWith('par:')).lastIndexOf(true);
    expect(lastPar).toBeLessThan(firstChain);
  });

  it('handles a plan with no chains', async () => {
    const results = await runExecutionPlan(
      { parallelBatch: ['a', 'b'], serialChains: [] },
      { parallel: async (id) => id, chained: async (id) => id },
      { maxConcurrency: 2 },
    );
    expect(summarize(results).fulfilled).toBe(2);
  });
});

/* --------------------------------------------------------------- polling */

function stubProvider(sequence: PollResult['status'][]): GenerationProvider {
  let i = 0;
  return {
    name: 'stub',
    isPaid: false,
    submitVideo: async () => ({ jobId: 'j1', status: 'queued', submittedAt: '' }),
    submitImage: async () => ({ jobId: 'j1', status: 'queued', submittedAt: '' }),
    submitAudio: async () => ({ jobId: 'j1', status: 'queued', submittedAt: '' }),
    poll: async (jobId) => {
      const status = sequence[Math.min(i, sequence.length - 1)]!;
      i += 1;
      return status === 'completed'
        ? { jobId, status, resultUrl: 'file:///tmp/x.mp4', actualCredits: 5 }
        : { jobId, status };
    },
    download: async () => {},
  };
}

describe('polling', () => {
  it('returns once the job completes', async () => {
    const r = await pollUntilSettled(stubProvider(['queued', 'running', 'completed']), 'j1', POLL);
    expect(r.status).toBe('completed');
    expect(r.resultUrl).toBeDefined();
  });

  it('returns a failure without throwing', async () => {
    const r = await pollUntilSettled(stubProvider(['running', 'failed']), 'j1', POLL);
    expect(r.status).toBe('failed');
  });

  it('backs off exponentially, capped at maxDelayMs', async () => {
    const delays: number[] = [];
    await pollUntilSettled(
      stubProvider(['running', 'running', 'running', 'running', 'completed']),
      'j1',
      { ...POLL, initialDelayMs: 10, maxDelayMs: 40, backoffFactor: 2,
        sleep: async (ms) => { delays.push(ms); } },
    );
    expect(delays).toEqual([10, 20, 40, 40]);
  });

  it('times out rather than polling forever', async () => {
    await expect(
      pollUntilSettled(stubProvider(['running']), 'j1', { ...POLL, timeoutMs: 0 }),
    ).rejects.toThrow(PollTimeout);
  });

  it('keeps the job recoverable in the timeout message', async () => {
    try {
      await pollUntilSettled(stubProvider(['running']), 'j1', { ...POLL, timeoutMs: 0 });
      expect.unreachable();
    } catch (err) {
      // The job may still be running and already paid for.
      expect((err as Error).message).toMatch(/recoverable/i);
    }
  });

  it('classifies terminal states', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('nsfw')).toBe(true);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('queued')).toBe(false);
  });

  it('treats only completion as chargeable', () => {
    // Higgsfield does not charge for failed or nsfw generations.
    expect(isChargeableOutcome('completed')).toBe(true);
    expect(isChargeableOutcome('failed')).toBe(false);
    expect(isChargeableOutcome('nsfw')).toBe(false);
    expect(isChargeableOutcome('cancelled')).toBe(false);
  });
});
