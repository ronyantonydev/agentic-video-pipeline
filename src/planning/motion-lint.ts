/**
 * Motion-ratio lint. Architecture section 18.
 *
 * Cost optimisation must not turn the video into a slideshow. Run twice:
 *   #1 after edit planning  - catches a plan that was never lively enough
 *   #2 after QA/fallbacks   - catches drift when failed shots became stills
 *
 * Lint #2 is the one that matters in practice: each individual fallback
 * looks reasonable, but three of them together produce a slideshow.
 */

import type { EditPlan, TimelineItem } from '../schemas/planning.js';
import type { QualityPolicy } from '../config/loader.js';

export type LintViolation = {
  rule: string;
  message: string;
  severity: 'error' | 'warning';
  shotIds?: string[];
};

export type MotionLintResult = {
  pass: boolean;
  motionRatio: number;
  totalDurationSeconds: number;
  motionSeconds: number;
  violations: LintViolation[];
  /** Which pass this was, for reporting. */
  phase: 1 | 2;
};

/**
 * A timeline item counts as real motion when it carries generated footage
 * that actually moves. A Ken Burns push on a still is not real motion - that
 * is precisely the substitution this lint exists to detect.
 */
function isRealMotion(item: TimelineItem): boolean {
  return !item.isStill && item.motionSeconds > 0;
}

export function lintMotionRatio(
  plan: EditPlan,
  policy: QualityPolicy,
  phase: 1 | 2 = 1,
): MotionLintResult {
  const rules = policy.motionRatio;
  const violations: LintViolation[] = [];

  const totalDurationSeconds = plan.items.reduce((sum, i) => sum + i.screenDurationSeconds, 0);
  const motionSeconds = plan.items.reduce(
    (sum, i) => sum + (isRealMotion(i) ? i.motionSeconds : 0),
    0,
  );
  const motionRatio = totalDurationSeconds > 0 ? motionSeconds / totalDurationSeconds : 0;

  // 1. Overall motion majority.
  if (motionRatio < rules.minRealMotionRatio) {
    violations.push({
      rule: 'min-motion-ratio',
      severity: 'error',
      message:
        `real motion is ${(motionRatio * 100).toFixed(1)}% of runtime, below the ` +
        `${(rules.minRealMotionRatio * 100).toFixed(0)}% minimum ` +
        `(${motionSeconds.toFixed(1)}s of ${totalDurationSeconds.toFixed(1)}s)`,
    });
  }

  // 2. No single still may linger.
  for (const item of plan.items) {
    if (!isRealMotion(item) && item.screenDurationSeconds > rules.maxStillDurationSeconds) {
      violations.push({
        rule: 'max-still-duration',
        severity: 'error',
        message:
          `${item.shotId} holds a still for ${item.screenDurationSeconds.toFixed(1)}s, ` +
          `over the ${rules.maxStillDurationSeconds}s limit`,
        shotIds: [item.shotId],
      });
    }
  }

  // 3. No long runs of consecutive stills.
  let run: TimelineItem[] = [];
  const flushRun = () => {
    if (run.length > rules.maxConsecutiveNonMotionShots) {
      violations.push({
        rule: 'max-consecutive-stills',
        severity: 'error',
        message:
          `${run.length} consecutive non-motion shots ` +
          `(${run.map((r) => r.shotId).join(', ')}), over the limit of ` +
          `${rules.maxConsecutiveNonMotionShots}`,
        shotIds: run.map((r) => r.shotId),
      });
    }
    run = [];
  };
  for (const item of plan.items) {
    if (isRealMotion(item)) flushRun();
    else run.push(item);
  }
  flushRun();

  // 4. Opening and closing carry the most weight.
  const first = plan.items[0];
  if (rules.openingMustBeMotion && first && !isRealMotion(first)) {
    violations.push({
      rule: 'opening-motion',
      severity: 'error',
      message: `opening shot ${first.shotId} is a still; the first shot must move`,
      shotIds: [first.shotId],
    });
  }

  const last = plan.items[plan.items.length - 1];
  if (rules.closingMustBeMotion && last && !isRealMotion(last)) {
    violations.push({
      rule: 'closing-motion',
      severity: 'error',
      message: `closing shot ${last.shotId} is a still; the final shot must move`,
      shotIds: [last.shotId],
    });
  }

  return {
    pass: violations.every((v) => v.severity !== 'error'),
    motionRatio,
    totalDurationSeconds,
    motionSeconds,
    violations,
    phase,
  };
}

/**
 * Apply fallback substitutions, then re-lint. Architecture section 18, lint #2.
 *
 * `fallbackShotIds` are shots whose video failed and became animated stills.
 */
export function lintAfterFallbacks(
  plan: EditPlan,
  fallbackShotIds: string[],
  policy: QualityPolicy,
): MotionLintResult {
  const fallbacks = new Set(fallbackShotIds);
  const degraded: EditPlan = {
    ...plan,
    items: plan.items.map((item) =>
      fallbacks.has(item.shotId) ? { ...item, isStill: true, motionSeconds: 0 } : item,
    ),
  };
  return lintMotionRatio(degraded, policy, 2);
}

export function formatLintResult(result: MotionLintResult): string {
  const lines = [
    `Motion lint #${result.phase}: ${result.pass ? 'PASS' : 'FAIL'}`,
    `  real motion ${(result.motionRatio * 100).toFixed(1)}% ` +
      `(${result.motionSeconds.toFixed(1)}s of ${result.totalDurationSeconds.toFixed(1)}s)`,
  ];
  for (const v of result.violations) {
    lines.push(`  ${v.severity === 'error' ? '✗' : '!'} [${v.rule}] ${v.message}`);
  }
  return lines.join('\n');
}
