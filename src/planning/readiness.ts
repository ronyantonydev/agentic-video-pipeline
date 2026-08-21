/**
 * Is this plan actually ready to run?
 *
 * Every other check answers one question well: schemas validate shape, the
 * motion lint checks the edit, refcheck checks images. Nothing asked the whole
 * question - "if /run-video started right now, would it finish?" - and a plan
 * can pass all of them while still being unrunnable.
 *
 * Two real holes this was written after finding, both invisible to every
 * existing check:
 *
 *   1. Ten title cards were planned with text and timing but no source image.
 *      `compileComposition` resolves a still to `shots/<id>/start.png` and
 *      THROWS when it is missing, so the render would have died on all ten.
 *   2. Those cards reused the video shot's id, so each card and its clip both
 *      resolved to the same directory and the card would have picked up the
 *      clip's footage.
 *
 * Free: reads files, spends nothing.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../state/paths.js';
import { readState } from '../state/store.js';
import { readJsonIfExists } from '../util/atomic.js';
import { PLANNING_ARTIFACTS, PlanSchema, type PlanningArtifactName } from '../schemas/planning.js';

/** What a check is about, so the report can group them. */
export type ReadinessLayer =
  | 'artifacts'
  | 'shots'
  | 'frames'
  | 'stills'
  | 'edit'
  | 'audio'
  | 'references'
  | 'cost'
  | 'contract';

export type ReadinessCheck = {
  layer: ReadinessLayer;
  name: string;
  /**
   * `blocker` means /run-video cannot finish. `warn` means it can, but
   * something is worth knowing. Nothing here is decorative.
   */
  status: 'pass' | 'warn' | 'blocker';
  detail: string;
  /** What to do about it. A finding without a fix moves the confusion. */
  fix?: string;
};

export type ReadinessResult = {
  project: string;
  checks: ReadinessCheck[];
  blockers: number;
  warnings: number;
  ready: boolean;
};

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
const isLive = (f: string) => IMAGE_RE.test(f) && !/-rejected(-|\.)/i.test(f);

function countLive(dir: string): number {
  return existsSync(dir) ? readdirSync(dir).filter(isLive).length : 0;
}

export function checkReadiness(project: string): ReadinessResult {
  const p = paths(project);
  const checks: ReadinessCheck[] = [];
  const add = (c: ReadinessCheck) => checks.push(c);

  const state = readState(project);

  /* ------------------------------------------------------------ artifacts */

  const OPTIONAL = new Set(['audio-plan.json']);
  const names = (Object.keys(PLANNING_ARTIFACTS) as PlanningArtifactName[]);
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const name of names) {
    const file = p.planningFile(name);
    if (!existsSync(file)) {
      if (!OPTIONAL.has(name)) missing.push(name);
      continue;
    }
    const parsed = PLANNING_ARTIFACTS[name].safeParse(readJsonIfExists<unknown>(file, null));
    if (!parsed.success) invalid.push(name);
  }
  add({
    layer: 'artifacts',
    name: 'All planning artifacts present and valid',
    status: missing.length + invalid.length > 0 ? 'blocker' : 'pass',
    detail:
      missing.length + invalid.length === 0
        ? `${names.length} artifacts valid`
        : `missing: ${missing.join(', ') || 'none'}; invalid: ${invalid.join(', ') || 'none'}`,
    ...(missing.length + invalid.length > 0
      ? { fix: `Re-run the owning stage: npm run plan:story|audio|storyboard|edit|generation -- ${project}` }
      : {}),
  });

  const storyboard = readJsonIfExists<{
    frames?: Array<{ shotId: string; startFramePrompt?: string; endFramePrompt?: string }>;
  }>(p.planningFile('storyboard.json'), { frames: [] });
  const gen = readJsonIfExists<{
    items?: Array<{
      shotId: string; modelId: string; billableSeconds: number;
      usesStartFrame?: boolean; usesEndFrame?: boolean;
    }>;
  }>(p.planningFile('generation-plan.json'), { items: [] });
  const edit = readJsonIfExists<{
    totalDurationSeconds?: number;
    items?: Array<{
      shotId: string; isStill?: boolean; screenDurationSeconds: number;
      startSeconds: number; transitionIn?: string; transitionOut?: string;
      speedFactor?: number;
    }>;
    music?: { file?: string };
    captions?: Array<{ text: string; startSeconds?: number }>;
  }>(p.planningFile('edit-plan.json'), {});
  const audio = readJsonIfExists<{
    musicFile?: string;
    sfx?: Array<{ shotId?: string; description: string }>;
    narration?: { script: string; localFile?: string };
  }>(p.planningFile('audio-plan.json'), {});
  const music = readJsonIfExists<{ source?: string; localFile?: string }>(
    p.planningFile('music.json'),
    {},
  );

  const genItems = gen.items ?? [];
  const editItems = edit.items ?? [];
  const frames = storyboard.frames ?? [];

  /* ---------------------------------------------------------------- shots */

  const genIds = new Set(genItems.map((i) => i.shotId));
  const videoItems = editItems.filter((i) => !i.isStill);
  const orphanTimeline = videoItems.filter((i) => !genIds.has(i.shotId)).map((i) => i.shotId);
  add({
    layer: 'shots',
    name: 'Every video item in the edit has a generation plan entry',
    status: orphanTimeline.length > 0 ? 'blocker' : 'pass',
    detail:
      orphanTimeline.length > 0
        ? `${orphanTimeline.length} timeline item(s) reference a shot that will never be generated: ${orphanTimeline.slice(0, 5).join(', ')}`
        : `${videoItems.length} video item(s) all planned`,
    ...(orphanTimeline.length > 0
      ? { fix: 'Add the shot to generation-plan.json, or remove it from edit-plan.json.' }
      : {}),
  });

  const unpriced = genItems.filter((i) => !i.modelId).map((i) => i.shotId);
  add({
    layer: 'shots',
    name: 'Every shot names a model',
    status: unpriced.length > 0 ? 'blocker' : 'pass',
    detail: unpriced.length > 0 ? `${unpriced.length} shot(s) have no model` : `${genItems.length} shot(s)`,
    ...(unpriced.length > 0 ? { fix: 'Set modelId on every generation-plan item.' } : {}),
  });

  /* --------------------------------------------------------------- frames */

  const framesDir = p.storyboardFrames;
  const onDisk = countLive(framesDir);
  const wantFrames = genItems.filter((i) => i.usesStartFrame).length * 2;

  // Only GENERATED shots need frames. A composed still - a title card - has
  // its own image and never goes near the video model, so counting it as
  // un-framed reports a gap that does not exist.
  const generatedFrames = frames.filter((f) => genIds.has(f.shotId));
  const framed = generatedFrames.filter((f) => f.startFramePrompt).length;

  add({
    layer: 'frames',
    name: 'Frame prompts written for every generated shot',
    status: framed === generatedFrames.length ? 'pass' : framed === 0 ? 'blocker' : 'warn',
    detail:
      `${framed} of ${generatedFrames.length} generated shot(s) have a start frame prompt` +
      (frames.length > generatedFrames.length
        ? ` (${frames.length - generatedFrames.length} composed still(s) need none)`
        : ''),
    ...(framed < generatedFrames.length
      ? {
          fix:
            'Write startFramePrompt/endFramePrompt into storyboard.json. A shot with no ' +
            'frame is a dice roll nobody reviewed, and cannot be corrected before the run.',
        }
      : {}),
  });

  // The prompts existing is not the same as the images existing.
  const missingFrames: string[] = [];
  for (const item of genItems) {
    if (item.usesStartFrame && !existsSync(join(framesDir, `${item.shotId}-start.png`))) {
      missingFrames.push(`${item.shotId}-start`);
    }
    if (item.usesEndFrame && !existsSync(join(framesDir, `${item.shotId}-end.png`))) {
      missingFrames.push(`${item.shotId}-end`);
    }
  }
  add({
    layer: 'frames',
    name: 'Every planned frame exists on disk',
    status: missingFrames.length > 0 ? 'blocker' : 'pass',
    detail:
      missingFrames.length > 0
        ? `${missingFrames.length} missing: ${missingFrames.slice(0, 5).join(', ')}`
        : `${onDisk} frame file(s) for ${wantFrames} planned`,
    ...(missingFrames.length > 0
      ? {
          fix:
            'Generate the missing frames, or set usesStartFrame/usesEndFrame to false. ' +
            'The generator will be told to use a frame that is not there.',
        }
      : {}),
  });

  /* --------------------------------------------------------------- stills */
  /*
   * The hole that prompted this file. A still resolves to
   * `shots/<shotId>/start.png` in compileComposition and THROWS when absent.
   */

  const stills = editItems.filter((i) => i.isStill);
  if (stills.length > 0) {
    const videoIds = new Set(videoItems.map((i) => i.shotId));
    const colliding = stills.filter((s) => videoIds.has(s.shotId)).map((s) => s.shotId);
    add({
      layer: 'stills',
      name: 'Stills have their own ids',
      status: colliding.length > 0 ? 'blocker' : 'pass',
      detail:
        colliding.length > 0
          ? `${colliding.length} still(s) reuse a video shot's id, so both resolve to the ` +
            `same shots/<id>/ directory: ${colliding.slice(0, 5).join(', ')}`
          : `${stills.length} still(s) have distinct ids`,
      ...(colliding.length > 0
        ? { fix: 'Give each still its own shot id (e.g. card_001) so its asset cannot be confused with a clip.' }
        : {}),
    });

    const noSource = stills.filter(
      (s) => !existsSync(p.shotFile(s.shotId, 'start.png')) && !existsSync(join(p.stills, `${s.shotId}.png`)),
    );
    add({
      layer: 'stills',
      name: 'Every still has an image to render',
      status: noSource.length > 0 ? 'blocker' : 'pass',
      detail:
        noSource.length > 0
          ? `${noSource.length} of ${stills.length} still(s) have no source image`
          : `${stills.length} still(s) sourced`,
      ...(noSource.length > 0
        ? {
            fix:
              'Generate or compose an image per still into stills/<id>.png. compileComposition ' +
              'resolves a still to shots/<id>/start.png and THROWS when it is missing, so the ' +
              'render fails rather than leaving a gap.',
          }
        : {}),
    });
  }

  /* ----------------------------------------------------------------- edit */
  /*
   * The HyperFrames layer: how the timeline actually presents the shots.
   * `compileComposition` only WARNS about an unimplemented transition, and it
   * warns at render time - after every clip has been paid for. Everything
   * here is knowable while it is still free.
   */

  // Transitions the compiler can actually render. Anything else is silently
  // downgraded to a hard cut: the plan says one thing and the video does
  // another, with nothing in between reporting the difference.
  const RENDERABLE = new Set(['cut', 'crossfade', 'dissolve', 'fade']);
  const badTransitions = editItems.flatMap((i) =>
    ([i.transitionIn, i.transitionOut].filter(
      (t): t is string => typeof t === 'string' && !RENDERABLE.has(t),
    )).map((t) => `${i.shotId}:${t}`),
  );
  add({
    layer: 'edit',
    name: 'Every transition is one the compiler can render',
    status: badTransitions.length > 0 ? 'blocker' : 'pass',
    detail:
      badTransitions.length > 0
        ? `${badTransitions.length} unsupported: ${[...new Set(badTransitions)].slice(0, 5).join(', ')}`
        : `only ${[...RENDERABLE].join('/')} used`,
    ...(badTransitions.length > 0
      ? {
          fix:
            `Use one of: ${[...RENDERABLE].join(', ')}. Anything else renders as a hard ` +
            'cut and only warns at render time, after the clips are paid for.',
        }
      : {}),
  });

  // A gap renders as black; an overlap means two clips claim the same second.
  // Both are arithmetic, and both are invisible until someone watches it.
  if (editItems.length > 0) {
    const ordered = [...editItems].sort((a, b) => a.startSeconds - b.startSeconds);
    const gaps: string[] = [];
    const overlaps: string[] = [];
    let cursor = 0;
    for (const item of ordered) {
      if (item.startSeconds > cursor + 0.001) {
        gaps.push(`${round2(cursor)}s-${round2(item.startSeconds)}s before ${item.shotId}`);
      } else if (item.startSeconds < cursor - 0.001) {
        overlaps.push(`${item.shotId} at ${round2(item.startSeconds)}s`);
      }
      cursor = Math.max(cursor, item.startSeconds + item.screenDurationSeconds);
    }
    add({
      layer: 'edit',
      name: 'Timeline is continuous - no gaps, no overlaps',
      status: gaps.length + overlaps.length > 0 ? 'blocker' : 'pass',
      detail:
        gaps.length + overlaps.length > 0
          ? `${gaps.length} gap(s), ${overlaps.length} overlap(s): ${[...gaps, ...overlaps].slice(0, 3).join('; ')}`
          : `${editItems.length} item(s) cover ${round2(cursor)}s without a break`,
      ...(gaps.length + overlaps.length > 0
        ? { fix: 'A gap renders as black; an overlap double-books a second. Fix startSeconds in edit-plan.json.' }
        : {}),
    });

    const declared = edit.totalDurationSeconds ?? 0;
    add({
      layer: 'edit',
      name: 'Declared runtime matches the timeline',
      status: Math.abs(cursor - declared) < 0.01 ? 'pass' : 'blocker',
      detail:
        Math.abs(cursor - declared) < 0.01
          ? `${round2(declared)}s`
          : `edit-plan declares ${declared}s but the items end at ${round2(cursor)}s`,
      ...(Math.abs(cursor - declared) >= 0.01
        ? { fix: 'Set totalDurationSeconds to where the last item actually ends.' }
        : {}),
    });
  }

  // speedFactor > 1 plays the clip faster, so the SOURCE must supply
  // proportionally more footage than the screen time it fills. A 5s clip
  // played at 2x covers only 2.5s of timeline; asking it to fill 5s runs it
  // off the end of the footage that was paid for.
  const genById = new Map(genItems.map((i) => [i.shotId, i]));
  const shortSource = editItems
    .filter((i) => !i.isStill && (i.speedFactor ?? 1) !== 1)
    .flatMap((i) => {
      const g = genById.get(i.shotId);
      if (!g) return [];
      const needed = i.screenDurationSeconds * (i.speedFactor ?? 1);
      return g.billableSeconds + 0.001 < needed
        ? [`${i.shotId} needs ${round2(needed)}s of footage at ${i.speedFactor}x, has ${g.billableSeconds}s`]
        : [];
    });
  const sped = editItems.filter((i) => (i.speedFactor ?? 1) !== 1).length;
  if (sped > 0) {
    add({
      layer: 'edit',
      name: 'Sped-up clips have enough source footage',
      status: shortSource.length > 0 ? 'blocker' : 'pass',
      detail:
        shortSource.length > 0
          ? shortSource.slice(0, 3).join('; ')
          : `${sped} clip(s) with a speed change, all covered`,
      ...(shortSource.length > 0
        ? {
            fix:
              'Raise billableSeconds on the generation item, or lower speedFactor. ' +
              'Playing faster consumes MORE footage than the screen time it fills.',
          }
        : {}),
    });
  }

  // A caption is the text ON a card. One landing anywhere else is text with
  // no picture under it.
  const captions = edit.captions ?? [];
  if (captions.length > 0) {
    const stillStarts = new Set(
      editItems.filter((i) => i.isStill).map((i) => i.startSeconds),
    );
    const floating = (captions as Array<{ text: string; startSeconds?: number }>)
      .filter((c) => c.startSeconds !== undefined && !stillStarts.has(c.startSeconds))
      .map((c) => `"${c.text.slice(0, 20)}"`);
    add({
      layer: 'edit',
      name: 'Every caption sits on a card',
      status: floating.length > 0 ? 'warn' : 'pass',
      detail:
        floating.length > 0
          ? `${floating.length} caption(s) not aligned to a still: ${floating.slice(0, 3).join(', ')}`
          : `${captions.length} caption(s) all on cards`,
      ...(floating.length > 0
        ? { fix: 'A caption over footage is a subtitle, not a title card - intended, or a timing slip?' }
        : {}),
    });
  }

  /* ---------------------------------------------------------------- audio */

  const wantsMusic = Boolean(edit.music?.file ?? audio.musicFile);
  const musicGenerated = music.source === 'generated';
  const musicOnDisk = wantsMusic
    ? existsSync(join(p.root, edit.music?.file ?? audio.musicFile ?? ''))
    : false;
  add({
    layer: 'audio',
    name: 'Music is either generated at run time or already on disk',
    status: !wantsMusic ? 'pass' : musicOnDisk || musicGenerated ? 'pass' : 'blocker',
    detail: !wantsMusic
      ? 'no music track planned'
      : musicOnDisk
        ? 'music file present'
        : musicGenerated
          ? 'planned as generated - the file is made at audio-finalize, after the look gate'
          : 'edit references a music file that does not exist and is not planned as generated',
    ...(wantsMusic && !musicOnDisk && !musicGenerated
      ? { fix: 'Set music.json source to "generated" with a generationPrompt, or put the file in place.' }
      : {}),
  });

  const sfx = audio.sfx ?? [];
  const sfxOrphans = sfx
    .filter((s) => s.shotId && !editItems.some((i) => i.shotId === s.shotId))
    .map((s) => s.shotId!);
  add({
    layer: 'audio',
    name: 'Every SFX cue lands on a real timeline item',
    status: sfxOrphans.length > 0 ? 'blocker' : 'pass',
    detail:
      sfxOrphans.length > 0
        ? `${sfxOrphans.length} cue(s) reference a shot not in the edit: ${sfxOrphans.slice(0, 5).join(', ')}`
        : `${sfx.length} cue(s)`,
    ...(sfxOrphans.length > 0 ? { fix: 'Point the cue at a shot that exists, or remove it.' } : {}),
  });

  if (audio.narration) {
    add({
      layer: 'audio',
      name: 'Narration has a script',
      status: audio.narration.script ? 'pass' : 'blocker',
      detail: audio.narration.script ? 'script written' : 'narration planned with no script',
    });
  }

  /* ----------------------------------------------------------- references */

  const character = countLive(p.referenceCategory('character'));
  const environment = countLive(p.referenceCategory('environment'));
  const style = countLive(p.referenceCategory('style'));

  // A shot showing any part of a person needs the pack - hands and sleeves
  // included. Only the author knows which those are, so this checks that the
  // pack exists at all when the storyboard attaches it anywhere.
  const usesCharacter = frames.some((f) =>
    // referenceImages is on the frame; read defensively since this file
    // tolerates partially-written plans.
    JSON.stringify(f).includes('references/character/'),
  );
  add({
    layer: 'references',
    name: 'Character pack exists when shots reference it',
    status: usesCharacter && character === 0 ? 'blocker' : 'pass',
    detail: usesCharacter
      ? `${character} pack image(s)`
      : 'no shot references a character pack',
    ...(usesCharacter && character === 0
      ? { fix: 'Generate the six-image pack from ONE turnaround sheet - see verify-realism rule 1.' }
      : {}),
  });

  add({
    layer: 'references',
    name: 'Environment and style sheets exist',
    status: environment > 0 && style > 0 ? 'pass' : 'warn',
    detail: `${environment} environment, ${style} style`,
    ...(environment === 0 || style === 0
      ? {
          fix:
            'Without them each shot re-describes the world in text and the model reinvents it - ' +
            'that is how a winter forest came back with summer ferns.',
        }
      : {}),
  });

  /* ------------------------------------------------------- cost / contract */

  add({
    layer: 'cost',
    name: 'Cost gate approved',
    status: state.gates.cost.status === 'approved' ? 'pass' : 'blocker',
    detail: `gate-cost is ${state.gates.cost.status}`,
    ...(state.gates.cost.status !== 'approved'
      ? { fix: `npm run cost -- ${project}` }
      : {}),
  });

  const planRaw = readJsonIfExists<unknown>(p.plan, null);
  const planParsed = planRaw === null ? null : PlanSchema.safeParse(planRaw);
  add({
    layer: 'contract',
    name: 'plan.json exists and is valid',
    status: planParsed?.success ? 'pass' : 'blocker',
    detail:
      planRaw === null
        ? 'missing - /run-video has no single file to read'
        : planParsed?.success
          ? 'valid'
          : `invalid: ${planParsed?.error.issues[0]?.message ?? 'unknown'}`,
    ...(planParsed?.success
      ? {}
      : { fix: `Write plan.json, then: npm run plan:contract -- ${project}` }),
  });

  const blockers = checks.filter((c) => c.status === 'blocker').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;

  return { project, checks, blockers, warnings, ready: blockers === 0 };
}

const ICON = { pass: '✅', warn: '⚠️ ', blocker: '❌' } as const;

export function formatReadiness(r: ReadinessResult): string {
  const out: string[] = [];
  const LAYERS: ReadinessLayer[] = [
    'artifacts', 'shots', 'frames', 'stills', 'edit', 'audio', 'references', 'cost', 'contract',
  ];

  out.push('', `  Plan readiness - ${r.project}`, '');
  for (const layer of LAYERS) {
    const group = r.checks.filter((c) => c.layer === layer);
    if (group.length === 0) continue;
    out.push(`  ${layer.toUpperCase()}`);
    for (const c of group) {
      out.push(`    ${ICON[c.status]} ${c.name}`);
      out.push(`        ${c.detail}`);
      if (c.fix) out.push(`        → ${c.fix}`);
    }
    out.push('');
  }

  out.push(
    r.ready
      ? `  READY - ${r.warnings} warning(s). Nothing blocks /run-video.`
      : `  NOT READY - ${r.blockers} blocker(s), ${r.warnings} warning(s).`,
  );
  out.push('');
  return out.join('\n');
}
