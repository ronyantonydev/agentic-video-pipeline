---
name: plan-video
description: Plan a video completely before spending on it. Writes every artifact, generates the cheap reference plates, verifies them against each other, and stops at one approval. Takes --quick (four questions) or --grill (six rounds) to choose how hard to interview first. Produces plan.json and plan-report.md, which are the only things /run-video needs. Use whenever someone wants to plan, price, or prepare a video, or asks what a video would cost.
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

## Modes — how hard to interrogate

The interview and the planning are separate concerns. This skill owns how a
plan is **built and verified**; the mode decides how much is **asked first**.

| Invocation | Interview | Use for |
|---|---|---|
| `/plan-video --quick <idea>` | [[make-video]]'s four questions | a test, or a cheap video |
| `/plan-video --grill <idea>` | [[grill-video]]'s six rounds | a video worth real money |
| `/plan-video <idea>` | ask, having first learned the budget | unspecified |

### Choosing the mode when no flag was given

**Get the budget first, then recommend.** The budget is what decides, both
interviews need it anyway, and asking "quick or grill?" before you know it
makes the user guess at the thing you should be advising on. It is also a
poor opening question for someone who does not yet know what the modes mean.

So:

1. If the idea already carries a budget (`"...15s, $5"`), take it. Otherwise
   ask **only** "What is your budget for this?"
2. Recommend a mode **with the number attached**, and offer the other.

```text
At $30 I'd suggest --grill: 20 questions across six rounds. Its
efficiency round usually recovers 15-25%, so about $5-8 back here,
which more than pays for the extra questions.

--quick (4 questions) if you would rather just go.
```

3. Run whichever they pick.

The threshold is about **$10**. Below it, grill buys back less than a dollar
for twenty questions — recommend `--quick` and say why. Above it, recommend
`--grill` with the figure it is likely to recover.

**Never ask when a flag was given.** An explicit `--quick` or `--grill` is
the answer; asking again re-opens a decision the user already made.

### When the budget will not buy the runtime

Check this **before the interview**, right after you have the budget. The
interview's answers depend on which video is actually being made, so settling
it first avoids twenty questions about a video nobody can afford.

```bash
npm run budget -- --budget <usd> --runtime <seconds>
```

If the requested runtime costs more than the budget, **stop and show the
numbers** — see the same rule in [[make-video]] for the message shape and the
four rules governing it. Never quietly plan a shorter video: the user gave a
runtime and a budget, and when both cannot be true, choosing for them delivers
something they did not ask for.

Once they choose, the runtime is settled and the interview proceeds against
the real one.

### Running the interview

Do not re-implement either interview here. Read the matching skill and follow
its questions exactly — that way a difference in the plan reflects a
difference in the interview, not two drifting copies of the same logic.

If the user already gave an idea, a runtime and a budget, that is most of
`--quick` answered. Do not re-ask what they just told you; confirm the rest.

## Order of work

Free work first, always. A plan that dies at step 3 should cost nothing.

1. **Interview**, per the mode above. Then everything below is identical
   whichever mode ran — one planning path, one verification path.
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

## Verify every image with your eyes

`refcheck` and `validateAnchor` prove an image is readable, correctly sized
and not blank. **Nothing in this repo can tell you it is the right face, the
right place, or the right moment.** The drift score explicitly cannot — a
photograph of a stool scored 0.50 against a character master, above two of
five genuine samples. Smoke signal, never a verdict.

refcheck also passed with **zero images** on rain-riverbed, because missing
sheets only warn. Passing is not evidence.

So Read every one of these and check it against continuity.json:

| What | Check |
|---|---|
| Character pack (6) | One person across all six. Same wardrobe, age, build. |
| Environment sheet | The location the shots describe, in the stated light. |
| Style sheet | The palette and grade every shot inherits. |
| Prop sheets | Grounded in a real setting, not floating on a backdrop. |
| Start frame | The moment the shot opens on. |
| End frame | Where it lands — and continuous with the next shot's start. |

**The pack filenames are exact** — `referencePackPaths` finds no others:
`face-front`, `face-three-quarter`, `face-profile`, `body-front`,
`body-three-quarter`, `body-back`. Six from six independent calls produces
six near-strangers; one reference will not hold a face across separate calls.

**Anchors are the highest-leverage check.** A video model given a start and
end frame fills in the middle, so a wrong anchor guarantees a wrong clip at
roughly 100× the frame's cost. Both failures on the first project were
visible in the anchor and cost a full clip each to find.

**Then check the attachments** in generation-plan.json: every shot with a
person carries the character reference — *including* macros of hands, boots
or sleeves — and every shot carries the environment sheet. A hands-only macro
generated without it came back with different hands in a different place, 20
credits to redo.

## Finishing

`refcheck` writes `reports/plan-report.md` automatically — one page listing
every automatic check that ran and every image the user must look at, each
with what to look for and what to do if it is wrong. Regenerate it any time
with `npm run plan:report -- <project>`.

**Point the user at that file.** They should not have to open nine JSON files
and a folder of images to answer "does this look right".

Then print, briefly:

1. What the video is — shots, runtime, look
2. The complete cost range, with the breakdown
3. Whether the wallet covers it
4. The path to the plan report
5. `Run it with /run-video <project>`

Then stop. Do not generate video. Do not approve the look gate on the
user's behalf — that gate exists precisely because a human looks.
