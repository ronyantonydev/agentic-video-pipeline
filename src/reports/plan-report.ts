/**
 * The plan report: one page a human can act on.
 *
 * A finished plan is nine JSON files, a folder of images and a cost estimate.
 * That is complete and unreadable. Someone deciding whether to spend forty
 * credits should not have to open nine files to find out what the machine
 * already knows.
 *
 * So this collects every automatic check that ran, states plainly what
 * passed, and - the part that matters - lists what a human still has to look
 * at, with the file path to open and what to do when it is wrong.
 *
 * Two rules this file exists to enforce:
 *
 * 1. A passing automatic check is never presented as approval. The code can
 *    say an image decodes at the right size; it cannot say it is the right
 *    face, place or moment. Those are listed separately as HUMAN checks and
 *    never marked done.
 *
 * 2. Every problem comes with its fix. A report that says "environment sheet
 *    missing" and stops has moved the confusion rather than removed it.
 *
 * Free: reads files, runs no generation.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { paths } from '../state/paths.js';
import { readState } from '../state/store.js';
import { readReferenceCheck } from '../qa/reference-gate.js';
import { validateAnchor } from '../qa/anchor.js';
import { readJsonIfExists, writeFileAtomic } from '../util/atomic.js';
import { PLANNING_ARTIFACTS, type PlanningArtifactName } from '../schemas/planning.js';

/** One automatic check, already run by code. */
export type CodeCheck = {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
};

/** One thing only a person can judge. Never marked done by code. */
export type HumanCheck = {
  what: string;
  /** Project-relative path to open, or a file to read. */
  where: string;
  lookFor: string;
  ifWrong: string;
};

export type PlanReport = {
  project: string;
  idea: string;
  generatedAt: string;
  codeChecks: CodeCheck[];
  humanChecks: HumanCheck[];
  blockers: string[];
  ready: boolean;
};

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

function listImages(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => IMAGE_RE.test(f)).sort();
}

/** Paths in the report are project-relative so they are short and clickable. */
function rel(project: string, abs: string): string {
  return relative(paths(project).root, abs);
}

/**
 * Collect every check.
 *
 * `now` is injected rather than read from the clock so the report is
 * reproducible in tests.
 */
export async function buildPlanReport(
  project: string,
  now: string = new Date().toISOString(),
): Promise<PlanReport> {
  const p = paths(project);
  const state = readState(project);
  const codeChecks: CodeCheck[] = [];
  const humanChecks: HumanCheck[] = [];
  const blockers: string[] = [];

  /* ---------------------------------------------------- planning artifacts */

  // Not every schema key is a required file. `audio-plan.json` has a schema
  // and a reader that checks validity before use, but no stage writes one -
  // a video with native audio and no narration never needs it. Reporting it
  // as "missing" sends the user to fix something that is not broken.
  const OPTIONAL: ReadonlySet<string> = new Set(['audio-plan.json']);

  const names = (Object.keys(PLANNING_ARTIFACTS) as PlanningArtifactName[]).filter(
    (n) => !OPTIONAL.has(n),
  );
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const name of names) {
    const file = p.planningFile(name);
    if (!existsSync(file)) {
      missing.push(name);
      continue;
    }
    // Parse and validate rather than trusting the file's existence: an
    // artifact that exists but does not match its schema fails later, at a
    // more expensive moment.
    const raw = readJsonIfExists<unknown>(file, null);
    const parsed = PLANNING_ARTIFACTS[name].safeParse(raw);
    if (!parsed.success) {
      invalid.push(`${name} (${parsed.error.issues[0]?.message ?? 'invalid'})`);
    }
  }

  codeChecks.push({
    name: 'Planning files',
    status: missing.length > 0 ? 'fail' : 'pass',
    detail:
      missing.length > 0
        ? `${names.length - missing.length} of ${names.length} written. Missing: ${missing.join(', ')}`
        : `all ${names.length} written`,
  });

  codeChecks.push({
    name: 'Files are valid',
    status: invalid.length > 0 ? 'fail' : 'pass',
    detail: invalid.length > 0 ? `invalid: ${invalid.join('; ')}` : 'every file matches its schema',
  });

  if (missing.length > 0) {
    blockers.push(
      `${missing.length} planning file(s) missing. Re-run the planning stage that writes them ` +
        `(npm run plan:story / plan:audio / plan:storyboard / plan:edit / plan:generation).`,
    );
  }
  if (invalid.length > 0) {
    blockers.push(
      `${invalid.length} planning file(s) do not match their schema. Fix the file, then re-run ` +
        `its plan stage - a malformed artifact fails later at a more expensive moment.`,
    );
  }

  /* ------------------------------------------------------------ references */

  const refCheck = readReferenceCheck(project);
  const character = listImages(p.referenceCategory('character'));
  const environment = listImages(p.referenceCategory('environment'));
  const style = listImages(p.referenceCategory('style'));
  const props = listImages(p.referenceCategory('props'));

  if (refCheck) {
    codeChecks.push({
      name: 'Reference check',
      status: refCheck.pass ? (refCheck.warnings.length > 0 ? 'warn' : 'pass') : 'fail',
      detail: refCheck.pass
        ? `passed${refCheck.warnings.length > 0 ? ` with ${refCheck.warnings.length} warning(s)` : ''}`
        : `blocked: ${refCheck.blockers.join('; ')}`,
    });
    if (!refCheck.pass) {
      blockers.push(`Reference check failed: ${refCheck.blockers.join('; ')}`);
    }
  } else {
    codeChecks.push({
      name: 'Reference check',
      status: 'fail',
      detail: 'never run',
    });
    blockers.push(`Reference check never ran. Run: npm run refcheck -- ${project}`);
  }

  // The drift score is recorded, never presented as a verdict. Measured on
  // this project's own assets: a photograph of a stool scored 0.50 against a
  // character master, above two of five genuine samples.
  if (refCheck?.driftTest) {
    codeChecks.push({
      name: 'Identity drift score',
      status: 'warn',
      detail:
        `mean ${refCheck.driftTest.meanSimilarity.toFixed(2)} - ADVISORY ONLY. This number ` +
        `cannot tell a face from a prop, so it is not evidence either way.`,
    });
  }

  /* ------------------------------------------------- images, one at a time */

  const imageGroups: Array<{
    label: string;
    files: string[];
    dir: string;
    lookFor: string;
    ifWrong: string;
  }> = [
    {
      label: 'Character pack',
      files: character,
      dir: p.referenceCategory('character'),
      lookFor:
        'The SAME person in every image - same face, same wardrobe, same age and build. ' +
        'Six angles: three face, three body.',
      ifWrong:
        'Regenerate the pack in ONE call showing all six angles. Six separate calls give six ' +
        'near-strangers, because one reference will not hold a face across calls.',
    },
    {
      label: 'Environment sheet',
      files: environment,
      dir: p.referenceCategory('environment'),
      lookFor:
        'The location your shots describe, in the light continuity.json states ' +
        '(check time of day and weather).',
      ifWrong:
        'Fix the environment description in planning/continuity.json FIRST, then regenerate. ' +
        'A plate that faithfully renders a wrong description will regenerate just as wrong.',
    },
    {
      label: 'Style sheet',
      files: style,
      dir: p.referenceCategory('style'),
      lookFor: 'The palette and grade every shot will inherit. No golden hour if you asked for overcast.',
      ifWrong: 'Fix lighting/colorPalette in planning/continuity.json, then regenerate this plate.',
    },
    {
      label: 'Prop sheets',
      files: props,
      dir: p.referenceCategory('props'),
      lookFor: 'Props sitting in a real setting, not floating on a studio backdrop.',
      ifWrong: 'Re-prompt the prop in its real context ("on the workbench", not "on white").',
    },
  ];

  for (const g of imageGroups) {
    if (g.files.length === 0) continue;
    humanChecks.push({
      what: `${g.label} (${g.files.length} image${g.files.length === 1 ? '' : 's'})`,
      where: g.files.map((f) => rel(project, join(g.dir, f))).join('\n    '),
      lookFor: g.lookFor,
      ifWrong: g.ifWrong,
    });
  }

  /* --------------------------------------------------------------- anchors */

  // Start and end frames are the highest-leverage images in the project: the
  // model fills in between them, so a bad anchor guarantees a bad clip at
  // roughly 100x the frame's cost.
  const frameDir = p.storyboardFrames;
  const frames = listImages(frameDir);
  if (frames.length > 0) {
    let anchorFails = 0;
    for (const f of frames) {
      const v = await validateAnchor(join(frameDir, f));
      if (!v.pass) anchorFails += 1;
    }
    codeChecks.push({
      name: 'Anchor frames readable',
      status: anchorFails > 0 ? 'fail' : 'pass',
      detail:
        anchorFails > 0
          ? `${anchorFails} of ${frames.length} failed (unreadable, too small, or blank)`
          : `${frames.length} frame(s) decode at usable size`,
    });
    if (anchorFails > 0) {
      blockers.push(`${anchorFails} anchor frame(s) are unusable. Regenerate them before running.`);
    }

    humanChecks.push({
      what: `Start / end frames (${frames.length})`,
      where: frames.map((f) => rel(project, join(frameDir, f))).join('\n    '),
      lookFor:
        'Does each frame show the moment the shot should open on, or land on? And is the END ' +
        'frame of one shot continuous with the START of the next - same light, same place?',
      ifWrong:
        'Regenerate the frame. This is the cheapest fix available: a frame costs ~1 credit and ' +
        'the clip it feeds costs ~12.5. A jump between shots reads as a continuity error.',
    });
  }

  /* --------------------------------------------- references actually wired */

  // An attached reference is what stops the model reinventing the location or
  // the person. Missing attachments are invisible in the images themselves.
  const genPlan = readJsonIfExists<{ items?: Array<{ shotId: string }> } | null>(
    p.planningFile('generation-plan.json'),
    null,
  );
  if (genPlan?.items && genPlan.items.length > 0) {
    humanChecks.push({
      what: `Every shot carries its references (${genPlan.items.length} shots)`,
      where: rel(project, p.planningFile('generation-plan.json')),
      lookFor:
        'Every shot showing a person attaches the character reference - INCLUDING close-ups of ' +
        'hands, boots or sleeves. Every shot attaches the environment sheet.',
      ifWrong:
        'Add the reference and re-run: npm run plan:generation -- ' +
        project +
        '. A hands-only macro generated without it came back with different hands in a ' +
        'different place, 20 credits to redo.',
    });
  }

  /* ----------------------------------------------------------------- gates */

  const look = state.gates.look.status;
  codeChecks.push({
    name: 'Look gate',
    status: look === 'approved' ? 'pass' : look === 'pending' ? 'warn' : 'fail',
    detail:
      look === 'pending'
        ? 'waiting for you - this report is what you are deciding on'
        : look === 'approved'
          ? `approved${state.gates.look.note ? `: ${state.gates.look.note}` : ''}`
          : `${look} - planning did not finish`,
  });

  return {
    project,
    idea: state.idea,
    generatedAt: now,
    codeChecks,
    humanChecks,
    blockers,
    ready: blockers.length === 0,
  };
}

const ICON = { pass: '✅', warn: '⚠️', fail: '❌' } as const;

/** Render the report as markdown a non-expert can act on. */
export function renderPlanReport(r: PlanReport): string {
  const out: string[] = [];

  out.push(`# Plan report — ${r.project}`);
  out.push('');
  out.push(`**Idea:** ${r.idea}`);
  out.push('');

  if (r.blockers.length > 0) {
    out.push(`## ❌ Not ready — ${r.blockers.length} thing(s) to fix`);
    out.push('');
    for (const b of r.blockers) out.push(`- ${b}`);
    out.push('');
    out.push('Fix these first. The checks below still apply once they pass.');
  } else {
    out.push('## ✅ The automatic checks passed');
    out.push('');
    out.push(
      'Nothing is broken or missing. **That is not the same as the plan being right** — ' +
        'see what you need to look at below.',
    );
  }
  out.push('');
  out.push('---');
  out.push('');

  /* -------------------------------------------------------- what code knows */

  out.push('## What the code checked');
  out.push('');
  out.push('| | Check | Result |');
  out.push('|---|---|---|');
  for (const c of r.codeChecks) {
    out.push(`| ${ICON[c.status]} | ${c.name} | ${c.detail} |`);
  }
  out.push('');
  out.push(
    '> These are mechanical: does the file exist, does it parse, does the image decode at a ' +
      'usable size. **No code here can tell whether an image shows the right face, the right ' +
      'place, or the right moment.** That is the next section.',
  );
  out.push('');
  out.push('---');
  out.push('');

  /* ------------------------------------------------------- what you must do */

  out.push('## What you need to look at');
  out.push('');

  if (r.humanChecks.length === 0) {
    out.push('_No images to review yet._');
  } else {
    out.push(
      'Open each file and answer the question. This is the whole point of stopping here: ' +
        'a wrong image costs about 1 credit to fix now, and the whole run to fix later.',
    );
    out.push('');

    r.humanChecks.forEach((h, i) => {
      out.push(`### ${i + 1}. ${h.what}`);
      out.push('');
      out.push('```text');
      out.push(`    ${h.where}`);
      out.push('```');
      out.push('');
      out.push(`**Look for:** ${h.lookFor}`);
      out.push('');
      out.push(`**If it is wrong:** ${h.ifWrong}`);
      out.push('');
    });
  }

  out.push('---');
  out.push('');
  out.push('## When you are happy');
  out.push('');
  out.push('```bash');
  out.push(`npm run approve -- ${r.project} --gate look --note "checked the references"`);
  out.push('```');
  out.push('');
  out.push(`Then build it: \`/run-video ${r.project}\``);
  out.push('');
  out.push('**If anything looked wrong, do not approve.** Fix it first — that is what this');
  out.push('stop is for. Approving a plan you have doubts about spends the full budget to');
  out.push('confirm the doubt.');
  out.push('');
  out.push('---');
  out.push('');
  out.push(`_Generated ${r.generatedAt} — nothing in this report spent money._`);
  out.push('');

  return out.join('\n');
}

/** Write the report and return its path. */
export function writePlanReport(project: string, markdown: string): string {
  const file = join(paths(project).reports, 'plan-report.md');
  writeFileAtomic(file, markdown);
  return file;
}
