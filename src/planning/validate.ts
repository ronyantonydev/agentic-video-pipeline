/**
 * Planning artifact validation. Architecture sections 2 and 35.
 *
 * Claude writes the JSON; this validates it. The CLI never generates
 * planning content - that separation is what keeps "Claude plans, code
 * spends" honest.
 */

import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { paths } from '../state/paths.js';
import { ValidationError } from '../util/errors.js';
import { PLANNING_ARTIFACTS, type PlanningArtifactName } from '../schemas/planning.js';

export type ValidationResult<T> = {
  ok: true;
  data: T;
  file: string;
};

/**
 * Read and validate one planning artifact.
 *
 * @throws ValidationError when the file is missing, unparseable, or fails
 *         its schema. This must happen before any paid call (section 35).
 */
export function validateArtifact<K extends PlanningArtifactName>(
  project: string,
  name: K,
): ValidationResult<z.infer<(typeof PLANNING_ARTIFACTS)[K]>> {
  const file = paths(project).planningFile(name);

  if (!existsSync(file)) {
    throw new ValidationError(
      `Missing planning/${name}. Claude must write this file before the stage can run.`,
      name,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ValidationError(
      `planning/${name} is not valid JSON: ${(err as Error).message}`,
      name,
    );
  }

  const schema = PLANNING_ARTIFACTS[name] as z.ZodType<unknown>;
  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new ValidationError(
      `planning/${name} failed validation:\n  ${issues.join('\n  ')}`,
      name,
      issues,
    );
  }

  return {
    ok: true,
    data: parsed.data as z.infer<(typeof PLANNING_ARTIFACTS)[K]>,
    file,
  };
}

/** True when the artifact exists and validates. Never throws. */
export function artifactIsValid(project: string, name: PlanningArtifactName): boolean {
  try {
    validateArtifact(project, name);
    return true;
  } catch {
    return false;
  }
}

export type ArtifactStatus = {
  name: PlanningArtifactName;
  exists: boolean;
  valid: boolean;
  error?: string;
};

/** Status of every planning artifact, for the doctor and gate reports. */
export function surveyArtifacts(project: string): ArtifactStatus[] {
  return (Object.keys(PLANNING_ARTIFACTS) as PlanningArtifactName[]).map((name) => {
    const file = paths(project).planningFile(name);
    if (!existsSync(file)) return { name, exists: false, valid: false };
    try {
      validateArtifact(project, name);
      return { name, exists: true, valid: true };
    } catch (err) {
      return { name, exists: true, valid: false, error: (err as Error).message };
    }
  });
}

/**
 * Cross-artifact consistency. Individually valid files can still disagree -
 * an edit plan referencing a shot that the shotlist does not contain, for
 * instance, would fail only at generation time without this.
 */
export function validateCrossReferences(project: string): string[] {
  const problems: string[] = [];

  const shotlist = artifactIsValid(project, 'shotlist.json')
    ? validateArtifact(project, 'shotlist.json').data
    : null;
  if (!shotlist) return problems;

  const shotIds = new Set(shotlist.shots.map((s) => s.id));

  if (artifactIsValid(project, 'storyboard.json')) {
    for (const frame of validateArtifact(project, 'storyboard.json').data.frames) {
      if (!shotIds.has(frame.shotId)) {
        problems.push(`storyboard references unknown shot ${frame.shotId}`);
      }
    }
  }

  if (artifactIsValid(project, 'edit-plan.json')) {
    const plan = validateArtifact(project, 'edit-plan.json').data;
    for (const item of plan.items) {
      if (!shotIds.has(item.shotId)) {
        problems.push(`edit plan references unknown shot ${item.shotId}`);
      }
    }
    const planned = new Set(plan.items.map((i) => i.shotId));
    for (const id of shotIds) {
      if (!planned.has(id)) problems.push(`shot ${id} never appears in the edit plan`);
    }
  }

  if (artifactIsValid(project, 'generation-plan.json')) {
    for (const item of validateArtifact(project, 'generation-plan.json').data.items) {
      if (!shotIds.has(item.shotId)) {
        problems.push(`generation plan references unknown shot ${item.shotId}`);
      }
    }
  }

  return problems;
}
