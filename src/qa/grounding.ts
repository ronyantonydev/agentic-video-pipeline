/**
 * Grounding check for prop references.
 *
 * A prop that rests on a surface must be photographed resting on a surface.
 * Shot against a seamless studio backdrop it has no ground plane, and the
 * video model reproduces exactly that: an object touching nothing.
 *
 * This is measured, not hypothetical. `oak-stool` shot_004 asked for "the
 * finished stool stands on the bench" while passing a stool reference that
 * floated on flat grey. The model copied the reference's framing over the
 * prompt's blocking and rendered the stool hovering in mid-air beside the
 * bench. Twelve and a half credits for an unusable clip.
 *
 * WHAT THIS CAN AND CANNOT CATCH. It measures the luminance spread around
 * the image border. A seamless backdrop is near-uniform there; a real
 * surface with a horizon line, a table edge or a contact shadow is not. That
 * reliably separates "studio void" from "photographed on something".
 *
 * It CANNOT tell whether the prop needed grounding in the first place. A
 * chisel or a mallet is held, implies no ground plane, and is perfectly
 * legitimate on grey. Only the person who wrote the shot knows which it is,
 * so this WARNS and never blocks - the same reasoning that makes the
 * composition check in anchor.ts a warn.
 *
 * Free: one ffmpeg crop per image, run locally. Nothing here spends.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { probe } from '../ffmpeg/probe.js';
import { loadEnv } from '../config/env.js';

const exec = promisify(execFile);

export type GroundingResult = {
  path: string;
  /** Luminance spread around the border. Low means a seamless backdrop. */
  borderSpread: number | null;
  /** True when the image looks like an object floating on a studio void. */
  looksUngrounded: boolean;
  detail: string;
};

/**
 * Border uniformity is the signal.
 *
 * Sampling the whole frame does not work: a well-lit prop on grey has plenty
 * of contrast in the middle, so a full-frame measure looks healthy while the
 * background is still a void. The border is where a real surface shows
 * itself - a table edge, a floor line, a falloff into shadow.
 */
const BORDER_FRACTION = 0.14;

/** Below this, the border is flat enough to read as a seamless backdrop. */
const FLAT_BORDER_SPREAD = 0.10;

async function borderSpread(imagePath: string): Promise<number | null> {
  const info = await probe(imagePath);
  const w = info.video?.width ?? 0;
  const h = info.video?.height ?? 0;
  if (w === 0 || h === 0) return null;

  // The bottom strip specifically: that is where a surface, a contact shadow
  // or a horizon would appear, and where a seamless sweep stays blank. A
  // full border ring dilutes the signal with the top of frame, which is
  // empty in a legitimate grounded shot too.
  const stripH = Math.max(8, Math.round(h * BORDER_FRACTION));
  const y = h - stripH;

  const env = loadEnv();
  try {
    const { stderr } = await exec(
      env.ffmpegBin,
      [
        '-v', 'info',
        '-i', imagePath,
        '-vf', `crop=${w}:${stripH}:0:${y},signalstats,metadata=print`,
        '-f', 'null', '-',
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    const lows = [...stderr.matchAll(/lavfi\.signalstats\.YLOW=([\d.]+)/g)].map((m) => Number(m[1]));
    const highs = [...stderr.matchAll(/lavfi\.signalstats\.YHIGH=([\d.]+)/g)].map((m) => Number(m[1]));
    if (lows.length > 0 && lows.length === highs.length) {
      return (highs[0]! - lows[0]!) / 255;
    }
    return null;
  } catch {
    return null;
  }
}

/** Check one prop reference for a missing ground plane. */
export async function checkGrounding(imagePath: string): Promise<GroundingResult> {
  if (!existsSync(imagePath)) {
    return {
      path: imagePath,
      borderSpread: null,
      looksUngrounded: false,
      detail: 'file not found',
    };
  }

  const spread = await borderSpread(imagePath);
  if (spread === null) {
    // Unmeasurable is not the same as bad. Say so and let the caller decide.
    return {
      path: imagePath,
      borderSpread: null,
      looksUngrounded: false,
      detail: 'could not sample the border',
    };
  }

  const looksUngrounded = spread < FLAT_BORDER_SPREAD;
  return {
    path: imagePath,
    borderSpread: spread,
    looksUngrounded,
    detail: looksUngrounded
      ? `border spread ${spread.toFixed(3)} - flat, reads as a studio backdrop with no ground plane`
      : `border spread ${spread.toFixed(3)} - a surface is visible`,
  };
}
