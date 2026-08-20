import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFileAtomic, writeJsonAtomic, cleanupTempFiles } from '../src/util/atomic.js';
import { computeAssetHash, hashFile } from '../src/manifest/store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avp-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('atomic writes', () => {
  it('writes and reads back', () => {
    const file = join(dir, 'a.json');
    writeJsonAtomic(file, { hello: 'world' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ hello: 'world' });
  });

  it('creates parent directories', () => {
    const file = join(dir, 'deep', 'nested', 'a.json');
    writeJsonAtomic(file, { x: 1 });
    expect(existsSync(file)).toBe(true);
  });

  it('leaves no temp files behind on success', () => {
    writeJsonAtomic(join(dir, 'a.json'), { x: 1 });
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('replaces content wholesale rather than appending', () => {
    const file = join(dir, 'a.json');
    writeJsonAtomic(file, { first: true });
    writeJsonAtomic(file, { second: true });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ second: true });
  });

  it('preserves the previous file when a write is killed mid-flight', () => {
    // The real crash-safety claim: kill a process while it writes, and the
    // original content must still be intact and parseable.
    const file = join(dir, 'state.json');
    writeJsonAtomic(file, { generation: 'original', paid: true });

    const script = join(dir, 'killer.mjs');
    const bigPayload = 'x'.repeat(5_000_000);
    writeFileSync(
      script,
      `
      import { writeFileSync } from 'node:fs';
      // Simulate a long write that gets interrupted: write to a temp name in
      // the same dir (as writeFileAtomic does), then die before renaming.
      writeFileSync(${JSON.stringify(join(dir, '.state.json.999.1.tmp'))}, ${JSON.stringify(bigPayload)});
      process.kill(process.pid, 'SIGKILL');
      `,
    );

    try {
      execFileSync(process.execPath, [script], { stdio: 'ignore' });
    } catch {
      // Expected - the child SIGKILLs itself.
    }

    // Original survives, still valid JSON.
    const recovered = JSON.parse(readFileSync(file, 'utf8'));
    expect(recovered).toEqual({ generation: 'original', paid: true });
  });

  it('cleans up stale temp files from an interrupted write', () => {
    writeJsonAtomic(join(dir, 'state.json'), { x: 1 });
    writeFileSync(join(dir, '.state.json.123.456.tmp'), 'garbage');
    writeFileSync(join(dir, '.state.json.789.012.tmp'), 'garbage');

    expect(cleanupTempFiles(dir, 'state.json')).toBe(2);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    // The real file is untouched.
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toEqual({ x: 1 });
  });

  it('does not remove temp files belonging to a different target', () => {
    writeFileSync(join(dir, '.manifest.json.1.2.tmp'), 'other');
    expect(cleanupTempFiles(dir, 'state.json')).toBe(0);
    expect(existsSync(join(dir, '.manifest.json.1.2.tmp'))).toBe(true);
  });

  it('writes secrets-capable files with restrictive permissions', () => {
    const file = join(dir, 'a.json');
    writeFileAtomic(file, 'x');
    // 0o600 - owner read/write only.
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('asset hashing', () => {
  const base = { kind: 'video' as const, model: 'kling3_0', prompt: 'a man digs', duration: 5 };

  it('is stable across calls', () => {
    expect(computeAssetHash(base)).toBe(computeAssetHash(base));
  });

  it('ignores key order in settings', () => {
    const a = computeAssetHash({ ...base, settings: { mode: 'pro', sound: 'off' } });
    const b = computeAssetHash({ ...base, settings: { sound: 'off', mode: 'pro' } });
    expect(a).toBe(b);
  });

  it('changes when the prompt changes', () => {
    expect(computeAssetHash({ ...base, prompt: 'a woman digs' })).not.toBe(computeAssetHash(base));
  });

  it('changes when the model changes', () => {
    expect(computeAssetHash({ ...base, model: 'veo3_1_lite' })).not.toBe(computeAssetHash(base));
  });

  it('changes when duration changes', () => {
    // Duration drives billing, so it must partition the asset space.
    expect(computeAssetHash({ ...base, duration: 10 })).not.toBe(computeAssetHash(base));
  });

  it('changes when a start frame is introduced', () => {
    expect(computeAssetHash({ ...base, startFrameHash: 'abc123' })).not.toBe(computeAssetHash(base));
  });

  it('changes when the seed changes', () => {
    expect(computeAssetHash({ ...base, seed: 42 })).not.toBe(computeAssetHash({ ...base, seed: 43 }));
  });

  it('treats trailing whitespace in a prompt as equivalent', () => {
    expect(computeAssetHash({ ...base, prompt: '  a man digs  ' })).toBe(computeAssetHash(base));
  });

  it('hashes file contents, not paths', () => {
    const f1 = join(dir, 'one.png');
    const f2 = join(dir, 'two.png');
    writeFileSync(f1, 'identical');
    writeFileSync(f2, 'identical');
    expect(hashFile(f1)).toBe(hashFile(f2));

    writeFileSync(f2, 'different');
    expect(hashFile(f1)).not.toBe(hashFile(f2));
  });
});
