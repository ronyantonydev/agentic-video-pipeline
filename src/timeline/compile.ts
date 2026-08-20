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
const TRACK = { video: 0, overlay: 1, captions: 2, music: 3 } as const;

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

  for (const item of plan.items) {
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

    if (item.isStill) {
      stillCount += 1;
      elements.push(stillElement(item, src, width, height));
    } else {
      elements.push(videoElement(item, src));
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
      ),
    );
  } else if (music) {
    warnings.push(`music file not found: ${music}`);
  }

  const html = document({
    title: opts.title ?? opts.projectName,
    width,
    height,
    fps,
    durationSeconds: plan.totalDurationSeconds,
    body: elements.join('\n'),
    fadeInSeconds: plan.music.fadeInSeconds,
    fadeOutSeconds: plan.music.fadeOutSeconds,
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

function videoElement(item: TimelineItem, src: string): string {
  // speedFactor > 1 plays faster, so the source must supply proportionally
  // more footage than the screen time it occupies.
  const attrs = [
    // id is mandatory on media: without it the renderer cannot discover the
    // element and the clip renders FROZEN.
    `id="clip-${item.shotId}"`,
    `class="clip shot"`,
    `data-shot-id="${item.shotId}"`,
    `data-start="${round3(item.startSeconds)}"`,
    `data-duration="${round3(item.screenDurationSeconds)}"`,
    `data-track-index="${TRACK.video}"`,
    `data-has-audio="true"`,
    `data-volume="1"`,
    `src="${escapeAttr(src)}"`,
    item.speedFactor !== 1 ? `data-playback-rate="${item.speedFactor}"` : '',
    // No `muted` attribute: combined with data-has-audio it silences the clip.
    'playsinline',
  ].filter(Boolean);

  return `  <video ${attrs.join(' ')}></video>`;
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
): string {
  const kb = item.kenBurns;
  const from = kb?.startScale ?? 1;
  const to = kb?.endScale ?? 1.08;
  const id = `still-${item.shotId}`;

  return [
    `  <div class="clip still" id="${id}"`,
    `       data-shot-id="${item.shotId}"`,
    `       data-start="${round3(item.startSeconds)}"`,
    `       data-duration="${round3(item.screenDurationSeconds)}"`,
    `       data-track-index="${TRACK.video}"`,
    `       style="width:${width}px;height:${height}px;overflow:hidden">`,
    `    <img src="${escapeAttr(src)}" alt=""`,
    `         style="width:100%;height:100%;object-fit:cover;`,
    `                animation:kb-${item.shotId} ${round3(item.screenDurationSeconds)}s linear both">`,
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

function audioElement(src: string, duration: number, gainDb: number): string {
  // HyperFrames takes linear volume; the plan carries dB.
  const volume = Math.min(1, Math.max(0, 10 ** (gainDb / 20)));
  return [
    `  <audio class="clip music"`,
    `         data-start="0"`,
    `         data-duration="${round3(duration)}"`,
    `         data-track-index="${TRACK.music}"`,
    `         data-volume="${volume.toFixed(3)}"`,
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
     data-start="0"
     data-no-timeline
     data-width="${width}"
     data-height="${height}"
     data-duration="${round3(durationSeconds)}">
${args.body}
${fades}
</div>
</body>
</html>
`;
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
