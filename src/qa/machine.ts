/**
 * Tier 1 machine QA. Architecture section 15.
 *
 * Free, deterministic, and run BEFORE any expensive intelligence or paid
 * retry. Catches the failures that need no judgement: corrupt files, wrong
 * duration, black frames, frozen video, missing audio.
 *
 * A check that cannot run reports `unknown` rather than `pass`. Silently
 * passing an uninspectable file would defeat the point.
 */

import { probe, frameLuminance, frameContrast, frameDifferences, ProbeError, type MediaInfo } from '../ffmpeg/probe.js';
import { conformsToProject } from '../ffmpeg/normalize.js';
import { loadProjectDefaults, loadQualityPolicy, type QualityPolicy } from '../config/loader.js';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'unknown';

export type Check = {
  name: string;
  status: CheckStatus;
  detail: string;
};

export type MachineQaResult = {
  shotId: string;
  file: string;
  pass: boolean;
  checks: Check[];
  info: MediaInfo | null;
};

export async function runMachineQa(
  shotId: string,
  file: string,
  opts: {
    expectedDurationSeconds?: number;
    expectAudio?: boolean;
    policy?: QualityPolicy;
  } = {},
): Promise<MachineQaResult> {
  const policy = opts.policy ?? loadQualityPolicy();
  const rules = policy.machineQa;
  const checks: Check[] = [];

  // 1. Readable at all. Everything else depends on this.
  let info: MediaInfo;
  try {
    info = await probe(file);
    checks.push({ name: 'readable', status: 'pass', detail: `${(info.sizeBytes / 1048576).toFixed(1)}MB` });
  } catch (err) {
    return {
      shotId,
      file,
      pass: false,
      info: null,
      checks: [
        {
          name: 'readable',
          status: 'fail',
          detail: err instanceof ProbeError ? err.message : String(err),
        },
      ],
    };
  }

  // 2. Has a video stream with real dimensions.
  if (!info.video || info.video.width === 0 || info.video.height === 0) {
    checks.push({ name: 'video-stream', status: 'fail', detail: 'no usable video stream' });
    return { shotId, file, pass: false, info, checks };
  }
  checks.push({
    name: 'video-stream',
    status: 'pass',
    detail: `${info.video.codec} ${info.video.width}x${info.video.height} @${info.video.fps.toFixed(2)}fps`,
  });

  // 3. Duration within tolerance of what the plan asked for.
  if (opts.expectedDurationSeconds !== undefined) {
    const expected = opts.expectedDurationSeconds;
    const drift = Math.abs(info.durationSeconds - expected);
    const allowed = (expected * rules.durationTolerancePercent) / 100;
    checks.push({
      name: 'duration',
      status: drift <= allowed ? 'pass' : 'fail',
      detail: `${info.durationSeconds.toFixed(2)}s vs expected ${expected}s (±${allowed.toFixed(2)}s)`,
    });
  }

  // 4. Conforms to the locked project format.
  const conform = conformsToProject(info, loadProjectDefaults());
  checks.push({
    name: 'project-format',
    status: conform.ok ? 'pass' : 'fail',
    detail: conform.ok ? 'matches locked settings' : conform.problems.join('; '),
  });

  // 5. Audio presence, when the shot is meant to carry it.
  if (opts.expectAudio !== undefined && rules.requireAudioWhenExpected) {
    const has = info.audio !== null;
    checks.push({
      name: 'audio',
      status: has === opts.expectAudio ? 'pass' : opts.expectAudio ? 'fail' : 'warn',
      detail: has ? `${info.audio!.codec} ${info.audio!.channels}ch` : 'silent',
    });
  }

  // 6. Black frames. A mostly-black clip is a failed generation.
  const luma = await frameLuminance(file);
  if (luma.length === 0) {
    checks.push({ name: 'black-frames', status: 'unknown', detail: 'could not sample luminance' });
  } else {
    const dark = luma.filter((y) => y < rules.blackFrameLumaThreshold).length;
    const ratio = dark / luma.length;
    checks.push({
      name: 'black-frames',
      status: ratio <= rules.maxBlackFrameRatio ? 'pass' : 'fail',
      detail: `${(ratio * 100).toFixed(1)}% dark frames (limit ${(rules.maxBlackFrameRatio * 100).toFixed(0)}%)`,
    });

    // 7. A uniform image is a blank render, not a shot.
    //
    // Contrast must be measured WITHIN a frame. An earlier version compared
    // average luminance BETWEEN frames, which is near-zero for any correctly
    // exposed shot under constant light - it flagged eight good clips blank.
    //
    // Known limitation: letterbox bars added during normalisation are
    // themselves high contrast against the picture, so a blank clip that was
    // padded can still read as having content. Run this check on the
    // ORIGINAL download where possible; on a padded file it can only catch a
    // clip that is blank edge to edge.
    const contrast = await frameContrast(file, 2);
    if (contrast.length === 0) {
      checks.push({ name: 'not-blank', status: 'unknown', detail: 'could not sample contrast' });
    } else {
      const median = [...contrast].sort((a, b) => a - b)[Math.floor(contrast.length / 2)]!;
      checks.push({
        name: 'not-blank',
        status: median > 0.05 ? 'pass' : 'fail',
        detail: `median in-frame contrast ${median.toFixed(3)}`,
      });
    }
  }

  // 8. Frozen video: a run of near-identical frames.
  const diffs = await frameDifferences(file);
  if (diffs.length === 0) {
    checks.push({ name: 'not-frozen', status: 'unknown', detail: 'could not sample motion' });
  } else {
    const SAMPLE_FPS = 2;
    const maxRunFrames = Math.ceil(rules.maxFrozenRunSeconds * SAMPLE_FPS);
    let run = 0;
    let longestRun = 0;
    for (const d of diffs) {
      // tblend difference is near zero when consecutive frames match.
      if (d < 1 - rules.frozenFrameSimilarityThreshold) {
        run += 1;
        longestRun = Math.max(longestRun, run);
      } else {
        run = 0;
      }
    }
    checks.push({
      name: 'not-frozen',
      status: longestRun <= maxRunFrames ? 'pass' : 'fail',
      detail: `longest still run ${(longestRun / SAMPLE_FPS).toFixed(1)}s (limit ${rules.maxFrozenRunSeconds}s)`,
    });
  }

  return {
    shotId,
    file,
    pass: checks.every((c) => c.status === 'pass' || c.status === 'warn'),
    checks,
    info,
  };
}

export function formatQaResult(result: MachineQaResult): string {
  const icon = { pass: '✓', fail: '✗', warn: '!', unknown: '?' } as const;
  const lines = [`${result.pass ? '✓' : '✗'} ${result.shotId}`];
  for (const c of result.checks) {
    lines.push(`    ${icon[c.status]} ${c.name.padEnd(16)} ${c.detail}`);
  }
  return lines.join('\n');
}

export function summarizeQa(results: MachineQaResult[]): {
  passed: number;
  failed: number;
  unknown: number;
  failedShots: string[];
} {
  const failedShots = results.filter((r) => !r.pass).map((r) => r.shotId);
  return {
    passed: results.filter((r) => r.pass).length,
    failed: failedShots.length,
    unknown: results.filter((r) => r.checks.some((c) => c.status === 'unknown')).length,
    failedShots,
  };
}
