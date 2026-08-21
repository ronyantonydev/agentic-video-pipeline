import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReadiness } from '../src/planning/readiness.js';
import { writeState } from '../src/state/store.js';
import { ensureProjectDirs, paths } from '../src/state/paths.js';
import { emptyState } from '../src/schemas/state.js';

const SETTINGS = { width: 1920, height: 1080, fps: 30, colorspace: 'bt709', aspectRatio: '16:9' };
const PROJECT = 'ready-test';

let cwd: string;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'avp-ready-'));
  cwd = process.cwd();
  process.chdir(tmp);
  ensureProjectDirs(PROJECT);
  writeState(PROJECT, emptyState({
    projectName: PROJECT, idea: 'a shop closing', mode: 'full',
    maxBudgetUSD: 40, projectSettings: SETTINGS,
  }));
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
});

function writePlanning(name: string, data: unknown): void {
  mkdirSync(paths(PROJECT).planning, { recursive: true });
  writeFileSync(paths(PROJECT).planningFile(name), JSON.stringify(data));
}

function find(project: string, name: string) {
  return checkReadiness(project).checks.find((c) => c.name === name)!;
}

describe('readiness - stills', () => {
  // The hole this file was written for: ten title cards planned with text and
  // timing but no source image. compileComposition resolves a still to
  // shots/<id>/start.png and THROWS, so the render dies rather than gapping.
  it('blocks a still with no image to render', () => {
    writePlanning('edit-plan.json', {
      totalDurationSeconds: 8,
      items: [
        { shotId: 'shot_001', startSeconds: 0, screenDurationSeconds: 5,
          motionSeconds: 5, speedFactor: 1, transitionIn: 'cut', transitionOut: 'cut', isStill: false },
        { shotId: 'shot_101', startSeconds: 5, screenDurationSeconds: 3,
          motionSeconds: 0, speedFactor: 1, transitionIn: 'cut', transitionOut: 'cut', isStill: true },
      ],
      music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
      captions: [],
    });

    const check = find(PROJECT, 'Every still has an image to render');
    expect(check.status).toBe('blocker');
    expect(check.fix).toMatch(/THROWS/);
  });

  it('blocks a still that reuses a video shot id', () => {
    // Both would resolve to shots/shot_001/, so the card picks up the clip.
    writePlanning('edit-plan.json', {
      totalDurationSeconds: 8,
      items: [
        { shotId: 'shot_001', startSeconds: 0, screenDurationSeconds: 5,
          motionSeconds: 5, speedFactor: 1, transitionIn: 'cut', transitionOut: 'cut', isStill: false },
        { shotId: 'shot_001', startSeconds: 5, screenDurationSeconds: 3,
          motionSeconds: 0, speedFactor: 1, transitionIn: 'cut', transitionOut: 'cut', isStill: true },
      ],
      music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
      captions: [],
    });

    const check = find(PROJECT, 'Stills have their own ids');
    expect(check.status).toBe('blocker');
    expect(check.detail).toMatch(/same shots/i);
  });

  it('passes once the still has its own id and an image', () => {
    writePlanning('edit-plan.json', {
      totalDurationSeconds: 8,
      items: [
        { shotId: 'shot_001', startSeconds: 0, screenDurationSeconds: 5,
          motionSeconds: 5, speedFactor: 1, transitionIn: 'cut', transitionOut: 'cut', isStill: false },
        { shotId: 'shot_101', startSeconds: 5, screenDurationSeconds: 3,
          motionSeconds: 0, speedFactor: 1, transitionIn: 'cut', transitionOut: 'cut', isStill: true },
      ],
      music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
      captions: [],
    });
    mkdirSync(paths(PROJECT).stills, { recursive: true });
    writeFileSync(join(paths(PROJECT).stills, 'shot_101.png'), 'x');

    expect(find(PROJECT, 'Stills have their own ids').status).toBe('pass');
    expect(find(PROJECT, 'Every still has an image to render').status).toBe('pass');
  });
});

describe('readiness - shots and frames', () => {
  it('blocks a timeline item that will never be generated', () => {
    writePlanning('edit-plan.json', {
      totalDurationSeconds: 5,
      items: [{ shotId: 'shot_009', startSeconds: 0, screenDurationSeconds: 5,
        motionSeconds: 5, speedFactor: 1, transitionIn: 'cut', transitionOut: 'cut', isStill: false }],
      music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
      captions: [],
    });
    writePlanning('generation-plan.json', { items: [] });

    const check = find(PROJECT, 'Every video item in the edit has a generation plan entry');
    expect(check.status).toBe('blocker');
    expect(check.detail).toMatch(/shot_009/);
  });

  it('blocks when a shot is told to use a frame that does not exist', () => {
    // The prompt existing is not the same as the image existing - the
    // generator would be handed a path to nothing.
    writePlanning('generation-plan.json', {
      items: [{
        shotId: 'shot_001', modelId: 'seedance_2_0_mini', requiredSeconds: 5,
        billableSeconds: 5, prompt: 'p', aspectRatio: '16:9',
        usesStartFrame: true, usesEndFrame: false, nativeAudio: false, settings: {},
      }],
    });

    const check = find(PROJECT, 'Every planned frame exists on disk');
    expect(check.status).toBe('blocker');
    expect(check.detail).toMatch(/shot_001-start/);
  });

  it('does not count a composed still as an un-framed shot', () => {
    // A title card never goes near the video model, so demanding a frame
    // prompt for it reports a gap that does not exist.
    writePlanning('generation-plan.json', {
      items: [{
        shotId: 'shot_001', modelId: 'seedance_2_0_mini', requiredSeconds: 5,
        billableSeconds: 5, prompt: 'p', aspectRatio: '16:9',
        usesStartFrame: false, usesEndFrame: false, nativeAudio: false, settings: {},
      }],
    });
    writePlanning('storyboard.json', {
      frames: [
        { shotId: 'shot_001', description: 'd', imagePrompt: 'p',
          startFramePrompt: 's', endFramePrompt: 'e', referenceImages: [] },
        { shotId: 'shot_101', description: 'card', imagePrompt: 'p', referenceImages: [] },
      ],
    });

    const check = find(PROJECT, 'Frame prompts written for every generated shot');
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/1 composed still/);
  });
});

describe('readiness - audio', () => {
  it('accepts music that is generated after the gate', () => {
    // The file legitimately does not exist yet: audio-finalize runs later.
    writePlanning('music.json', {
      mood: 'm', genre: 'g', bpm: 60, energyCurve: 'steady',
      source: 'generated', generationPrompt: 'p', durationSeconds: 10,
    });
    writePlanning('audio-plan.json', { musicFile: 'audio/music.mp3', useNativeVideoAudio: false, sfx: [] });

    const check = find(PROJECT, 'Music is either generated at run time or already on disk');
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/audio-finalize/);
  });

  it('blocks music referenced from a library that is not there', () => {
    writePlanning('music.json', {
      mood: 'm', genre: 'g', bpm: 60, energyCurve: 'steady',
      source: 'library', durationSeconds: 10,
    });
    writePlanning('audio-plan.json', { musicFile: 'audio/missing.mp3', useNativeVideoAudio: false, sfx: [] });

    expect(find(PROJECT, 'Music is either generated at run time or already on disk').status)
      .toBe('blocker');
  });

  it('blocks an SFX cue pointing at a shot not in the edit', () => {
    writePlanning('edit-plan.json', {
      totalDurationSeconds: 5,
      items: [{ shotId: 'shot_001', startSeconds: 0, screenDurationSeconds: 5,
        motionSeconds: 5, speedFactor: 1, transitionIn: 'cut', transitionOut: 'cut', isStill: false }],
      music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
      captions: [],
    });
    writePlanning('audio-plan.json', {
      useNativeVideoAudio: false,
      sfx: [{ shotId: 'shot_099', description: 'a clang', startSeconds: 0, gainDb: -14, source: 'generated' }],
    });

    const check = find(PROJECT, 'Every SFX cue lands on a real timeline item');
    expect(check.status).toBe('blocker');
    expect(check.detail).toMatch(/shot_099/);
  });
});

describe('readiness - contract and gates', () => {
  it('blocks a missing plan.json', () => {
    expect(find(PROJECT, 'plan.json exists and is valid').status).toBe('blocker');
  });

  it('blocks an unapproved cost gate', () => {
    expect(find(PROJECT, 'Cost gate approved').status).toBe('blocker');
  });

  it('reports not-ready while any blocker stands', () => {
    const r = checkReadiness(PROJECT);
    expect(r.ready).toBe(false);
    expect(r.blockers).toBeGreaterThan(0);
    // Every blocker must carry its fix - a finding without one moves the
    // confusion rather than removing it.
    for (const c of r.checks.filter((x) => x.status === 'blocker')) {
      expect(c.fix, `${c.name} has no fix`).toBeTruthy();
    }
  });
});

describe('readiness - edit / HyperFrames layer', () => {
  const clip = (id: string, start: number, dur: number, extra = {}) => ({
    shotId: id, startSeconds: start, screenDurationSeconds: dur,
    motionSeconds: dur, speedFactor: 1,
    transitionIn: 'cut', transitionOut: 'cut', isStill: false, ...extra,
  });

  it('blocks a transition the compiler cannot render', () => {
    // compileComposition only WARNS about these - and it warns at render
    // time, after every clip has been paid for.
    writePlanning('edit-plan.json', {
      totalDurationSeconds: 10,
      items: [
        clip('shot_001', 0, 5, { transitionOut: 'star-wipe' }),
        clip('shot_002', 5, 5),
      ],
      music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
      captions: [],
    });

    const check = find(PROJECT, 'Every transition is one the compiler can render');
    expect(check.status).toBe('blocker');
    expect(check.detail).toMatch(/star-wipe/);
  });

  it('blocks a gap in the timeline', () => {
    // Two seconds of black nobody planned.
    writePlanning('edit-plan.json', {
      totalDurationSeconds: 12,
      items: [clip('shot_001', 0, 5), clip('shot_002', 7, 5)],
      music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
      captions: [],
    });

    const check = find(PROJECT, 'Timeline is continuous - no gaps, no overlaps');
    expect(check.status).toBe('blocker');
    expect(check.detail).toMatch(/gap/);
  });

  it('blocks two clips claiming the same second', () => {
    writePlanning('edit-plan.json', {
      totalDurationSeconds: 8,
      items: [clip('shot_001', 0, 5), clip('shot_002', 3, 5)],
      music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
      captions: [],
    });

    const check = find(PROJECT, 'Timeline is continuous - no gaps, no overlaps');
    expect(check.status).toBe('blocker');
    expect(check.detail).toMatch(/overlap/);
  });

  it('blocks a declared runtime that does not match the items', () => {
    // The cost estimate and the music length are both sized off this number.
    writePlanning('edit-plan.json', {
      totalDurationSeconds: 90,
      items: [clip('shot_001', 0, 5)],
      music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
      captions: [],
    });

    const check = find(PROJECT, 'Declared runtime matches the timeline');
    expect(check.status).toBe('blocker');
    expect(check.detail).toMatch(/90/);
  });

  it('warns when a caption floats over footage instead of a card', () => {
    writePlanning('edit-plan.json', {
      totalDurationSeconds: 5,
      items: [clip('shot_001', 0, 5)],
      music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
      captions: [{ text: 'Est. 1985', startSeconds: 2, durationSeconds: 3 }],
    });

    const check = find(PROJECT, 'Every caption sits on a card');
    // A subtitle may be intended, so this informs rather than blocks.
    expect(check.status).toBe('warn');
  });

  it('passes a clean timeline', () => {
    writePlanning('edit-plan.json', {
      totalDurationSeconds: 13,
      items: [
        clip('shot_001', 0, 5, { transitionIn: 'fade' }),
        { shotId: 'shot_101', startSeconds: 5, screenDurationSeconds: 3,
          motionSeconds: 0, speedFactor: 1,
          transitionIn: 'dissolve', transitionOut: 'dissolve', isStill: true },
        clip('shot_002', 8, 5),
      ],
      music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
      captions: [{ text: 'Est. 1985', startSeconds: 5, durationSeconds: 3 }],
    });

    for (const name of [
      'Every transition is one the compiler can render',
      'Timeline is continuous - no gaps, no overlaps',
      'Declared runtime matches the timeline',
      'Every caption sits on a card',
    ]) {
      expect(find(PROJECT, name).status, name).toBe('pass');
    }
  });
});

describe('readiness - motion graphics', () => {
  it('blocks a sped-up clip with too little source footage', () => {
    // 2x over 5s of screen time consumes 10s of footage. A 5s clip runs out
    // halfway and the tail renders frozen or black.
    writePlanning('edit-plan.json', {
      totalDurationSeconds: 5,
      items: [{
        shotId: 'shot_001', startSeconds: 0, screenDurationSeconds: 5,
        motionSeconds: 5, speedFactor: 2,
        transitionIn: 'cut', transitionOut: 'cut', isStill: false,
      }],
      music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
      captions: [],
    });
    writePlanning('generation-plan.json', {
      items: [{
        shotId: 'shot_001', modelId: 'seedance_2_0_mini', requiredSeconds: 5,
        billableSeconds: 5, prompt: 'p', aspectRatio: '16:9',
        usesStartFrame: false, usesEndFrame: false, nativeAudio: false, settings: {},
      }],
    });

    const check = find(PROJECT, 'Sped-up clips have enough source footage');
    expect(check.status).toBe('blocker');
    expect(check.detail).toMatch(/needs 10s/);
  });

  it('passes a speed change the footage covers', () => {
    writePlanning('edit-plan.json', {
      totalDurationSeconds: 4,
      items: [{
        shotId: 'shot_001', startSeconds: 0, screenDurationSeconds: 4,
        motionSeconds: 4, speedFactor: 2,
        transitionIn: 'cut', transitionOut: 'cut', isStill: false,
      }],
      music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
      captions: [],
    });
    writePlanning('generation-plan.json', {
      items: [{
        shotId: 'shot_001', modelId: 'seedance_2_0_mini', requiredSeconds: 8,
        billableSeconds: 8, prompt: 'p', aspectRatio: '16:9',
        usesStartFrame: false, usesEndFrame: false, nativeAudio: false, settings: {},
      }],
    });

    expect(find(PROJECT, 'Sped-up clips have enough source footage').status).toBe('pass');
  });

});

describe('readiness - the checklist is the contract', () => {
  it('emits every documented check, in the documented order', () => {
    // The skill lists these nineteen as the definition of done. A check
    // renamed or dropped here silently invalidates that list, so the two are
    // pinned together.
    const EXPECTED = [
      'All planning artifacts present and valid',
      'Every video item in the edit has a generation plan entry',
      'Every shot names a model',
      'Frame prompts written for every generated shot',
      'Every planned frame exists on disk',
      'Stills have their own ids',
      'Every still has an image to render',
      'Every transition is one the compiler can render',
      'Timeline is continuous - no gaps, no overlaps',
      'Declared runtime matches the timeline',
      'Every caption sits on a card',
      'Music is either generated at run time or already on disk',
      'Every SFX cue lands on a real timeline item',
      'Character pack exists when shots reference it',
      'Environment and style sheets exist',
      'Cost gate approved',
      'plan.json exists and is valid',
    ];

    // A full plan with one still, so the conditional still checks fire.
    writePlanning('edit-plan.json', {
      totalDurationSeconds: 8,
      items: [
        { shotId: 'shot_001', startSeconds: 0, screenDurationSeconds: 5,
          motionSeconds: 5, speedFactor: 1, transitionIn: 'cut', transitionOut: 'cut', isStill: false },
        { shotId: 'shot_101', startSeconds: 5, screenDurationSeconds: 3,
          motionSeconds: 0, speedFactor: 1, transitionIn: 'cut', transitionOut: 'cut', isStill: true },
      ],
      music: { gainDb: -12, fadeInSeconds: 0, fadeOutSeconds: 0 },
      captions: [{ text: 'Est. 1985', startSeconds: 5, durationSeconds: 3 }],
    });

    const names = checkReadiness(PROJECT).checks.map((c) => c.name);
    expect(names).toEqual(EXPECTED);
  });

  it('groups every check under one of the nine documented layers', () => {
    const LAYERS = [
      'artifacts', 'shots', 'frames', 'stills', 'edit',
      'audio', 'references', 'cost', 'contract',
    ];
    for (const c of checkReadiness(PROJECT).checks) {
      expect(LAYERS, `${c.name} has an undocumented layer`).toContain(c.layer);
    }
  });
});
