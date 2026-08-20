/**
 * Anchor validation. Check the images BEFORE paying for the video.
 *
 * A video model given a start frame and an end frame fills in the middle.
 * If either anchor is wrong - wrong face, wrong wardrobe, wrong environment -
 * the clip is wrong, and no amount of prompt work fixes it afterwards.
 *
 * The economics make this worth doing:
 *
 *   Soul 2 image      0.12 credits
 *   Seedance 8s clip 20.00 credits      ~167x
 *
 * Regenerating a bad anchor five times still costs 3% of one clip.
 *
 * WHAT THIS CAN AND CANNOT CATCH. The technical checks - missing, corrupt,
 * blank, too small - are reliable and BLOCK generation. The composition
 * check is a smoke signal only: a perceptual hash compares light and dark
 * structure, not identity, and measurement on this project's real assets
 * showed an empty landscape scoring HIGHER against the character master
 * than a correct close-up did. It therefore warns and never blocks.
 *
 * Judging "is this the right person" needs vision QA or a human. Do not
 * mistake a passing composition score for a verified anchor.
 *
 * Retries are CAPPED. Three failures in a row means the prompt is wrong, not
 * the generation, and looping would burn credits on a request that cannot
 * succeed.
 */

import { existsSync } from 'node:fs';
import { compareToMaster, type DriftResult } from './identity.js';
import { probe } from '../ffmpeg/probe.js';
import { frameContrast } from '../ffmpeg/probe.js';
import { log } from '../util/logger.js';

export type AnchorCheck = {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'unknown';
  detail: string;
};

export type AnchorValidation = {
  path: string;
  pass: boolean;
  checks: AnchorCheck[];
  /** Similarity to the character master, when one applies. */
  identitySimilarity: number | null;
};

export type AnchorOptions = {
  /** The character master. Omit for shots with no person in them. */
  masterPath?: string;
  identityThreshold?: number;
  minWidth?: number;
  minContrast?: number;
};

/**
 * Validate one anchor image.
 *
 * Deliberately cheap and local - no model call. Everything here is a
 * property of the file itself.
 */
export async function validateAnchor(
  imagePath: string,
  opts: AnchorOptions = {},
): Promise<AnchorValidation> {
  const checks: AnchorCheck[] = [];
  let identitySimilarity: number | null = null;

  // 1. Exists and decodes.
  if (!existsSync(imagePath)) {
    return {
      path: imagePath,
      pass: false,
      identitySimilarity: null,
      checks: [{ name: 'exists', status: 'fail', detail: 'file not found' }],
    };
  }

  let info;
  try {
    info = await probe(imagePath);
    checks.push({
      name: 'readable',
      status: 'pass',
      detail: `${info.video?.width}x${info.video?.height}, ${(info.sizeBytes / 1024).toFixed(0)}KB`,
    });
  } catch (err) {
    return {
      path: imagePath,
      pass: false,
      identitySimilarity: null,
      checks: [{ name: 'readable', status: 'fail', detail: (err as Error).message.slice(0, 120) }],
    };
  }

  // 2. Large enough to be a useful anchor. A thumbnail-sized frame gives the
  //    video model very little to work from.
  const minWidth = opts.minWidth ?? 512;
  const width = info.video?.width ?? 0;
  checks.push({
    name: 'resolution',
    status: width >= minWidth ? 'pass' : 'fail',
    detail: `${width}px wide (minimum ${minWidth})`,
  });

  // 3. Not blank. A flat or near-flat image means the generation failed
  //    even though a file was produced.
  const minContrast = opts.minContrast ?? 0.05;
  const contrast = await frameContrast(imagePath);
  if (contrast.length === 0) {
    checks.push({ name: 'not-blank', status: 'unknown', detail: 'could not sample contrast' });
  } else {
    const value = contrast[0]!;
    checks.push({
      name: 'not-blank',
      status: value > minContrast ? 'pass' : 'fail',
      detail: `in-frame contrast ${value.toFixed(3)}`,
    });
  }

  // 4. Composition similarity to the character master.
  //
  //    IMPORTANT LIMITATION, measured rather than assumed: a perceptual hash
  //    compares overall light and dark structure, NOT who is in the frame.
  //    Tested against this project's real assets, an empty landscape scored
  //    80% against the character master while a correct close-up of the man
  //    digging scored 47% - the landscape simply shares more compositional
  //    structure with a full-body portrait than a tight close-up does.
  //
  //    So this cannot answer "is this the right person". It reliably answers
  //    "is this image wildly unlike the reference", which catches a
  //    catastrophically wrong anchor, and it is reported as a WARN so a
  //    legitimate close-up is never blocked.
  //
  //    Judging identity properly needs vision QA (tier 2) or a human. The
  //    hash is free and local; treating its output as more than a smoke
  //    signal would make it worse than useless.
  if (opts.masterPath && existsSync(opts.masterPath)) {
    try {
      const result: DriftResult = await compareToMaster(
        imagePath,
        opts.masterPath,
        opts.identityThreshold ?? 0.25,
      );
      identitySimilarity = result.similarity;
      checks.push({
        name: 'composition',
        status: result.pass ? 'pass' : 'warn',
        detail:
          `${(result.similarity * 100).toFixed(0)}% structural similarity to the master` +
          (result.pass
            ? ''
            : ' - unusually different, worth a look before spending'),
      });
    } catch (err) {
      checks.push({
        name: 'composition',
        status: 'unknown',
        detail: `comparison failed: ${(err as Error).message.slice(0, 80)}`,
      });
    }
  }

  return {
    path: imagePath,
    pass: checks.every((c) => c.status === 'pass' || c.status === 'warn'),
    checks,
    identitySimilarity,
  };
}

export type GenerateAnchorFn = (attempt: number) => Promise<string>;

export type AnchorRetryResult = {
  path: string | null;
  attempts: number;
  validation: AnchorValidation | null;
  /** Every attempt, so a caller can see what went wrong and how. */
  history: AnchorValidation[];
  gaveUp: boolean;
  reason: string;
};

/**
 * Generate an anchor, validate it, and retry until it passes or the cap is
 * reached.
 *
 * @param generate  produces an image and returns its path. Called once per
 *                  attempt, so it can vary the prompt or seed.
 * @param maxAttempts  hard cap. Three consecutive failures means the request
 *                  itself is wrong; retrying a fourth time spends credits on
 *                  a prompt that cannot succeed.
 */
export async function generateValidatedAnchor(
  generate: GenerateAnchorFn,
  opts: AnchorOptions & { maxAttempts?: number; label?: string } = {},
): Promise<AnchorRetryResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const label = opts.label ?? 'anchor';
  const history: AnchorValidation[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let path: string;
    try {
      path = await generate(attempt);
    } catch (err) {
      history.push({
        path: '(generation failed)',
        pass: false,
        identitySimilarity: null,
        checks: [{ name: 'generate', status: 'fail', detail: (err as Error).message.slice(0, 160) }],
      });
      continue;
    }

    const validation = await validateAnchor(path, opts);
    history.push(validation);

    if (validation.pass) {
      if (attempt > 1) {
        log.info(`${label}: passed on attempt ${attempt} of ${maxAttempts}`);
      }
      return {
        path,
        attempts: attempt,
        validation,
        history,
        gaveUp: false,
        reason: `validated on attempt ${attempt}`,
      };
    }

    const failed = validation.checks.filter((c) => c.status === 'fail');
    log.warn(
      `${label}: attempt ${attempt} rejected - ${failed.map((c) => c.name).join(', ')}`,
    );
  }

  // Stop rather than keep paying. The caller decides whether to change the
  // prompt, change the reference, or skip the shot - never this function.
  return {
    path: null,
    attempts: maxAttempts,
    validation: history[history.length - 1] ?? null,
    history,
    gaveUp: true,
    reason:
      `${label} failed validation ${maxAttempts} times. The prompt or the character ` +
      `reference is likely wrong, not the generation. Revise before spending on video.`,
  };
}

/** Validate both anchors of a shot together. */
export async function validateShotAnchors(
  startImage: string | undefined,
  endImage: string | undefined,
  opts: AnchorOptions = {},
): Promise<{ pass: boolean; start: AnchorValidation | null; end: AnchorValidation | null; blockers: string[] }> {
  const start = startImage ? await validateAnchor(startImage, opts) : null;
  const end = endImage ? await validateAnchor(endImage, opts) : null;

  const blockers: string[] = [];
  for (const [which, v] of [['start', start], ['end', end]] as const) {
    if (!v) continue;
    for (const c of v.checks) {
      if (c.status === 'fail') blockers.push(`${which} frame: ${c.name} - ${c.detail}`);
    }
  }

  return { pass: blockers.length === 0, start, end, blockers };
}

export function formatAnchorValidation(v: AnchorValidation): string {
  const icon = { pass: '✓', fail: '✗', warn: '!', unknown: '?' } as const;
  return [
    `${v.pass ? '✓' : '✗'} ${v.path.split('/').slice(-2).join('/')}`,
    ...v.checks.map((c) => `    ${icon[c.status]} ${c.name.padEnd(12)} ${c.detail}`),
  ].join('\n');
}
