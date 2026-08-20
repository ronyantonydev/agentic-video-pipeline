import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadEnv, resetEnvCache } from '../src/config/env.js';

const ORIGINAL = { ...process.env };

beforeEach(() => resetEnvCache());
afterEach(() => {
  process.env = { ...ORIGINAL };
  resetEnvCache();
});

describe('environment loading', () => {
  it('applies defaults when values are absent', () => {
    delete process.env['MAX_BUDGET_USD'];
    delete process.env['MAX_CONCURRENCY'];
    const env = loadEnv(true);
    expect(env.MAX_BUDGET_USD).toBe(20);
    expect(env.MAX_CONCURRENCY).toBe(3);
  });

  it('parses numeric strings', () => {
    process.env['MAX_BUDGET_USD'] = '45.5';
    expect(loadEnv(true).MAX_BUDGET_USD).toBe(45.5);
  });

  it('treats an empty string as absent rather than zero', () => {
    // An empty MAX_BUDGET_USD coerced to 0 would block every call - or worse,
    // read as "no budget configured" and be ignored.
    process.env['MAX_BUDGET_USD'] = '';
    expect(loadEnv(true).MAX_BUDGET_USD).toBe(20);
  });

  it('refuses a single-call ceiling larger than the whole budget', () => {
    process.env['MAX_BUDGET_USD'] = '10';
    process.env['MAX_SINGLE_CALL_USD'] = '25';
    expect(() => loadEnv(true)).toThrow(/exceeds/i);
  });

  it('rejects a negative budget', () => {
    process.env['MAX_BUDGET_USD'] = '-5';
    expect(() => loadEnv(true)).toThrow();
  });

  it('reads DRY_RUN as a boolean', () => {
    for (const truthy of ['true', '1', 'yes', 'on', 'TRUE']) {
      process.env['DRY_RUN'] = truthy;
      expect(loadEnv(true).DRY_RUN).toBe(true);
    }
    for (const falsy of ['false', '0', 'no', '']) {
      process.env['DRY_RUN'] = falsy;
      expect(loadEnv(true).DRY_RUN).toBe(false);
    }
  });

  it('falls back to PATH binaries when no explicit path is set', () => {
    process.env['FFMPEG_PATH'] = '';
    process.env['FFPROBE_PATH'] = '';
    const env = loadEnv(true);
    expect(env.ffmpegBin).toBe('ffmpeg');
    expect(env.ffprobeBin).toBe('ffprobe');
  });

  it('reports credentials as present only when both key and secret are set', () => {
    process.env['HIGGSFIELD_API_KEY'] = 'k';
    process.env['HIGGSFIELD_API_SECRET'] = '';
    expect(loadEnv(true).hasHiggsfieldCredentials).toBe(false);

    process.env['HIGGSFIELD_API_SECRET'] = 's';
    expect(loadEnv(true).hasHiggsfieldCredentials).toBe(true);
  });

  it('rejects a malformed API base URL', () => {
    process.env['HIGGSFIELD_API_BASE'] = 'not-a-url';
    expect(() => loadEnv(true)).toThrow();
  });
});
