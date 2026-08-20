/**
 * Compile edit-plan.json into a HyperFrames composition.
 * Architecture section 27.
 *
 * HyperFrames is the creative layer: cuts, transitions, Ken Burns, speed,
 * captions, audio mixing. FFmpeg stays the technical layer beneath it.
 *
 * The composition is a plain HTML document. Timing lives in data attributes
 * (verified against `hyperframes docs data-attributes`, v0.8.4):
 *   data-start, data-duration, data-track-index, data-media-start,
 *   data-volume, data-has-audio, and class="clip" for lifecycle management.
 */

import { join, extname, resolve } from 'node:path';
import { existsSync, mkdirSync, symlinkSync, copyFileSync, rmSync } from 'node:fs';
import { writeFileAtomic } from '../util/atomic.js';
import { paths } from '../state/paths.js';
import { ValidationError } from '../util/errors.js';
import type { EditPlan, TimelineItem } from '../schemas/planning.js';
import type { ProjectDefaults } from '../config/loader.js';

export type CompileOptions = {
  projectName: string;
  defaults: ProjectDefaults;
  /**
   * Directory for the HyperFrames project. The CLI operates on a project
   * folder containing hyperframes.json and index.html, not a bare HTML file -
   * pointing it at a single file fails with "Not a directory".
   */
  outputDir: string;
  musicFile?: string;
  title?: string;
};

export type CompileResult = {
  /** The project directory, which is what the CLI takes. */
  projectDir: string;
  compositionPath: string;
  totalDurationSeconds: number;
  clipCount: number;
  stillCount: number;
  warnings: string[];
};

/** Tracks are z-ordered: higher index draws on top. */
const TRACK = { video: 0, videoAlt: 1, overlay: 2, captions: 3, music: 4 } as const;

/**
 * How long a dissolve runs, in seconds.
 *
 * Fixed rather than per-item: the edit plan records WHICH transition, not how
 * long, and inventing a per-clip duration would need a schema change. Half a
 * second is the conventional default and reads on a 5-second shot without
 * eating it.
 */
const TRANSITION_SECONDS = 0.5;

/** Transitions that dissolve between two shots, as opposed to a hard cut. */
const DISSOLVE = new Set(['crossfade', 'dissolve', 'fade']);

/**
 * Does this cut need a dissolve?
 *
 * Either side can ask for it: shot A's `transitionOut` or shot B's
 * `transitionIn`. Honouring both means an editor gets what they asked for
 * without having to set the same value twice.
 */
function dissolvesInto(a: TimelineItem, b: TimelineItem): boolean {
  return DISSOLVE.has(a.transitionOut) || DISSOLVE.has(b.transitionIn);
}

export function compileComposition(
  plan: EditPlan,
  opts: CompileOptions,
): CompileResult {
  const p = paths(opts.projectName);
  const { width, height, fps } = opts.defaults.video;
  const warnings: string[] = [];
  const compDir = opts.outputDir;
  const compositionPath = join(compDir, 'index.html');
  const assetDir = join(compDir, 'assets');
  mkdirSync(assetDir, { recursive: true });

  const elements: string[] = [];
  let stillCount = 0;

  // Which cuts dissolve. Computed up front because a dissolving clip has to
  // be authored differently: it needs its own track (same-track overlap is
  // invalid in HyperFrames), a wrapper to fade, and a tween.
  const dissolveAfter = plan.items.map((item, i) => {
    const next = plan.items[i + 1];
    return next ? dissolvesInto(item, next) : false;
  });

  // Alternate tracks so two overlapping clips never share one. Only the
  // clips involved in a dissolve need this, but alternating throughout keeps
  // the assignment trivially correct.
  const trackOf: number[] = [];
  let alt = false;
  for (let i = 0; i < plan.items.length; i++) {
    trackOf.push(alt ? TRACK.videoAlt : TRACK.video);
    if (dissolveAfter[i]) alt = !alt;
  }

  /** Tweens for the dissolves, emitted as one paused timeline. */
  const tweens: string[] = [];

  // A transition the compiler does not implement must SAY so. Silently
  // rendering a wipe as a hard cut is the failure mode this whole check
  // exists to prevent: the plan says one thing, the video does another, and
  // nothing anywhere reports the difference.
  const KNOWN = new Set(['cut', ...DISSOLVE]);
  for (const item of plan.items) {
    for (const [side, value] of [
      ['transitionIn', item.transitionIn],
      ['transitionOut', item.transitionOut],
    ] as const) {
      if (!KNOWN.has(value)) {
        warnings.push(
          `${item.shotId}: ${side} "${value}" is not implemented and will ` +
            `render as a hard cut. Supported: ${[...KNOWN].join(', ')}.`,
        );
      }
    }
  }

  for (const [index, item] of plan.items.entries()) {
    const source = item.isStill
      ? firstExisting([
          p.shotFile(item.shotId, 'start.png'),
          p.shotFile(item.shotId, 'end_target.png'),
          p.shotFile(item.shotId, 'qa-frames/frame_01.jpg'),
        ])
      : firstExisting([
          p.shotFile(item.shotId, 'normalized.mp4'),
          p.shotFile(item.shotId, 'original.mp4'),
        ]);

    if (!source) {
      // A missing asset must fail here, not silently render a gap.
      throw new ValidationError(
        `No media found for ${item.shotId}. Expected a normalised clip or, ` +
          `for a still, a start frame.`,
        'edit-plan.json',
      );
    }

    // Link into assets/ and reference root-relative: paths traversing above
    // the project root resolve inconsistently between render and preview.
    const src = linkAsset(assetDir, source, item.shotId);

    // A dissolve extends the OUTGOING clip so it survives under the incoming
    // one for the length of the fade. Without the extra tail the old shot
    // ends before the new one is opaque and the overlap shows black.
    const fadingOut = dissolveAfter[index] === true;
    const fadingIn = index > 0 && dissolveAfter[index - 1] === true;
    const track = trackOf[index]!;
    const extend = fadingOut ? TRANSITION_SECONDS : 0;

    if (item.isStill) {
      stillCount += 1;
      elements.push(stillElement(item, src, width, height, track, extend));
    } else {
      elements.push(videoElement(item, src, track, extend));
    }

    // The fade itself. The incoming clip starts transparent and comes up;
    // the outgoing one goes down over the same window, so the two cross.
    if (fadingIn) {
      const at = round3(item.startSeconds);
      const target = `#wrap-${item.shotId}`;
      tweens.push(`  tl.set('${target}', { autoAlpha: 0 }, 0);`);
      tweens.push(
        `  tl.to('${target}', { autoAlpha: 1, duration: ${TRANSITION_SECONDS} }, ${at});`,
      );
    }
    if (fadingOut) {
      const next = plan.items[index + 1]!;
      const at = round3(next.startSeconds);
      tweens.push(
        `  tl.to('#wrap-${item.shotId}', { autoAlpha: 0, duration: ${TRANSITION_SECONDS} }, ${at});`,
      );
    }
  }

  for (const caption of plan.captions) {
    elements.push(captionElement(caption));
  }

  const music = opts.musicFile ?? plan.music.file;
  if (music && existsSync(music)) {
    elements.push(
      audioElement(
        linkAsset(assetDir, music, 'music'),
        plan.totalDurationSeconds,
        plan.music.gainDb,
        plan.music.fadeInSeconds,
        plan.music.fadeOutSeconds,
      ),
    );
  } else if (music) {
    warnings.push(`music file not found: ${music}`);
  }

  const firstItem = plan.items[0];
  const lastItem = plan.items[plan.items.length - 1];

  const html = document({
    title: opts.title ?? opts.projectName,
    width,
    height,
    fps,
    durationSeconds: plan.totalDurationSeconds,
    body: elements.join('\n'),
    // The picture fade comes from the FIRST and LAST shot's transitions, not
    // from the music envelope. They are different things: a music tail and a
    // fade to black are independently chosen by the editor.
    fadeInSeconds: firstItem?.transitionIn === 'fade' ? TRANSITION_SECONDS : 0,
    fadeOutSeconds: lastItem?.transitionOut === 'fade' ? TRANSITION_SECONDS : 0,
    tweens,
  });

  writeFileAtomic(compositionPath, html);

  // The CLI requires these alongside index.html to recognise a project.
  writeFileAtomic(
    join(compDir, 'hyperframes.json'),
    `${JSON.stringify(
      {
        $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json',
        paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' },
        media: { autoProxy: true },
      },
      null,
      2,
    )}\n`,
  );
  writeFileAtomic(
    join(compDir, 'meta.json'),
    `${JSON.stringify(
      { id: opts.projectName, name: opts.title ?? opts.projectName, createdAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
  );

  return {
    projectDir: compDir,
    compositionPath,
    totalDurationSeconds: plan.totalDurationSeconds,
    clipCount: plan.items.length,
    stillCount,
    warnings,
  };
}

/* --------------------------------------------------------------- elements */

/**
 * @param track   which video track. Dissolving clips alternate, because two
 *                clips overlapping on ONE track is invalid in HyperFrames.
 * @param extend  extra seconds held under the next clip during a dissolve.
 */
function videoElement(
  item: TimelineItem,
  src: string,
  track: number,
  extend: number,
): string {
  // speedFactor > 1 plays faster, so the source must supply proportionally
  // more footage than the screen time it occupies.
  const attrs = [
    // id is mandatory on media: without it the renderer cannot discover the
    // element and the clip renders FROZEN.
    `id="clip-${item.shotId}"`,
    `class="clip shot"`,
    `data-shot-id="${item.shotId}"`,
    `data-start="${round3(item.startSeconds)}"`,
    `data-duration="${round3(item.screenDurationSeconds + extend)}"`,
    `data-track-index="${track}"`,
    `data-has-audio="true"`,
    `data-volume="1"`,
    `src="${escapeAttr(src)}"`,
    item.speedFactor !== 1 ? `data-playback-rate="${item.speedFactor}"` : '',
    // No `muted` attribute: combined with data-has-audio it silences the clip.
    'playsinline',
  ].filter(Boolean);

  // The wrapper is what fades. Tweening the timed clip element itself would
  // fight the framework, which owns .clip visibility.
  return [
    `  <div id="wrap-${item.shotId}" class="inner">`,
    `  <video ${attrs.join(' ')}></video>`,
    `  </div>`,
  ].join('\n');
}

/**
 * A still with a Ken Burns move. Architecture section 17.
 *
 * The move is cosmetic - motion lint deliberately does not count it as real
 * motion, because a panning photograph is exactly the slideshow substitution
 * the lint exists to detect.
 */
function stillElement(
  item: TimelineItem,
  src: string,
  width: number,
  height: number,
  track: number,
  extend: number,
): string {
  const kb = item.kenBurns;
  const from = kb?.startScale ?? 1;
  const to = kb?.endScale ?? 1.08;
  const id = `still-${item.shotId}`;
  const dur = round3(item.screenDurationSeconds + extend);

  return [
    `  <div id="wrap-${item.shotId}" class="inner">`,
    `  <div class="clip still" id="${id}"`,
    `       data-shot-id="${item.shotId}"`,
    `       data-start="${round3(item.startSeconds)}"`,
    `       data-duration="${dur}"`,
    `       data-track-index="${track}"`,
    `       style="width:${width}px;height:${height}px;overflow:hidden">`,
    `    <img src="${escapeAttr(src)}" alt=""`,
    `         style="width:100%;height:100%;object-fit:cover;`,
    `                animation:kb-${item.shotId} ${dur}s linear both">`,
    `  </div>`,
    `  </div>`,
    `  <style>@keyframes kb-${item.shotId}{from{transform:scale(${from})}to{transform:scale(${to})}}</style>`,
  ].join('\n');
}

function captionElement(c: EditPlan['captions'][number]): string {
  return [
    `  <div class="clip caption"`,
    `       data-start="${round3(c.startSeconds)}"`,
    `       data-duration="${round3(c.durationSeconds)}"`,
    `       data-track-index="${TRACK.captions}">${escapeHtml(c.text)}</div>`,
  ].join('\n');
}

/**
 * The music bed, with its fade envelope.
 *
 * `fadeInSeconds`/`fadeOutSeconds` on `plan.music` describe the MUSIC. They
 * were previously passed only to the black overlay, which faded the picture
 * and left the music at a flat gain for the whole runtime - so a plan asking
 * for a two-second music tail got an abrupt cut instead.
 *
 * Volume automation is a clip-local envelope: `t` is seconds from this
 * clip's own start, `v` is linear gain. The peak is the plan's dB converted
 * to linear, so a -28dB bed still peaks at -28dB and merely arrives and
 * leaves smoothly.
 */
function audioElement(
  src: string,
  duration: number,
  gainDb: number,
  fadeInSeconds: number,
  fadeOutSeconds: number,
): string {
  // HyperFrames takes linear volume; the plan carries dB.
  const peak = Math.min(1, Math.max(0, 10 ** (gainDb / 20)));

  // Clamp the fades so they cannot overlap on a short bed, which would make
  // the envelope non-monotonic and the ramp meaningless.
  const fin = Math.max(0, Math.min(fadeInSeconds, duration / 2));
  const fout = Math.max(0, Math.min(fadeOutSeconds, duration / 2));

  const points: Array<{ t: number; v: number }> = [];
  if (fin > 0) {
    points.push({ t: 0, v: 0 }, { t: round3(fin), v: peak });
  } else {
    points.push({ t: 0, v: peak });
  }
  if (fout > 0) {
    points.push({ t: round3(duration - fout), v: peak }, { t: round3(duration), v: 0 });
  } else {
    points.push({ t: round3(duration), v: peak });
  }

  const automation = JSON.stringify({
    version: 1,
    lanes: [{ target: 'volume', points }],
  });

  return [
    `  <audio class="clip music"`,
    `         data-start="0"`,
    `         data-duration="${round3(duration)}"`,
    `         data-track-index="${TRACK.music}"`,
    `         data-volume="${peak.toFixed(3)}"`,
    `         data-automation='${escapeSingleQuoted(automation)}'`,
    `         src="${escapeAttr(src)}"></audio>`,
  ].join('\n');
}

/* --------------------------------------------------------------- document */

function document(args: {
  title: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  body: string;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  tweens: string[];
}): string {
  const { width, height, durationSeconds, fadeInSeconds, fadeOutSeconds } = args;

  // Fades are drawn as an overlay rather than applied per clip, so they read
  // across a cut instead of restarting on each shot.
  const fades =
    fadeInSeconds > 0 || fadeOutSeconds > 0
      ? [
          `  <div id="fade-overlay" class="clip fade" data-start="0" data-duration="${round3(durationSeconds)}"`,
          `       data-track-index="${TRACK.overlay}"></div>`,
        ].join('\n')
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(args.title)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${width}px;
    height: ${height}px;
    background: #000;
    overflow: hidden;
    font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
  }
  #root { position: relative; width: ${width}px; height: ${height}px; }
  .shot, .still {
    position: absolute; inset: 0;
    width: ${width}px; height: ${height}px;
    object-fit: cover;
  }
  /* The fade target. Full-bleed so the clip inside keeps filling the frame. */
  .inner { position: absolute; inset: 0; width: 100%; height: 100%; }
  .caption {
    position: absolute; left: 0; right: 0; bottom: 8%;
    text-align: center; color: #fff;
    font-size: 42px; font-weight: 600;
    text-shadow: 0 2px 12px rgba(0,0,0,.85);
    padding: 0 8%;
  }
  .fade {
    position: absolute; inset: 0; pointer-events: none;
    background: #000;
    animation: fade-seq ${round3(durationSeconds)}s linear both;
  }
  @keyframes fade-seq {
    0%   { opacity: 1 }
    ${pct(fadeInSeconds, durationSeconds)}% { opacity: 0 }
    ${pct(durationSeconds - fadeOutSeconds, durationSeconds)}% { opacity: 0 }
    100% { opacity: 1 }
  }
</style>
</head>
<body>
<div id="root"
     data-composition-id="root"
     data-start="0"${args.tweens.length > 0 ? '' : '\n     data-no-timeline'}
     data-width="${width}"
     data-height="${height}"
     data-duration="${round3(durationSeconds)}">
${args.body}
${fades}
</div>
${timelineScript(args.tweens)}
</body>
</html>
`;
}

/**
 * The one paused timeline HyperFrames requires, or nothing.
 *
 * A composition with no tweens declares `data-no-timeline` instead and skips
 * this entirely - registering an empty timeline would be a lie the runtime
 * has to work around. It appears only when a dissolve needs it.
 */
function timelineScript(tweens: string[]): string {
  if (tweens.length === 0) return '';
  return [
    '<script>',
    '  // Exactly one paused timeline, built synchronously at load, keyed by',
    '  // the root data-composition-id. Seek-safe: every tween is absolutely',
    '  // positioned in composition seconds, so any frame can be rendered',
    '  // directly without replaying what came before.',
    '  const tl = gsap.timeline({ paused: true });',
    ...tweens,
    '  window.__timelines = window.__timelines || {};',
    "  window.__timelines['root'] = tl;",
    '</script>',
  ].join('\n');
}

/* ---------------------------------------------------------------- helpers */

function firstExisting(candidates: string[]): string | null {
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * Link a source file into the project's assets/ directory and return a
 * root-relative path.
 *
 * Compositions are served with the project root as base URL, so a path
 * containing "../" resolves against the wrong root in Studio preview and
 * 404s - the renderer tolerates it, preview does not.
 *
 * A symlink avoids copying gigabytes of video; if the filesystem refuses
 * one, fall back to a copy rather than emitting a broken path.
 */
function linkAsset(assetDir: string, source: string, label: string): string {
  const name = `${label}${extname(source)}`;
  const dest = join(assetDir, name);

  if (existsSync(dest)) rmSync(dest, { force: true });
  try {
    symlinkSync(resolve(source), dest);
  } catch {
    copyFileSync(source, dest);
  }
  return `assets/${name}`;
}

function pct(seconds: number, total: number): string {
  if (total <= 0) return '0';
  return ((Math.max(0, seconds) / total) * 100).toFixed(2);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Escape for a SINGLE-quoted attribute.
 *
 * The automation payload is JSON, which is full of double quotes. Running it
 * through escapeAttr would turn every one into `&quot;` - valid, and the
 * parser does decode it, but it makes the attribute unreadable when
 * debugging a composition by eye. In a single-quoted attribute only `&` and
 * `'` actually need escaping, so double quotes survive intact and the value
 * reads as the JSON it is.
 */
function escapeSingleQuoted(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
