/**
 * Preflight check. Verifies everything the pipeline depends on before a
 * run starts, so failures surface here rather than mid-generation.
 */

import { execFileSync } from 'node:child_process';
import { loadEnv, envFileExists } from '../config/env.js';
import { loadModels, loadProjectDefaults, loadQualityPolicy } from '../config/loader.js';

type Check = { name: string; ok: boolean; detail: string; fatal: boolean };

function check(name: string, fatal: boolean, fn: () => string): Check {
  try {
    return { name, ok: true, detail: fn(), fatal };
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message, fatal };
  }
}

function binaryVersion(bin: string): string {
  const out = execFileSync(bin, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return out.split('\n')[0]?.slice(0, 60) ?? 'unknown';
}

export function runDoctor(): number {
  const checks: Check[] = [];

  checks.push(
    check('Node version', true, () => {
      const major = Number(process.versions.node.split('.')[0]);
      if (major < 22) throw new Error(`Node ${process.versions.node} - need >= 22`);
      return `v${process.versions.node}`;
    }),
  );

  checks.push(
    check('.env file', false, () => {
      if (!envFileExists()) throw new Error('missing - copy .env.sample to .env');
      return 'present';
    }),
  );

  const env = check('Environment variables', true, () => {
    const e = loadEnv(true);
    return `budget $${e.MAX_BUDGET_USD}, max/call $${e.MAX_SINGLE_CALL_USD}, concurrency ${e.MAX_CONCURRENCY}`;
  });
  checks.push(env);

  checks.push(
    check('Provider mode', true, () => {
      const mode = loadEnv().PROVIDER_MODE;
      const detail = {
        rest: 'rest - Node pays, budget enforced in code (dop/soul models)',
        mcp: 'mcp - Claude pays, budget check is advisory (premium models)',
        fake: 'fake - nothing pays, synthesised media',
      }[mode];
      return detail;
    }),
  );

  checks.push(
    check('Higgsfield credentials', false, () => {
      const e = loadEnv();
      if (e.PROVIDER_MODE !== 'rest') return 'not required in this mode';
      if (!e.hasHiggsfieldCredentials) {
        throw new Error('key/secret not set - planning works, generation will not');
      }
      return `key ...${e.HIGGSFIELD_API_KEY.slice(-6)}`;
    }),
  );

  checks.push(
    check('config/models.json', true, () => {
      const m = loadModels(true);
      const priced = [...m.video, ...m.image].filter((x) => x.costCredits !== null).length;
      const total = m.video.length + m.image.length;
      return `${m.video.length} video, ${m.image.length} image (${priced}/${total} priced)`;
    }),
  );

  checks.push(
    check('config/project-defaults.json', true, () => {
      const d = loadProjectDefaults(true);
      return `${d.video.width}x${d.video.height} @ ${d.video.fps}fps`;
    }),
  );

  checks.push(
    check('config/quality-policy.json', true, () => {
      const q = loadQualityPolicy(true);
      return `min motion ratio ${q.motionRatio.minRealMotionRatio}`;
    }),
  );

  checks.push(
    check('ffmpeg', true, () => binaryVersion(loadEnv().ffmpegBin)),
  );

  checks.push(
    check('ffprobe', true, () => binaryVersion(loadEnv().ffprobeBin)),
  );

  // Report
  const pad = Math.max(...checks.map((c) => c.name.length));
  process.stdout.write('\n');
  for (const c of checks) {
    const icon = c.ok ? '✓' : c.fatal ? '✗' : '!';
    process.stdout.write(`  ${icon}  ${c.name.padEnd(pad)}  ${c.detail}\n`);
  }

  const fatalFailures = checks.filter((c) => !c.ok && c.fatal);
  const warnings = checks.filter((c) => !c.ok && !c.fatal);

  process.stdout.write('\n');
  if (fatalFailures.length > 0) {
    process.stdout.write(`  ${fatalFailures.length} blocking problem(s). Fix before running.\n\n`);
    return 1;
  }
  if (warnings.length > 0) {
    process.stdout.write(`  Ready, with ${warnings.length} warning(s).\n\n`);
    return 0;
  }
  process.stdout.write('  All checks passed.\n\n');
  return 0;
}
