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
import { readReferenceCheck, isRejectedPlate } from '../qa/reference-gate.js';
import { creditsToUsd } from '../budget/cost.js';
import { loadModels } from '../config/loader.js';
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

/**
 * What the plan costs, completely.
 *
 * `estimateGenerationPlan` walks generation-plan.json only, so it counts video
 * shots and nothing else. On rain-riverbed that under-reported the real spend
 * because two reference plates were never in the estimate. A user deciding how
 * many credits to buy needs the whole figure, including the plates already
 * generated and an allowance for retries.
 */
export type PlanCost = {
  shotCredits: number;
  shotUSD: number;
  shotCount: number;
  /** Reference plates already on disk, at the measured per-image rate. */
  plateCredits: number;
  plateUSD: number;
  plateCount: number;
  /** Held back for retries - a stochastic model returns the odd bad shot. */
  retryCredits: number;
  minimumCredits: number;
  withRetriesCredits: number;
  minimumUSD: number;
  withRetriesUSD: number;
  budgetUSD: number;
  withinBudget: boolean;
};

export type PlanReport = {
  project: string;
  idea: string;
  generatedAt: string;
  codeChecks: CodeCheck[];
  humanChecks: HumanCheck[];
  cost: PlanCost | null;
  blockers: string[];
  ready: boolean;
};

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

function listImages(dir: string): string[] {
  if (!existsSync(dir)) return [];
  // A superseded plate stays on disk as evidence but must never be offered
  // for approval next to the plate that replaced it.
  return readdirSync(dir).filter((f) => IMAGE_RE.test(f) && !isRejectedPlate(f)).sort();
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
  const genPlan = readJsonIfExists<{
    items?: Array<{ shotId: string; modelId?: string }>;
  } | null>(p.planningFile('generation-plan.json'), null);
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

  /* ------------------------------------------------------------------ cost */

  // Priced here rather than read from cost-estimate.md so this report stays
  // free and self-contained: it reads config and files, never the API.
  let cost: PlanCost | null = null;
  if (genPlan?.items && genPlan.items.length > 0) {
    const models = loadModels();
    let shotCredits = 0;
    let unpriced = 0;
    for (const item of genPlan.items) {
      const entry = models.video.find((m) => m.id === item.modelId);
      if (entry?.costCredits != null) shotCredits += entry.costCredits;
      else unpriced++;
    }

    // Plates already generated, at the measured image rate.
    //
    // This is an UPPER BOUND, not a record. Plates generated through MCP never
    // reach manifest.json, so there is no per-file receipt to read; and views
    // cut locally from one turnaround sheet cost nothing at all while still
    // appearing as separate files. The figure exists so the total is not
    // silently short - `transactions` is the authority on what was really
    // spent.
    const plateFiles = [...character, ...environment, ...style, ...props];
    const imageRate = models.image.find((m) => m.id === 'nano_banana')?.costCredits ?? null;
    const plateCredits = imageRate == null ? 0 : plateFiles.length * imageRate;

    const retryCredits = round1(shotCredits * 0.2);
    const minimumCredits = round1(shotCredits + plateCredits);
    const withRetriesCredits = round1(minimumCredits + retryCredits);

    cost = {
      shotCredits: round1(shotCredits),
      shotUSD: creditsToUsd(shotCredits, models),
      shotCount: genPlan.items.length,
      plateCredits: round1(plateCredits),
      plateUSD: creditsToUsd(plateCredits, models),
      plateCount: plateFiles.length,
      retryCredits,
      minimumCredits,
      withRetriesCredits,
      minimumUSD: creditsToUsd(minimumCredits, models),
      withRetriesUSD: creditsToUsd(withRetriesCredits, models),
      budgetUSD: state.budget.maxBudgetUSD,
      withinBudget: creditsToUsd(withRetriesCredits, models) <= state.budget.maxBudgetUSD,
    };

    codeChecks.push({
      name: 'Cost is fully priced',
      status: unpriced > 0 ? 'fail' : 'pass',
      detail:
        unpriced > 0
          ? `${unpriced} shot(s) have no known price - a cost can never be guessed`
          : `every shot priced from a measured figure`,
    });
    if (unpriced > 0) {
      blockers.push(
        `${unpriced} shot(s) in the generation plan have no known cost. Resolve a real price ` +
          `before running - the pipeline refuses to guess.`,
      );
    }
  }

  /* -------------------------------------------- completeness of the plan */

  // A plan can validate against every schema and still be thin: all shots on
  // one model, no anchor frames, every second paid for. These checks exist
  // because a passing schema says the file is well-formed, not that the plan
  // is a good one. Each is a WARN - the architecture states a policy, and
  // deviating from it is a judgement the planner can defend.

  // plan.json - the contract /run-video reads.
  const planExists = existsSync(p.plan);
  codeChecks.push({
    name: 'Run contract (plan.json)',
    status: planExists ? 'pass' : 'fail',
    detail: planExists
      ? 'written - validate with npm run plan:contract'
      : 'missing - /run-video has no single file to read',
  });
  if (!planExists) {
    blockers.push(
      `plan.json missing. It is the contract /run-video reads; without it the plan is ` +
        `incomplete however many artifacts exist. Write it, then run: ` +
        `npm run plan:contract -- ${project}`,
    );
  }

  const storyboard = readJsonIfExists<{
    frames?: Array<{ shotId: string; startFramePrompt?: string; endFramePrompt?: string }>;
  } | null>(p.planningFile('storyboard.json'), null);
  const shotlist = readJsonIfExists<{
    shots?: Array<{ id: string; importance?: string; continuityMode?: string }>;
  } | null>(p.planningFile('shotlist.json'), null);
  const editPlan = readJsonIfExists<{
    totalDurationSeconds?: number;
    items?: Array<{ screenDurationSeconds: number; motionSeconds: number; isStill?: boolean }>;
    captions?: unknown[];
  } | null>(p.planningFile('edit-plan.json'), null);

  // Anchor frames. A video model given a start and end frame fills in the
  // middle, so a wrong anchor guarantees a wrong clip at ~100x the frame's
  // cost - which makes an absent anchor the most expensive thing to skip.
  if (storyboard?.frames && storyboard.frames.length > 0) {
    const withFrames = storyboard.frames.filter(
      (f) => f.startFramePrompt || f.endFramePrompt,
    ).length;
    codeChecks.push({
      name: 'Anchor frames planned',
      status: withFrames === 0 ? 'warn' : 'pass',
      detail:
        withFrames === 0
          ? `none of ${storyboard.frames.length} shots define a start or end frame - ` +
            `the model chooses its own opening and closing image on every shot`
          : `${withFrames} of ${storyboard.frames.length} shots anchored`,
    });
  }

  // Anchor shots and model tiering. §9: 2-4 shots carry the weight and get
  // quality treatment; supporting shots go cheaper.
  if (shotlist?.shots && shotlist.shots.length > 0 && genPlan?.items) {
    const anchors = shotlist.shots.filter((s) => s.importance === 'anchor').length;
    const models = new Set(genPlan.items.map((i) => i.modelId));
    codeChecks.push({
      name: 'Anchor shots get quality treatment',
      status: models.size === 1 && anchors > 0 ? 'warn' : 'pass',
      detail:
        models.size === 1
          ? `${anchors} anchor(s) marked, but all ${genPlan.items.length} shots use ` +
            `${[...models][0]}. Anchors are meant to carry the weight on a dearer model.`
          : `${anchors} anchor(s) across ${models.size} model tier(s)`,
    });
  }

  // Runtime split. The motion floor is 55%, so up to 45% of runtime may be
  // stills, titles and graphics - which cost nothing to generate. Planning
  // 100% motion is valid, and pays the video model for every second.
  if (editPlan?.items && editPlan.items.length > 0 && editPlan.totalDurationSeconds) {
    const motion = editPlan.items.reduce((sum, i) => sum + i.motionSeconds, 0);
    const pct = (motion / editPlan.totalDurationSeconds) * 100;
    const captions = Array.isArray(editPlan.captions) ? editPlan.captions.length : 0;
    codeChecks.push({
      name: 'Runtime split (generated vs composed)',
      status: pct >= 99.9 ? 'warn' : 'pass',
      detail:
        pct >= 99.9
          ? `100% generated motion, ${captions} caption(s). Every second is paid footage; ` +
            `the lint floor is 55%, so titles and stills could carry up to 45%.`
          : `${pct.toFixed(0)}% generated motion, ${captions} caption(s)`,
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
    cost,
    blockers,
    ready: blockers.length === 0,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
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

  /* ------------------------------------------------------------- what it costs */

  if (r.cost) {
    const c = r.cost;
    out.push('## What it costs');
    out.push('');
    out.push('| Line | Credits | USD |');
    out.push('|---|---:|---:|');
    out.push(`| ${c.shotCount} video shots | ${c.shotCredits} | $${c.shotUSD.toFixed(2)} |`);
    out.push(
      `| ${c.plateCount} reference plates (upper bound) | ${c.plateCredits} | ` +
        `$${c.plateUSD.toFixed(2)} |`,
    );
    out.push(`| **Minimum** | **${c.minimumCredits}** | **$${c.minimumUSD.toFixed(2)}** |`);
    out.push(`| Retry allowance (20%) | ${c.retryCredits} | — |`);
    out.push(
      `| **With retries** | **${c.withRetriesCredits}** | **$${c.withRetriesUSD.toFixed(2)}** |`,
    );
    out.push('');
    out.push(
      `**Buy for ${c.withRetriesCredits} credits, not ${c.minimumCredits}.** ` +
        'A stochastic model returns the occasional bad shot; the allowance is what makes ' +
        'that recoverable instead of fatal.',
    );
    out.push('');
    out.push(
      '_The plate line counts every reference file at the full image rate, so it reads high: ' +
        'views cut locally from one turnaround sheet cost nothing, and plates generated ' +
        'through MCP never reach manifest.json. Read `transactions` for what was actually ' +
        'charged._',
    );
    out.push('');
    out.push(
      c.withinBudget
        ? `Budget is $${c.budgetUSD.toFixed(2)} — the full range fits.`
        : `⚠️ Budget is $${c.budgetUSD.toFixed(2)}, which does **not** cover the retry ` +
          `allowance. Raise it with \`npm run set-budget -- ${r.project} --budget <usd>\` ` +
          `or accept that a failed shot cannot be retried.`,
    );
    out.push('');
    out.push('---');
    out.push('');
  }

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
