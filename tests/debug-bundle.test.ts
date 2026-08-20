import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync,
  readdirSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDebugBundle } from '../src/reports/debug-bundle.js';
import { attachProjectLog, detachProjectLog, currentLogFile, log } from '../src/util/logger.js';
import { writeState } from '../src/state/store.js';
import { ensureProjectDirs, paths } from '../src/state/paths.js';
import { emptyState } from '../src/schemas/state.js';

const SETTINGS = { width: 1920, height: 1080, fps: 30, colorspace: 'bt709', aspectRatio: '16:9' };
const PROJECT = 'bundle-test';

let cwd: string;
let tmp: string;

/** Unzip into a directory and return it. */
function extract(zip: string, label: string): string {
  const out = join(tmp, `extract-${label}`);
  mkdirSync(out, { recursive: true });
  execFileSync('unzip', ['-q', zip, '-d', out], { stdio: 'ignore' });
  return out;
}

function readAll(dir: string): string {
  let text = '';
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) text += readAll(p);
    else if (/\.(json|txt|log|md)$/.test(entry)) text += readFileSync(p, 'utf8');
  }
  return text;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'avp-bundle-'));
  cwd = process.cwd();
  process.chdir(tmp);
  ensureProjectDirs(PROJECT);
  writeState(PROJECT, emptyState({
    projectName: PROJECT, idea: 'a man digging', mode: 'full',
    maxBudgetUSD: 20, projectSettings: SETTINGS,
  }));
});

afterEach(() => {
  detachProjectLog();
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe('file logging', () => {
  it('writes to the project log once attached', () => {
    attachProjectLog(paths(PROJECT).root);
    log.info('a thing happened', { shot: 'shot_001' });

    const file = currentLogFile()!;
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('a thing happened');
    expect(text).toContain('shot_001');
  });

  it('records debug lines even when the terminal level is higher', () => {
    // The file exists to answer questions nobody knew to ask when the run
    // started, so it always gets full detail.
    process.env['LOG_LEVEL'] = 'error';
    attachProjectLog(paths(PROJECT).root);
    log.debug('quiet detail');

    expect(readFileSync(currentLogFile()!, 'utf8')).toContain('quiet detail');
    delete process.env['LOG_LEVEL'];
  });

  it('appends rather than truncating, so a resumed run keeps its history', () => {
    attachProjectLog(paths(PROJECT).root);
    log.info('first session');
    detachProjectLog();

    attachProjectLog(paths(PROJECT).root);
    log.info('second session');

    const text = readFileSync(currentLogFile()!, 'utf8');
    expect(text).toContain('first session');
    expect(text).toContain('second session');
  });

  it('does not throw when the log cannot be written', () => {
    // A logging failure must never stop a paid run.
    attachProjectLog('/nonexistent/path/that/cannot/be/created');
    expect(() => log.info('still fine')).not.toThrow();
  });

  it('writes nothing when no project is attached', () => {
    detachProjectLog();
    expect(currentLogFile()).toBeNull();
    expect(() => log.info('goes only to stderr')).not.toThrow();
  });
});

describe('debug bundle', () => {
  it('refuses an unknown project', async () => {
    await expect(buildDebugBundle('no-such-project')).rejects.toThrow(/No such project/);
  });

  it('collects state and reports the pieces it could not find', async () => {
    const r = await buildDebugBundle(PROJECT, { outputPath: join(tmp, 'b.zip') });

    expect(existsSync(r.path)).toBe(true);
    expect(r.included).toContain('state.json');
    // A fresh project has no manifest or qa report yet; the bundle should
    // say so rather than silently omitting them.
    expect(r.warnings.join(' ')).toMatch(/missing/i);
  }, 120_000);

  it('includes the run log when one exists', async () => {
    attachProjectLog(paths(PROJECT).root);
    log.info('something diagnostic');

    const r = await buildDebugBundle(PROJECT, { outputPath: join(tmp, 'log.zip') });
    expect(r.included).toContain('run.log');
    expect(readAll(extract(r.path, 'log'))).toContain('something diagnostic');
  }, 120_000);

  it('includes an environment description', async () => {
    const r = await buildDebugBundle(PROJECT, { outputPath: join(tmp, 'env.zip') });
    const text = readAll(extract(r.path, 'env'));
    expect(text).toMatch(/node\s+\d+\./);
    expect(text).toMatch(/ffmpeg/);
  }, 120_000);
});

describe('secrets never leave the machine', () => {
  const SECRET = '5caa6743-e749-4642-9189-4fce37252a36';
  const HEX = 'abcdef0123456789abcdef0123456789abcdef01';

  it('redacts an api key from the log', async () => {
    attachProjectLog(paths(PROJECT).root);
    log.info(`HIGGSFIELD_API_SECRET=${SECRET}`);

    const r = await buildDebugBundle(PROJECT, { outputPath: join(tmp, 's1.zip') });
    const text = readAll(extract(r.path, 's1'));

    expect(text).not.toContain(SECRET);
    expect(text).toContain('REDACTED');
    expect(r.redactions).toBeGreaterThan(0);
  }, 120_000);

  it('redacts an authorization header', async () => {
    attachProjectLog(paths(PROJECT).root);
    log.info(`Authorization: Key ${SECRET}:${HEX}`);

    const text = readAll(extract(
      (await buildDebugBundle(PROJECT, { outputPath: join(tmp, 's2.zip') })).path, 's2',
    ));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(HEX);
  }, 120_000);

  it('leaves no fragment of a redacted value behind', async () => {
    // Regression: chaining patterns let a later one match inside an earlier
    // replacement, emitting stray digits of the secret.
    attachProjectLog(paths(PROJECT).root);
    log.info(`Authorization: Key ${SECRET}:${HEX}`);

    const text = readAll(extract(
      (await buildDebugBundle(PROJECT, { outputPath: join(tmp, 's3.zip') })).path, 's3',
    ));

    // No run of 8+ hex characters from the secret should survive anywhere.
    for (const chunk of [SECRET.slice(0, 8), SECRET.slice(-12), HEX.slice(0, 16)]) {
      expect(text).not.toContain(chunk);
    }
  }, 120_000);

  it('never includes a .env file', async () => {
    writeFileSync(join(tmp, '.env'), `HIGGSFIELD_API_KEY=${SECRET}\n`);

    const dir = extract(
      (await buildDebugBundle(PROJECT, { outputPath: join(tmp, 's4.zip') })).path, 's4',
    );
    expect(readdirSync(dir).filter((f) => f.includes('.env'))).toHaveLength(0);
  }, 120_000);

  it('keeps the last four characters so lines can still be correlated', async () => {
    attachProjectLog(paths(PROJECT).root);
    log.info(`token=${SECRET}`);

    const text = readAll(extract(
      (await buildDebugBundle(PROJECT, { outputPath: join(tmp, 's5.zip') })).path, 's5',
    ));
    expect(text).toContain(`REDACTED…${SECRET.slice(-4)}`);
  }, 120_000);
});
