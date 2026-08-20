/**
 * Debug bundle. Everything needed to diagnose a run, in one file.
 *
 * A bug report of the form "shot 7 looks wrong" is unanswerable from the
 * video alone: it shows WHAT broke, never WHY. The prompt that produced it,
 * whether the character reference was attached, what QA said, which model was
 * chosen and at what price - all of that lives in files the reporter has and
 * would not think to send.
 *
 * The video itself is deliberately excluded. The real one is 147MB; sample
 * frames carry the diagnostic content at a fraction of the size.
 *
 * SECRETS ARE STRIPPED, not trusted to be absent. .env is never included, and
 * anything resembling a key in the collected files is redacted before it is
 * written. A debug bundle is something people email and paste into issues.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { paths } from '../state/paths.js';
import { loadEnv } from '../config/env.js';
import { log } from '../util/logger.js';

const exec = promisify(execFile);

export type BundleResult = {
  path: string;
  sizeBytes: number;
  included: string[];
  redactions: number;
  warnings: string[];
};

/**
 * Patterns that must never leave the machine.
 *
 * Deliberately broad: a false redaction costs a reader nothing, while a
 * leaked key costs the user their account.
 */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'api-key-assignment', re: /((?:api[_-]?key|secret|token|password)\s*[=:]\s*)(\S+)/gi },
  { name: 'authorization-header', re: /(Authorization["'\s:]+)(\S+)/gi },
  { name: 'uuid-key', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { name: 'long-hex', re: /\b[0-9a-f]{40,}\b/gi },
];

/**
 * Replace secrets with a stub that keeps the last four characters, so two
 * lines mentioning the same id can still be correlated without the value
 * being readable.
 *
 * Patterns are applied to the ORIGINAL text and the replacements collected,
 * rather than chained. Chaining let a later pattern match inside an earlier
 * replacement and emit fragments of the redacted value.
 */
function redact(text: string): { text: string; count: number } {
  type Span = { start: number; end: number; replacement: string };
  const spans: Span[] = [];

  for (const { re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const whole = m[0];
      const prefix = m[1] ?? '';
      const value = whole.slice(prefix.length);
      spans.push({
        start: start + prefix.length,
        end: start + whole.length,
        replacement: `[REDACTED…${value.slice(-4)}]`,
      });
    }
  }

  if (spans.length === 0) return { text, count: 0 };

  // Longest-first at each position, then drop anything overlapping an
  // already-accepted span.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  let cursor = -1;
  for (const s of spans) {
    if (s.start < cursor) continue;
    kept.push(s);
    cursor = s.end;
  }

  let out = '';
  let last = 0;
  for (const s of kept) {
    out += text.slice(last, s.start) + s.replacement;
    last = s.end;
  }
  out += text.slice(last);

  return { text: out, count: kept.length };
}

function copyRedacted(src: string, dest: string): number {
  const { text, count } = redact(readFileSync(src, 'utf8'));
  mkdirSync(join(dest, '..'), { recursive: true });
  writeFileSync(dest, text);
  return count;
}

/** Tail of a file, so a long run log does not dominate the bundle. */
function copyTail(src: string, dest: string, maxLines: number): number {
  const lines = readFileSync(src, 'utf8').split('\n');
  const kept = lines.length > maxLines
    ? [`... ${lines.length - maxLines} earlier lines omitted ...`, ...lines.slice(-maxLines)]
    : lines;
  const { text, count } = redact(kept.join('\n'));
  mkdirSync(join(dest, '..'), { recursive: true });
  writeFileSync(dest, text);
  return count;
}

export async function buildDebugBundle(
  project: string,
  opts: { outputPath?: string; framesPerShot?: number; maxShots?: number } = {},
): Promise<BundleResult> {
  const p = paths(project);
  if (!existsSync(p.root)) {
    throw new Error(`No such project: ${project}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputPath = opts.outputPath ?? join(process.cwd(), `debug-${project}-${stamp}.zip`);
  const staging = join(tmpdir(), `avp-bundle-${process.pid}-${Date.now()}`);
  mkdirSync(staging, { recursive: true });

  const included: string[] = [];
  const warnings: string[] = [];
  let redactions = 0;

  try {
    // 1. State and accounting. The core of any diagnosis: where the run
    //    stopped, what each shot cost, which were rejected and why.
    for (const [src, name] of [
      [p.state, 'state.json'],
      [p.manifest, 'manifest.json'],
      [p.qaReport, 'qa-report.json'],
      [p.cost, 'cost.md'],
      [p.costEstimate, 'cost-estimate.md'],
      [join(p.references, 'reference-check.json'), 'reference-check.json'],
    ] as const) {
      if (!existsSync(src)) {
        warnings.push(`missing: ${name}`);
        continue;
      }
      redactions += copyRedacted(src, join(staging, name));
      included.push(name);
    }

    // 2. The plan. These hold the exact prompts, which is usually where a
    //    "why does it look wrong" answer actually lives.
    if (existsSync(p.planning)) {
      for (const f of readdirSync(p.planning)) {
        if (!f.endsWith('.json')) continue;
        redactions += copyRedacted(join(p.planning, f), join(staging, 'planning', f));
        included.push(`planning/${f}`);
      }
    }

    // 3. The run log - what happened, in order.
    const runLog = join(p.logs, 'run.log');
    if (existsSync(runLog)) {
      redactions += copyTail(runLog, join(staging, 'run.log'), 5000);
      included.push('run.log');
    } else {
      warnings.push('no run.log - the run predates file logging, or logging failed');
    }

    // 4. Sample frames instead of video. A 147MB mp4 is impractical to
    //    attach to an issue; three frames per shot show the same defect.
    const framesPerShot = opts.framesPerShot ?? 2;
    const maxShots = opts.maxShots ?? 20;
    if (existsSync(p.shots)) {
      const shotDirs = readdirSync(p.shots).filter((d) => d.startsWith('shot_')).slice(0, maxShots);
      for (const shot of shotDirs) {
        const video = p.shotFile(shot, 'normalized.mp4');
        const source = existsSync(video) ? video : p.shotFile(shot, 'original.mp4');
        if (!existsSync(source)) continue;
        await extractFrames(source, join(staging, 'frames', shot), framesPerShot);
        included.push(`frames/${shot}/`);
      }
    }

    // 5. The final render, sampled the same way.
    if (existsSync(p.finalVideo)) {
      await extractFrames(p.finalVideo, join(staging, 'frames', 'final'), 4);
      included.push('frames/final/');
    }

    // 6. Environment, so a "works on my machine" difference is visible.
    writeFileSync(join(staging, 'environment.txt'), await describeEnvironment());
    included.push('environment.txt');

    writeFileSync(
      join(staging, 'README.txt'),
      bundleReadme(project, included, redactions, warnings),
    );

    // 7. Zip it. `zip` ships with macOS and most Linux images.
    await exec('zip', ['-q', '-r', outputPath, '.'], { cwd: staging, maxBuffer: 32 * 1024 * 1024 });

    const sizeBytes = statSync(outputPath).size;
    log.info(
      `Debug bundle: ${basename(outputPath)} ` +
        `(${(sizeBytes / 1048576).toFixed(1)}MB, ${included.length} items, ` +
        `${redactions} redaction(s))`,
    );

    return { path: outputPath, sizeBytes, included, redactions, warnings };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function extractFrames(video: string, outDir: string, count: number): Promise<void> {
  const env = loadEnv();
  mkdirSync(outDir, { recursive: true });
  try {
    const { stdout } = await exec(env.ffprobeBin, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video,
    ]);
    const duration = Number(stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) return;

    for (let i = 0; i < count; i++) {
      const t = ((i + 0.5) / count) * duration;
      await exec(env.ffmpegBin, [
        '-v', 'error', '-y', '-ss', t.toFixed(3), '-i', video,
        '-frames:v', '1', '-vf', 'scale=640:-1', '-q:v', '5',
        join(outDir, `${String(i + 1).padStart(2, '0')}.jpg`),
      ]);
    }
  } catch {
    // A shot we cannot sample is not worth failing the bundle over.
  }
}

async function describeEnvironment(): Promise<string> {
  const env = loadEnv();
  const lines = [
    `node        ${process.versions.node}`,
    `platform    ${process.platform} ${process.arch}`,
    `providerMode ${env.PROVIDER_MODE}`,
    `maxBudgetUSD ${env.MAX_BUDGET_USD}`,
    `maxSingleCallUSD ${env.MAX_SINGLE_CALL_USD}`,
    `hasCredentials ${env.hasHiggsfieldCredentials ? 'yes (value not included)' : 'no'}`,
  ];

  for (const [label, bin] of [['ffmpeg', env.ffmpegBin], ['ffprobe', env.ffprobeBin]] as const) {
    try {
      const { stdout } = await exec(bin, ['-version'], { maxBuffer: 1024 * 1024 });
      lines.push(`${label.padEnd(11)} ${stdout.split('\n')[0]}`);
    } catch {
      lines.push(`${label.padEnd(11)} NOT FOUND`);
    }
  }

  try {
    const { stdout } = await exec('npx', ['hyperframes', '--version'], { timeout: 30_000 });
    lines.push(`hyperframes ${stdout.trim().split('\n')[0]}`);
  } catch {
    lines.push('hyperframes not available');
  }

  return `${lines.join('\n')}\n`;
}

function bundleReadme(
  project: string,
  included: string[],
  redactions: number,
  warnings: string[],
): string {
  return [
    `Debug bundle - ${project}`,
    `Created ${new Date().toISOString()}`,
    '',
    'WHAT IS HERE',
    '',
    '  state.json            where the run stopped, per-shot status and',
    '                        failure classes',
    '  manifest.json         every paid generation: prompt, model, seed,',
    '                        cost, accepted or rejected',
    '  qa-report.json        every quality check and its verdict',
    '  reference-check.json  whether references were verified, and the',
    '                        drift-test result',
    '  planning/             the exact prompts used',
    '  run.log               what happened, in order',
    '  frames/               sample frames per shot, and from the final',
    '                        render',
    '  environment.txt       node, ffmpeg, provider mode, budget settings',
    '',
    'WHAT IS NOT HERE',
    '',
    '  The video files. The final render is typically over 100MB, which is',
    '  impractical to attach. The sampled frames show the same defect.',
    '',
    '  Your .env, API keys, or credentials. Nothing from .env is collected,',
    `  and ${redactions} value(s) matching a secret pattern were redacted from`,
    '  the files that are included.',
    '',
    ...(warnings.length > 0
      ? ['NOTES', '', ...warnings.map((w) => `  - ${w}`), '']
      : []),
    'HOW TO READ IT',
    '',
    '  Start with state.json to see which stage stopped and which shots',
    '  failed. Each failed shot carries a failureClass. Then find that shot',
    '  in manifest.json for the prompt that produced it, and in planning/',
    '  for how it was specified. run.log gives the order events happened in.',
    '',
    `${included.length} items included.`,
    '',
  ].join('\n');
}
