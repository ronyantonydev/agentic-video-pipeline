/**
 * The reference gate. Enforcement in code, not instruction.
 *
 * The drift test and the reference-pack rules were previously carried only by
 * the skill files - Claude followed them because it was told to. That is
 * reliable most of the time, which is the wrong bar when each miss costs 20
 * credits: both real failures on this project were reference problems.
 *
 * This moves the check into a gate. `assertReferencesVerified` refuses to let
 * generation proceed until a passing result exists on disk, exactly as the
 * cost gate refuses to proceed without an approval. Claude still GENERATES
 * the images - only Claude can, since MCP tools are not reachable from code -
 * but it can no longer skip the verification.
 *
 * The verification itself is free: perceptual hashing and FFmpeg, run
 * locally. Nothing here spends.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic, readJsonIfExists } from '../util/atomic.js';
import { paths } from '../state/paths.js';
import { ValidationError } from '../util/errors.js';
import { runDriftTest, referencePackPaths, type DriftTestResult } from './identity.js';
import { validateAnchor } from './anchor.js';
import { checkGrounding } from './grounding.js';
import { log } from '../util/logger.js';

/** Written by the gate, read by generation. Its absence blocks the run. */
export const ReferenceCheckSchema = z.object({
  version: z.literal(1),
  ranAt: z.string().datetime(),
  pass: z.boolean(),
  characterPack: z.object({
    present: z.boolean(),
    imageCount: z.number().int().nonnegative(),
    /** Six images: three face angles, three body. See verify-realism rule 1. */
    meetsPackSize: z.boolean(),
  }),
  driftTest: z
    .object({
      samples: z.number().int().nonnegative(),
      meanSimilarity: z.number(),
      minSimilarity: z.number(),
      holds: z.boolean(),
    })
    .nullable(),
  sheets: z.object({
    environment: z.number().int().nonnegative(),
    props: z.number().int().nonnegative(),
    style: z.number().int().nonnegative(),
  }),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  /**
   * Prop sheets that look like an object floating on a studio backdrop.
   * Recorded so the warning survives in the audit trail, not just the log.
   */
  ungroundedProps: z.array(z.string()).default([]),
  /**
   * Set when a human overrode a FAILING drift test. The drift result above
   * still records what the test actually measured - the override never
   * rewrites it - so the audit trail shows both the failure and the reason
   * it was accepted.
   */
  driftOverride: z
    .object({ reason: z.string().min(1), decidedAt: z.string().datetime() })
    .nullable()
    .default(null),
});

export type ReferenceCheck = z.infer<typeof ReferenceCheckSchema>;

const RESULT_FILE = 'reference-check.json';

function resultPath(project: string): string {
  return join(paths(project).references, RESULT_FILE);
}

/**
 * A plate that was generated, looked at, and rejected.
 *
 * Rejects are worth keeping - they are the evidence for why the replacement
 * looks the way it does - but the gate must not offer one for approval
 * alongside the plate that replaced it. Name a superseded plate
 * `<name>-rejected-<something>.png` and it stays on disk without counting as
 * a live reference.
 */
export function isRejectedPlate(file: string): boolean {
  return /-rejected(-|\.)/i.test(file);
}

function isLiveImage(file: string): boolean {
  return /\.(png|jpe?g|webp)$/i.test(file) && !isRejectedPlate(file);
}

function countImages(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter(isLiveImage).length;
}

export type ReferenceCheckOptions = {
  /** A shot with no person in it needs no character pack. */
  needsCharacter?: boolean;
  /** Sample images generated from the pack, for the drift test. */
  driftSamples?: string[];
  /** Minimum images in the character pack. Six by default (3 face, 3 body). */
  minPackSize?: number;
  /**
   * Human reason for accepting a FAILING drift test.
   *
   * Deliberately narrow: it clears the drift blocker and nothing else. A
   * missing pack or a corrupt reference image still blocks, because those
   * are facts about the files rather than a judgement call.
   *
   * It exists because the drift test is an 8x8 perceptual hash of the whole
   * frame, so it scores the BACKGROUND as much as the subject. Samples shot
   * in varied settings - which is what the test asks for - can score below
   * a genuinely different person photographed against the same backdrop.
   * When a human has looked at the samples and confirmed identity holds,
   * that judgement is better evidence than the hash, and recording it beats
   * the alternative of quietly disabling the gate.
   */
  driftOverrideReason?: string;
};

/**
 * Verify the reference set and record the result.
 *
 * Free - hashing and FFmpeg only. Generation happens elsewhere.
 */
export async function checkReferences(
  project: string,
  opts: ReferenceCheckOptions = {},
): Promise<ReferenceCheck> {
  const p = paths(project);
  const needsCharacter = opts.needsCharacter ?? true;
  const minPackSize = opts.minPackSize ?? 6;

  const blockers: string[] = [];
  const warnings: string[] = [];

  const characterDir = p.referenceCategory('character');
  const imageCount = countImages(characterDir);
  const meetsPackSize = imageCount >= minPackSize;

  let driftTest: ReferenceCheck['driftTest'] = null;

  if (needsCharacter) {
    if (imageCount === 0) {
      blockers.push(
        'no character reference images. Identity cannot be carried by a text ' +
          'description - see verify-realism rule 1.',
      );
    } else if (!meetsPackSize) {
      // Not fatal: one reference held identity in wide shots on the real
      // project. It failed in close-ups, which is why six are wanted.
      warnings.push(
        `character pack has ${imageCount} image(s), fewer than the ${minPackSize} ` +
          `recommended (3 face angles, 3 body). Identity may drift in close-ups.`,
      );
    }

    // Every reference image must itself be usable. A blank or truncated
    // reference poisons every shot that uses it.
    for (const file of existsSync(characterDir) ? readdirSync(characterDir) : []) {
      if (!isLiveImage(file)) continue;
      const v = await validateAnchor(join(characterDir, file));
      for (const c of v.checks) {
        if (c.status === 'fail') {
          blockers.push(`character/${file}: ${c.name} - ${c.detail}`);
        }
      }
    }

    // The drift test proper: does the reference actually hold across
    // varied settings? About one credit to find out, against ~250 to
    // discover it after a full run.
    if (opts.driftSamples && opts.driftSamples.length > 0 && imageCount > 0) {
      // The master must be a predictable, front-facing view. Taking whatever
      // readdirSync returned first picked `body-back.png` by alphabetical
      // luck - and the comparison is a whole-image perceptual hash, so a
      // full-body back view scored against head-and-shoulders samples fails
      // on framing rather than identity. Prefer the canonical front face and
      // fall back to the pack order only if it is missing.
      const master =
        referencePackPaths(characterDir).find((f) => existsSync(f)) ??
        join(characterDir, readdirSync(characterDir).find(isLiveImage)!);
      const result: DriftTestResult = await runDriftTest(master, opts.driftSamples);
      driftTest = {
        samples: result.samples,
        meanSimilarity: result.meanSimilarity,
        minSimilarity: result.minSimilarity,
        holds: result.holds,
      };
      // A LOW SCORE WARNS; IT NEVER BLOCKS.
      //
      // Measured on this project's real assets 2026-08-20, and the numbers
      // are unambiguous: the 64-bit perceptual hash carries no identity
      // information at all. Against the character master, five real samples
      // scored 0.391-0.734 while a photograph of a STOOL scored 0.500 -
      // higher than two of the five. Cropping to the face first (tested,
      // both loose and tightly aligned) did not separate them; it widened
      // the spread. Two unrelated images average ~0.5 by chance on a 64-bit
      // hash, and every score here sits inside that noise band.
      //
      // So there is no threshold that distinguishes a face from a stool, and
      // a gate that blocks on this number is blocking on a coin flip. It
      // stopped every run and was overridden every time, which is a check
      // that has already stopped working - and worse than none, because it
      // manufactures confidence it cannot support.
      //
      // The score is still recorded and still printed: a run of very low
      // scores is weak evidence worth a human glance. It is a smoke signal,
      // exactly as the composition check in anchor.ts is, and it is
      // labelled as one rather than dressed up as a verdict.
      //
      // Judging identity properly needs face embeddings (ArcFace and
      // similar) or vision QA. Until one of those exists here, nothing in
      // this file can answer "is this the same person".
      if (!result.holds) {
        warnings.push(
          `drift score low (mean ${result.meanSimilarity.toFixed(2)}, min ` +
            `${result.minSimilarity.toFixed(2)}) - ADVISORY ONLY, not a verdict. ` +
            `This metric cannot tell a face from a prop (a stool scored 0.50 ` +
            `against this character), so it never blocks. If identity matters ` +
            `on this project, look at the samples yourself before committing.`,
        );
      }
    } else {
      warnings.push(
        'drift test not run - no samples supplied. Generate 5-10 cheap samples ' +
          'from the pack and re-run before committing to a full set of shots.',
      );
    }
  }

  const sheets = {
    environment: countImages(p.referenceCategory('environment')),
    props: countImages(p.referenceCategory('props')),
    style: countImages(p.referenceCategory('style')),
  };

  // Sheets warn rather than block. Their absence degrades consistency; it
  // does not make generation impossible, and a single-location shoot with
  // no props is legitimate.
  if (sheets.environment === 0) {
    warnings.push(
      'no environment sheet. Each shot will re-describe the location in words ' +
        'and the model will reinvent it - this is how a winter forest became a ' +
        'summer one and cost 20 credits.',
    );
  }
  if (sheets.style === 0) {
    warnings.push('no style sheet. Shots may not feel like one video.');
  }

  // Prop grounding. A prop that rests on a surface, shot against a seamless
  // backdrop, teaches the model that the object touches nothing - which is
  // what it then renders. oak-stool shot_004 put the finished stool hovering
  // in mid-air beside the bench for exactly this reason.
  //
  // WARN, never block: a held prop (chisel, mallet) is legitimately on grey
  // and the gate cannot tell the two apart. Only the shot author knows.
  const ungroundedProps: string[] = [];
  const propsDir = p.referenceCategory('props');
  for (const file of existsSync(propsDir) ? readdirSync(propsDir) : []) {
    if (!isLiveImage(file)) continue;
    const g = await checkGrounding(join(propsDir, file));
    if (g.looksUngrounded) {
      ungroundedProps.push(file);
      warnings.push(
        `props/${file}: ${g.detail}. If this object RESTS on something ` +
          `(a stool, a chair, a crate) reshoot it on a real surface with a ` +
          `contact shadow - on grey the model renders it floating. If it is ` +
          `HELD (a chisel, a mallet) this is fine.`,
      );
    }
  }

  // The drift score no longer blocks, so there is nothing left to override.
  //
  // The field is kept, and --override-drift still records a reason, because
  // a human note about why a low score was accepted is worth preserving in
  // the audit trail. It simply no longer unblocks anything: nothing is
  // blocked. Existing scripts that pass the flag keep working unchanged.
  let driftOverride: ReferenceCheck['driftOverride'] = null;
  if (opts.driftOverrideReason) {
    driftOverride = {
      reason: opts.driftOverrideReason,
      decidedAt: new Date().toISOString(),
    };
    warnings.push(`drift note recorded: ${opts.driftOverrideReason}`);
  }

  const check: ReferenceCheck = {
    version: 1,
    ranAt: new Date().toISOString(),
    pass: blockers.length === 0,
    characterPack: { present: imageCount > 0, imageCount, meetsPackSize },
    driftTest,
    sheets,
    blockers,
    warnings,
    ungroundedProps,
    driftOverride,
  };

  writeJsonAtomic(resultPath(project), check);

  for (const w of warnings) log.warn(w);
  log.info(
    `Reference check: ${check.pass ? 'PASS' : 'BLOCKED'} — ` +
      `${imageCount} character image(s), ${sheets.environment} environment, ` +
      `${sheets.props} prop(s), ${sheets.style} style`,
  );

  return check;
}

export function readReferenceCheck(project: string): ReferenceCheck | null {
  const raw = readJsonIfExists<unknown>(resultPath(project), null);
  if (raw === null) return null;
  const parsed = ReferenceCheckSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The gate itself.
 *
 * @throws ValidationError when references have not been verified, or were
 *         verified and failed. Generation must not proceed either way -
 *         "not checked" and "checked and bad" are equally unsafe.
 */
export function assertReferencesVerified(project: string): ReferenceCheck {
  const check = readReferenceCheck(project);

  if (!check) {
    throw new ValidationError(
      'References have not been verified. Run the reference check before ' +
        'generating shots:\n' +
        '  1. generate the character pack and sheets\n' +
        '  2. generate 5-10 drift samples from the pack\n' +
        '  3. run checkReferences() to record the result\n' +
        'Both failures on this project were reference problems, 20 credits each.',
      'reference-check',
    );
  }

  if (!check.pass) {
    throw new ValidationError(
      `Reference check failed, refusing to generate:\n  ${check.blockers.join('\n  ')}`,
      'reference-check',
      check.blockers,
    );
  }

  return check;
}

export function formatReferenceCheck(check: ReferenceCheck): string {
  const lines = [`Reference check: ${check.pass ? 'PASS' : 'BLOCKED'}`];

  lines.push(
    `  character  ${check.characterPack.imageCount} image(s)` +
      (check.characterPack.meetsPackSize ? '' : ' (fewer than the 6 recommended)'),
  );
  if (check.driftTest) {
    // Never printed as FAILED: the score cannot support that word. See the
    // measurement note in checkReferences.
    lines.push(
      `  drift score ${check.driftTest.holds ? 'ok' : 'LOW (advisory)'} — ` +
        `${check.driftTest.samples} samples, mean ` +
        `${check.driftTest.meanSimilarity.toFixed(2)}, min ` +
        `${check.driftTest.minSimilarity.toFixed(2)}`,
    );
    if (!check.driftTest.holds) {
      lines.push('             advisory only — this metric cannot verify identity');
    }
    if (check.driftOverride) {
      lines.push(`  note       ${check.driftOverride.reason}`);
    }
  } else {
    lines.push('  drift test not run');
  }
  lines.push(
    `  sheets     ${check.sheets.environment} environment, ` +
      `${check.sheets.props} prop(s), ${check.sheets.style} style`,
  );

  for (const b of check.blockers) lines.push(`  ✗ ${b}`);
  for (const w of check.warnings) lines.push(`  ! ${w}`);

  return lines.join('\n');
}
