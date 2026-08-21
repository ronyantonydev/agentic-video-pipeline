---
name: verify-plan-coherence
description: Check that planning artifacts agree with each other, that the continuity graph can actually execute, that motion-ratio lint runs at both required points, and that gates are resumable. Run after editing src/planning/, src/gates/, or any planning artifact.
allowed-tools: [Read, Grep, Glob, Bash]
---

# Verify plan coherence

A plan that validates field-by-field can still be impossible to execute.
These checks catch the disagreements that would otherwise surface only after
money has been spent.

Report PASS/FAIL per check with `file:line`.

## 1. Claude plans, code validates

Architecture §2. The CLI must never author planning content.

- No code in `src/planning/` or `src/cli/` writes to `planning/*.json`.
- `cmdPlan` reads and validates only.
- A stage that generates a storyboard, prompt, or shot description in code
  is a FAIL - that is Claude's job.

## 2. Artifacts agree with each other

Individually valid files can still contradict one another.

- Every `shotId` in storyboard, edit-plan, and generation-plan exists in the
  shotlist.
- Every shot in the shotlist appears in the edit plan - a shot planned but
  never edited is silently wasted money.
- `validateCrossReferences` runs on every plan stage, not just the last.

## 3. The continuity graph can execute

Architecture §13.

- No cycles. A cycle deadlocks: no shot can start.
- Every `previousShot` resolves to a real shot.
- A dependency never has a higher index than its dependant.
- `assertExecutableGraph` throws on errors and passes on warnings. Long
  chains warn (drift risk) but must not block.
- The graph is validated BEFORE any generation, so a bad shot_04 can never
  trigger paid generation of shot_05.

## 4. Motion lint runs twice

Architecture §18. Running it once is a FAIL.

- Lint #1 after edit planning, blocking.
- Lint #2 after QA and fallbacks, blocking.
- A Ken Burns move on a still must NOT count as real motion. If
  `isRealMotion` ever returns true for `isStill: true`, the whole lint is
  defeated - that substitution is precisely what it exists to catch.
- `lintAfterFallbacks` must not mutate the caller's plan.

## 5. Gates are resumable

Architecture §21.

- A gate writes state, prints, and throws `GatePending`. It never blocks on
  stdin, and never polls.
- Gate state survives a process restart - it lives in `state.json`, not in
  memory.
- Gates are independent: approving `cost` must not unlock `look`.
- A rejected gate stays blocked and reports its reason.
- `requireApproval` is called before every stage that spends.

## 6. Billable durations are honest

- Every `generation-plan.json` item satisfies
  `billableSeconds >= requiredSeconds`.
- Model ids in the generation plan exist in the REST catalogue - an MCP id
  here returns `model_not_found` at generation time.
- Shots marked `isStill` in the edit plan do NOT appear in the generation
  plan. Paying to generate video for a shot that will be shown as a still is
  pure waste.

## 7. The dry run spends nothing

Architecture §20.

- `npm run cost -- <project> --dry-run` performs no paid call.
- It reports unpriced shots rather than assuming a price.
- It never requests approval - a dry run is informational.

## How to run

```bash
npx vitest run tests/planning.test.ts tests/gates.test.ts
npx tsx src/cli/index.ts plan generation <project>
npx tsx src/cli/index.ts cost <project> --dry-run
```

The dry run must produce a complete cost table with \$0 spent.
