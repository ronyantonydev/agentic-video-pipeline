/**
 * Canonical project paths. Architecture section 33.
 *
 * Every path in the codebase resolves through here so the layout is defined
 * once rather than string-concatenated at each call site.
 */

import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Resolved per call rather than captured at module load: the working
 * directory can legitimately differ from where this module was imported
 * (tests, and `--resume` invoked from a subdirectory).
 */
export function projectsRoot(): string {
  return resolve(process.cwd(), 'projects');
}

export function projectDir(project: string): string {
  return join(projectsRoot(), project);
}

export function paths(project: string) {
  // Recomputed on every call - see projectsRoot().
  const root = projectDir(project);
  return {
    root,
    idea: join(root, 'idea.md'),
    state: join(root, 'state.json'),
    manifest: join(root, 'manifest.json'),

    planning: join(root, 'planning'),
    planningFile: (name: string) => join(root, 'planning', name),

    references: join(root, 'references'),
    referenceCategory: (c: 'character' | 'environment' | 'props' | 'style' | 'progression') =>
      join(root, 'references', c),

    storyboard: join(root, 'storyboard'),
    contactSheet: join(root, 'storyboard', 'contact-sheet.png'),
    storyboardFrames: join(root, 'storyboard', 'frames'),

    shots: join(root, 'shots'),
    shotDir: (shotId: string) => join(root, 'shots', shotId),
    shotFile: (shotId: string, file: string) => join(root, 'shots', shotId, file),

    stills: join(root, 'stills'),
    audio: join(root, 'audio'),
    checkpoints: join(root, 'checkpoints'),
    logs: join(root, 'logs'),

    reports: join(root, 'reports'),
    costEstimate: join(root, 'reports', 'cost-estimate.md'),
    cost: join(root, 'reports', 'cost.md'),
    qaReport: join(root, 'reports', 'qa-report.json'),

    output: join(root, 'output'),
    finalVideo: join(root, 'output', 'final.mp4'),
    thumbnail: join(root, 'output', 'thumbnail.png'),
  };
}

export type ProjectPaths = ReturnType<typeof paths>;

/** Create the full directory skeleton for a project. Idempotent. */
export function ensureProjectDirs(project: string): ProjectPaths {
  const p = paths(project);
  const dirs = [
    p.root,
    p.planning,
    p.references,
    p.referenceCategory('character'),
    p.referenceCategory('environment'),
    p.referenceCategory('props'),
    p.referenceCategory('style'),
    p.referenceCategory('progression'),
    p.storyboard,
    p.storyboardFrames,
    p.shots,
    p.stills,
    p.audio,
    p.checkpoints,
    p.logs,
    p.reports,
    p.output,
  ];
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  return p;
}

/** kebab-case, filesystem-safe, no traversal. */
export function isValidProjectName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(name);
}
