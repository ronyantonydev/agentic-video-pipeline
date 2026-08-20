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
import { runDriftTest, type DriftTestResult } from './identity.js';
import { validateAnchor } from './anchor.js';
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
});

export type ReferenceCheck = z.infer<typeof ReferenceCheckSchema>;

const RESULT_FILE = 'reference-check.json';

function resultPath(project: string): string {
  return join(paths(project).references, RESULT_FILE);
}

function countImages(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).length;
}

export type ReferenceCheckOptions = {
  /** A shot with no person in it needs no character pack. */
  needsCharacter?: boolean;
  /** Sample images generated from the pack, for the drift test. */
  driftSamples?: string[];
  /** Minimum images in the character pack. Six by default (3 face, 3 body). */
  minPackSize?: number;
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
      if (!/\.(png|jpe?g|webp)$/i.test(file)) continue;
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
      const master = join(
        characterDir,
        readdirSync(characterDir).find((f) => /\.(png|jpe?g|webp)$/i.test(f))!,
      );
      const result: DriftTestResult = await runDriftTest(master, opts.driftSamples);
      driftTest = {
        samples: result.samples,
        meanSimilarity: result.meanSimilarity,
        minSimilarity: result.minSimilarity,
        holds: result.holds,
      };
      if (!result.holds) {
        blockers.push(`drift test failed: ${result.recommendation}`);
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

  const check: ReferenceCheck = {
    version: 1,
    ranAt: new Date().toISOString(),
    pass: blockers.length === 0,
    characterPack: { present: imageCount > 0, imageCount, meetsPackSize },
    driftTest,
    sheets,
    blockers,
    warnings,
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
    lines.push(
      `  drift test ${check.driftTest.holds ? 'holds' : 'FAILED'} — ` +
        `${check.driftTest.samples} samples, mean ` +
        `${check.driftTest.meanSimilarity.toFixed(2)}`,
    );
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
