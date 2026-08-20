/**
 * state.json read/write.
 *
 * Every mutation validates before it touches disk, and every write is atomic.
 * The invariant that matters most: spent + reserved never exceeds the budget
 * ceiling, enforced by the schema itself.
 */

import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeJsonAtomic } from '../util/atomic.js';
import { paths } from './paths.js';
import { ValidationError } from '../util/errors.js';
import {
  StateSchema,
  type State,
  type StageName,
  stageIndex,
} from '../schemas/state.js';

export function stateExists(project: string): boolean {
  return existsSync(paths(project).state);
}

export function readState(project: string): State {
  const file = paths(project).state;
  if (!existsSync(file)) {
    throw new ValidationError(`No state.json for project "${project}"`, 'state.json');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ValidationError(
      `state.json is not valid JSON (${(err as Error).message}). ` +
        `Recover from projects/${project}/checkpoints/ if available.`,
      'state.json',
    );
  }

  const parsed = StateSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ValidationError(
      `state.json failed validation:\n  ${issues.join('\n  ')}`,
      'state.json',
      issues,
    );
  }
  return parsed.data;
}

export function writeState(project: string, state: State): State {
  const next: State = { ...state, updatedAt: new Date().toISOString() };

  const parsed = StateSchema.safeParse(next);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    // Refusing to persist invalid state is the point: a corrupt state file
    // breaks resume, which is the whole crash-safety story.
    throw new ValidationError(
      `Refusing to write invalid state.json:\n  ${issues.join('\n  ')}`,
      'state.json',
      issues,
    );
  }

  writeJsonAtomic(paths(project).state, parsed.data);
  return parsed.data;
}

/** Read, transform, validate, write. The only supported mutation path. */
export function updateState(project: string, fn: (s: State) => State): State {
  return writeState(project, fn(readState(project)));
}

/**
 * Advance to `stage`, recording the previous one as complete.
 * Moving backwards is allowed (retries) but never silently loses history.
 */
export function advanceStage(project: string, stage: StageName): State {
  return updateState(project, (s) => {
    const completed = new Set(s.completedStages);
    if (stageIndex(stage) > stageIndex(s.stage)) completed.add(s.stage);
    return { ...s, stage, completedStages: [...completed] };
  });
}

export function addWarning(project: string, warning: string): State {
  return updateState(project, (s) =>
    s.warnings.includes(warning) ? s : { ...s, warnings: [...s.warnings, warning] },
  );
}

export function setShotStatus(
  project: string,
  shotId: string,
  status: State['shots'][string]['status'],
  extra: Partial<State['shots'][string]> = {},
): State {
  return updateState(project, (s) => ({
    ...s,
    shots: {
      ...s.shots,
      [shotId]: {
        attempts: s.shots[shotId]?.attempts ?? 0,
        ...s.shots[shotId],
        ...extra,
        status,
      },
    },
  }));
}
