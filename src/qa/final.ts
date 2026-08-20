/**
 * Final QA. Architecture section 29.
 *
 * REPORT ONLY. It never triggers paid regeneration - a human reads the
 * report and decides whether further spending is worthwhile.
 */

import { probe, frameLuminance, frameContrast } from '../ffmpeg/probe.js';
import { loadProjectDefaults, loadQualityPolicy } from '../config/loader.js';
import { conformsToProject } from '../ffmpeg/normalize.js';
import type { EditPlan } from '../schemas/planning.js';
import type { MediaInfo } from '../ffmpeg/probe.js';

export type FinalCheck = {
  name: string;
  status: 'pass' | 'warn' | 'fail' | 'info';
  detail: string;
};

export type FinalQaReport = {
  file: string;
  ranAt: string;
  reportOnly: true;
  checks: FinalCheck[];
  info: MediaInfo;
  motionRatio: number;
  summary: { pass: number; warn: number; fail: number };
};

export async function runFinalQa(
  finalPath: string,
  plan: EditPlan,
  opts: { expectedDurationSeconds?: number } = {},
): Promise<FinalQaReport> {
  const defaults = loadProjectDefaults();
  const policy = loadQualityPolicy();
  const checks: FinalCheck[] = [];

  const info = await probe(finalPath);

  // Runtime.
  const expected = opts.expectedDurationSeconds ?? plan.totalDurationSeconds;
  const drift = Math.abs(info.durationSeconds - expected);
  checks.push({
    name: 'runtime',
    status: drift <= expected * 0.02 ? 'pass' : 'warn',
    detail: `${info.durationSeconds.toFixed(1)}s (planned ${expected.toFixed(1)}s)`,
  });

  // Resolution, fps, pixel format.
  const conform = conformsToProject(info, defaults);
  checks.push({
    name: 'format',
    status: conform.ok ? 'pass' : 'fail',
    detail: conform.ok
      ? `${info.video?.width}x${info.video?.height} @${info.video?.fps.toFixed(0)}fps, ` +
        `${info.video?.pixelFormat}`
      : conform.problems.join('; '),
  });

  // Audio.
  checks.push({
    name: 'audio',
    status: info.audio ? 'pass' : 'fail',
    detail: info.audio
      ? `${info.audio.codec} ${info.audio.channels}ch @${info.audio.sampleRate}Hz`
      : 'no audio stream',
  });

  // Black frames across the whole render.
  const luma = await frameLuminance(finalPath, 1);
  if (luma.length === 0) {
    checks.push({ name: 'black-frames', status: 'warn', detail: 'could not sample' });
  } else {
    const dark = luma.filter((y) => y < policy.machineQa.blackFrameLumaThreshold).length;
    const ratio = dark / luma.length;
    checks.push({
      name: 'black-frames',
      status: ratio <= policy.machineQa.maxBlackFrameRatio ? 'pass' : 'warn',
      detail: `${(ratio * 100).toFixed(1)}% dark`,
    });
  }

  // Render corruption: a stretch of flat frames mid-render usually means
  // a clip failed to load rather than a deliberate blank.
  const contrast = await frameContrast(finalPath, 1);
  if (contrast.length > 0) {
    const flat = contrast.filter((c) => c < 0.02).length;
    checks.push({
      name: 'render-integrity',
      status: flat === 0 ? 'pass' : flat / contrast.length < 0.05 ? 'warn' : 'fail',
      detail: `${flat} of ${contrast.length} sampled frames are flat`,
    });
  }

  // Motion ratio of what was actually planned.
  const total = plan.items.reduce((s, i) => s + i.screenDurationSeconds, 0);
  const motion = plan.items.reduce((s, i) => s + (i.isStill ? 0 : i.motionSeconds), 0);
  const motionRatio = total > 0 ? motion / total : 0;
  checks.push({
    name: 'motion-ratio',
    status: motionRatio >= policy.motionRatio.minRealMotionRatio ? 'pass' : 'warn',
    detail: `${(motionRatio * 100).toFixed(0)}% real motion ` +
      `(floor ${(policy.motionRatio.minRealMotionRatio * 100).toFixed(0)}%)`,
  });

  // File size is informational - useful for spotting a truncated render.
  checks.push({
    name: 'file-size',
    status: 'info',
    detail: `${(info.sizeBytes / 1048576).toFixed(1)}MB ` +
      `(${((info.sizeBytes * 8) / info.durationSeconds / 1e6).toFixed(1)} Mbps)`,
  });

  return {
    file: finalPath,
    ranAt: new Date().toISOString(),
    reportOnly: true,
    checks,
    info,
    motionRatio,
    summary: {
      pass: checks.filter((c) => c.status === 'pass').length,
      warn: checks.filter((c) => c.status === 'warn').length,
      fail: checks.filter((c) => c.status === 'fail').length,
    },
  };
}

export function formatFinalQa(report: FinalQaReport): string {
  const icon = { pass: '✓', warn: '!', fail: '✗', info: '·' } as const;
  const lines = ['Final QA (report only - no regeneration triggered)', ''];
  for (const c of report.checks) {
    lines.push(`  ${icon[c.status]} ${c.name.padEnd(18)} ${c.detail}`);
  }
  lines.push(
    '',
    `  ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`,
  );
  return lines.join('\n');
}
