---
name: run-video
description: Execute an approved video plan end to end - generate every shot, retry within the planned allowance, assemble, and report actual spend. Takes no creative decisions; if it needs one, the plan was incomplete. Use after /plan-video, or whenever someone says run, execute, or generate an existing plan.
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep, mcp__claude_ai_Higgsfield__generate_video, mcp__claude_ai_Higgsfield__generate_video_batch, mcp__claude_ai_Higgsfield__generate_audio, mcp__claude_ai_Higgsfield__generate_image, mcp__claude_ai_Higgsfield__generate_image_batch, mcp__claude_ai_Higgsfield__jobs_wait, mcp__claude_ai_Higgsfield__show_generation_by_ids, mcp__claude_ai_Higgsfield__balance, mcp__claude_ai_Higgsfield__transactions]
---

# Run a video plan

**Execution only. Every decision was made in the plan.**

If this skill finds itself wanting to choose something — a prompt, a model,
a look, a transition — the plan was incomplete. Stop and say which key was
missing. Do not improvise: an improvised decision spends real money on
something nobody approved.

## Refuse to start unless

1. **`plan.json` exists and validates.** No plan, no run.
2. **The look gate is approved.** `/plan-video` raises it; a human clears
   it. If it is `not-reached`, the plan was never finished — send them back
   to `/plan-video`, do not raise it here.
3. **The wallet covers the planned range.** Read `balance`. If it is short,
   report the gap in credits and dollars and stop. Starting a run you cannot
   finish strands half-generated work that was paid for.

All three are cheap to check and each one prevents a wasted run.

## Generating

Work from `plan.json` shots. Nothing else.

- **Attach the references the plan names.** A shot generated without its
  reference reinvents the location — that is how a winter forest became a
  summer one. This includes body-part shots: hands, boots, sleeves all carry
  identity.
- **Use the exact role strings.** Seedance accepts `start_image`,
  `end_image`, `image_references`, `video_references`, `audio_references`. A
  bare `reference` is rejected at submission — no charge, but the batch is
  lost.
- **Batch independent shots**, then `jobs_wait`. Shots chained by
  start/end frames must run in continuity order, not in parallel.
- **Keep Mini shots at 5s** so the flat 12.5-credit figure stays exact.

## Retrying

The plan sets `retryPolicy`. Honour it exactly.

**Two attempts per shot by default.** On a failure or a QA reject, retry
once with a different seed. If the second attempt also fails, **stop
retrying that shot** and record why.

A shot that fails twice is mis-planned, not unlucky. A third attempt
reproduces the same defect and bills for it. This is the failure that burned
the first rejected run: three clips, one shared defect, none checked before
the next was generated.

Track the allowance. When retries have consumed it, stop the run and report
— do not quietly continue past the number the user approved.

## Check the work, don't assume it

A downloaded file is not a correct file.

- `npm run qa:machine` for the deterministic checks.
- Then **Read actual frames** from each clip — first and last at minimum.
  Confirm the location holds, the light matches, and the moment is
  continuous rather than time-lapsed.
- `project-format` will fail whenever the model caps below the project
  settings (Seedance Mini is 720p/24). That is expected and normalisation
  handles it. Say so plainly rather than reporting a failure — but do say
  the final 1080p is upscaled, not native.

## Assembling

`npm run render` normalises, compiles the edit plan, and renders via
HyperFrames. Then `npm run qa:final`.

If the music plan calls for a generated track, generate it before rendering
— the compiler only includes music when the file exists on disk.

## Reporting spend honestly

**`npm run report` will say \$0.00.** MCP generation never writes manifest
entries, so the report renders from an empty manifest and reads as "this run
was free" rather than "this run was not recorded."

Never quote it. Read the `transactions` tool, filter to entries at or after
this run's start time, and convert at 16 credits per USD. Earlier rows
belong to previous sessions.

Report:

- actual credits and dollars, from transactions
- against the planned range
- what retried, and why
- anything that failed twice and was left undone

## When to stop

Stop and ask only for something the plan did not already decide:

| Stop | Why it is not a re-ask |
|---|---|
| Wallet cannot cover the plan | They approved a plan, not an overdraft |
| A shot has no known cost | Nobody can approve an unknown number |
| A shot failed its planned attempts | The plan on the table is no longer true |
| The plan is missing a key | Improvising it spends money on an unapproved choice |

Everything else prints and the run continues.
