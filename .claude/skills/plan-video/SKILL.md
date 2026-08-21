---
name: plan-video
description: Plan a video completely before spending on it. Writes every artifact, generates the cheap reference plates, verifies them against each other, and stops at one approval. Produces plan.json, which is the only thing /run-video needs. Use whenever someone wants to plan, price, or prepare a video, or asks what a video would cost.
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep, mcp__claude_ai_Higgsfield__generate_image, mcp__claude_ai_Higgsfield__generate_image_batch, mcp__claude_ai_Higgsfield__jobs_wait, mcp__claude_ai_Higgsfield__balance, mcp__claude_ai_Higgsfield__models_explore]
---

# Plan a video

**Everything expensive is decided here, where deciding is free.**

Generation is a dice roll you pay for. Planning is a dice roll you don't.
So every question that can be answered before the money moves gets answered
here, and `/run-video` becomes mechanical.

The measure of a good plan is not that it looks thorough. It is that
`/run-video` never has to ask anything.

## The one gate

This skill stops exactly once: **you look at the reference plates and say
go.**

That gate costs about 2 credits and a minute. Skipping it risks the whole
run — the first rejected project on this repo was three clips that shared
one defect, because none was checked before the next was generated. Today's
rain-riverbed run used this gate and wasted nothing.

Nothing else stops. Warnings print and the plan continues.

## Order of work

Free work first, always. A plan that dies at step 3 should cost nothing.

1. **Understand the video.** Genre, subject, runtime, budget ceiling. If the
   user gave an idea and a number, that is enough — do not re-ask.
2. **Write the planning artifacts.** story, beat-grid, progression,
   continuity, shotlist, storyboard, edit-plan, music, generation-plan.
   Every one Zod-validated. `npm run plan:*` where a generator exists.
3. **Check realism.** Run [[verify-realism]] against continuity.json and
   storyboard.json BEFORE any prompt is final. The four rules are not
   optional: identity needs an image, one shot is one moment, match the
   genre, handmade looks handmade.
4. **Check coherence.** Run [[verify-plan-coherence]]. Artifacts must agree
   with each other and the continuity graph must be executable.
5. **Price it completely.** See "The estimate must be complete" below.
6. **Generate the cheap plates.** Reference sheets, and a character pack if
   a person recurs. A few credits, not forty.
7. **Verify the plates.** `npm run refcheck` — and LOOK at them yourself
   with Read. A file that downloaded is not a file that is correct.
8. **Raise the look gate** and stop.

## The estimate must be complete

`estimateGenerationPlan` walks `generation-plan.json` items only — video
shots. It does not count reference images, character packs, music
generation, or upscales.

Observed on rain-riverbed 2026-08-21: estimated $2.34, actually cost $2.47,
because two 1-credit reference plates were never in the estimate.

A 5% miss does not matter when the budget has slack. It matters completely
when the plan is used to decide **how many credits to buy**. So the plan
total must include:

- every video shot (from generation-plan.json)
- every reference image and character-pack image
- music generation, if the music plan calls for it
- any planned upscale
- **a retry allowance** — see below

State the total as a range, not a point: `39.5 credits minimum, 50 with
retries`. A single number invites under-buying.

## Retries are planned, not improvised

Models are stochastic. The same prompt with the same reference returns a
different result each time. A perfect plan still yields the occasional bad
shot, so the plan must carry an allowance for it.

Reserve **20%** by default (`overheadFraction` in budget-fit already exists
for this). Write the retry policy into plan.json explicitly:

```json
"retryPolicy": { "maxAttemptsPerShot": 2, "allowanceCredits": 8 }
```

**Two attempts per shot, not an open allowance.** A shot that fails twice is
not unlucky — it is mis-planned, and retrying a third time reproduces the
same defect at full price. That is exactly how the first rejected run burned
its budget: three clips, one shared defect, none checked before the next.

## plan.json is the contract

Write **one file** that fully determines the run. If `/run-video` needs
anything not in it, the plan is incomplete.

This is also what makes a frontend possible later: a UI can read and edit one
data structure, but it cannot read intent that lived in a conversation. Keep
the plan a data structure from the start, or a UI will never be able to
drive it.

Required keys:

| Key | Holds |
|---|---|
| `projectName`, `idea`, `mode` | identity |
| `shots[]` | id, prompt, negativePrompt, model, seconds, references, aspect |
| `references[]` | every plate to generate, with its category and prompt |
| `characterPack` | pack images and the master, or `null` when no person recurs |
| `music` | the music plan, and whether a file must be generated |
| `edit` | transitions, captions, music gain and fades |
| `cost` | per-line breakdown, total, retry allowance, the range |
| `retryPolicy` | maxAttemptsPerShot, allowanceCredits |
| `gates` | which are approved, and on what evidence |

## Buying credits

The user buys **after** the plan and **before** the run — that is the whole
point of planning first.

Read the wallet with `balance`. If it already covers the planned range, say
so and move on. If it does not, say exactly how short it is in credits and
dollars. Do not tell them to buy a subscription tier or guess at pricing;
report the gap and let them decide.

Remember the two wallets: API and subscription bill separately, and
generation here goes through MCP against the subscription wallet.

## Verify the plates with your eyes

`refcheck` proves a file is readable, not that it is right. It passed with
**zero images** on rain-riverbed because sheets only warn.

So: Read every plate. Check it against continuity.json — the light, the
palette, the location, the texture. A wrong plate is wrong in every shot
generated against it, and it costs 1 credit to redo now versus the whole run
later.

The drift score is advisory only and cannot tell a face from a prop. Never
present it as a verdict.

## Finishing

Print, in this order:

1. What the video is — shots, runtime, look
2. The complete cost range, with the breakdown
3. Whether the wallet covers it
4. The plates, named, with your own assessment of them
5. `Run it with /run-video <project>`

Then stop. Do not generate video. Do not approve the look gate on the
user's behalf — that gate exists precisely because a human looks.
