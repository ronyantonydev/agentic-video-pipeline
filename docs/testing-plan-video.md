# Testing `/plan-video`

How to exercise the planning skill, what a good result looks like, and what
to do when it is not good.

The whole point of `/plan-video` is that **being wrong here is cheap**. A bad
plan caught at this stage costs about 2 credits. The same plan caught after
`/run-video` costs the whole budget. So test it properly — this is the step
that pays for itself.

---

## What you are actually testing

Not "did it produce files". Files are easy. You are testing four claims:

1. **The plan is complete** — `/run-video` would need nothing else.
2. **The plan is coherent** — the artifacts agree with each other.
3. **The price is honest** — it counts plates and retries, not just shots.
4. **The plates are right** — they match what the plan says the video looks
   like.

Claim 4 is the one only a human can check, and it is the reason the skill
stops.

---

## Before you start

```bash
npm run doctor
```

Node 22+, FFmpeg, and a Higgsfield account with credits. If your shell
defaults to Node 18, prefix commands with the nvm v22 bin path.

Check the wallet, because the plates cost real credits:

```text
balance
```

A test run needs about 2–5 credits. If you want to test the planning logic
with **zero** spend, see "Dry run" below.

---

## Test 1 — a plain run (the happy path)

Pick something simple with no recurring person. A person adds identity
handling, which is worth testing separately.

```text
/plan-video --quick a candle burning down in a dark room, 15s, $5
```

Let it run to the stop.

**Read `reports/plan-report.md` first.** It is written automatically and lists
every automatic check and every image you need to look at. The manual checks
below are what that report is built from — work through them the first few
times to know what the report is claiming, then trust the report.

### Verify on finish

Work through these in order. Stop at the first failure — later checks assume
earlier ones passed.

**A. It stopped in the right place.**

```bash
npx tsx src/cli/index.ts status <project>
```

- `Stage: gate-look`
- `cost` gate `approved`, `look` gate `pending`
- **`look` must NOT be approved.** If it is, the skill approved on your
  behalf, which defeats the gate. That is a bug — report it.

**B. Every artifact exists and validates.**

```bash
ls projects/<project>/planning/
```

Expect: `story.json`, `music.json`, `beat-grid.json`, `progression.json`,
`continuity.json`, `shotlist.json`, `storyboard.json`, `edit-plan.json`,
`generation-plan.json`.

Validation is not optional — an artifact that exists but does not parse will
fail later at a more expensive moment.

**C. The artifacts agree with each other.**

Run the coherence check:

```text
/verify-plan-coherence
```

Then eyeball the two that matter most:

- Every `shotId` in `edit-plan.json` exists in `shotlist.json`
- `edit-plan.json` total duration matches the runtime you asked for
- Every shot in `generation-plan.json` has a non-empty `prompt` **and** a
  `negativePrompt`

**D. The prompts pass the realism rules.**

```text
/verify-realism
```

Read a couple of prompts yourself. Specifically look for:

- No time compression inside one shot — no "as time passes", "gradually",
  "time-lapse". Progress belongs in the cut between shots.
- Camera and light vocabulary matching the stated genre, not defaulting to
  "cinematic", golden hour, or drone shots.
- A negative prompt on every shot excluding wrong-genre terms.

**E. The price counts everything.**

```bash
cat projects/<project>/reports/cost-estimate.md
```

Then compare against what the skill printed. **They will differ**, and that
is the known gap: `estimateGenerationPlan` walks video shots only, so the
report excludes reference plates. The skill is supposed to add them back.

- Does the skill's stated total include the plates?
- Is it stated as a **range** (minimum vs with-retries), not a single number?
- Does `retryPolicy` appear with `maxAttemptsPerShot: 2`?

A single-number total is a fail: it invites under-buying credits.

**F. The plates are right.** ← *the one that matters*

```bash
ls projects/<project>/references/*/
```

Open them. Actually look:

```text
Read projects/<project>/references/environment/<name>.png
```

Check against `continuity.json` — light, palette, location, texture. Ask:

- Is this the light the plan says? (overcast is not golden hour)
- Is this the *same place* the shots describe?
- Would every shot generated against this look right?

`refcheck` passing means the file is readable, **not** that it is correct. It
passed with zero images on a real project, because missing sheets only warn.

**F-bis. Every reference image, one by one.**

"Look at the plates" is not one check — it is a sweep over everything the
video will be built from. Do this systematically, because a single wrong
image propagates into every shot that uses it.

**What the code checks for you (mechanics):**

`validateAnchor` in `src/qa/anchor.ts` runs on start/end frames and on every
character image, and covers: file exists, decodes, meets minimum resolution,
is not blank (contrast sampling), and a composition smoke-test. `refcheck`
additionally counts sheets and runs the drift score.

**What only you can check (content):** whether it is the *right* face, the
*right* place, the *right* moment. No code in this repo can answer that. The
drift score explicitly cannot — it is a whole-frame perceptual hash that
scored a photograph of a stool at 0.50 against a character master, higher
than two of five genuine samples. Treat it as a smoke signal, never a
verdict.

So walk the list:

| What | Where | Verify by eye |
|---|---|---|
| Character pack | `references/character/` | Same person in all six. Same wardrobe, same age, same build. |
| Environment sheet | `references/environment/` | The location the shots describe, in the light `continuity.json` states. |
| Style sheet | `references/style/` | The palette and grade every shot inherits. |
| Prop sheets | `references/props/` | Grounded in a real setting, not floating on a studio backdrop. |
| Start frame | per shot | The moment the shot *begins*. |
| End frame | per shot | The moment the shot *ends* — and continuous with the next shot's start. |

**The six-image character pack** is exactly these filenames — anything else
is not found by `referencePackPaths`:

```text
face-front.png  face-three-quarter.png  face-profile.png
body-front.png  body-three-quarter.png  body-back.png
```

Three face angles, three body. Fewer than six warns rather than blocks: one
reference held identity in wide shots on a real project and failed in
close-ups, which is why six are wanted. Check all six show **one person** —
generating them as six independent calls produces six near-strangers, and one
reference image will not hold a face across separate calls.

**Start and end frames** are the highest-leverage check here. A video model
given both fills in the middle, so a wrong anchor guarantees a wrong clip —
and the clip costs roughly 100× the frame. Both real failures on the first
project were visible in the anchor and cost a full clip each to discover.

For each shot that uses them:

- Does the start frame show the moment the shot *opens* on?
- Does the end frame show where it should *land*?
- Is the end frame of shot N continuous with the start frame of shot N+1 —
  same light, same place, same subject state? A jump there reads as a
  continuity error in the finished video.
- Are they the same subject as the character pack?

**Per-scene references.** Every shot in `generation-plan.json` should carry
the references its `continuity.json` entry implies. Check specifically:

- Shots with a person attach the character reference — **including** macro
  shots of hands, arms, boots, or clothing. A macro of "dirty bare hands
  gripping a shovel" was generated without it on the assumption that
  hands-only meant no identity to hold; it came back with different hands in
  a different place and cost 20 credits to redo.
- Every shot attaches the environment sheet, or the model re-invents the
  location from words — that is how a winter forest became a summer one.
- Only genuinely empty shots may omit references.

If any image is wrong, do not approve the look gate. See "When the plan is
not good" below.

**G. `plan.json` is a real contract.**

```bash
cat projects/<project>/plan.json
```

The test: could someone who was not in the conversation run this video from
this file alone? If any decision lives only in the chat transcript, the plan
is incomplete — and no frontend could ever drive it.

---

## Test 1b — the other interview, same plan

Run the same idea through the deep interview:

```text
/plan-video --grill a candle burning down in a dark room, 15s, $5
```

This is the parity test, and it is the reason the modes exist as flags rather
than as separate skills. Verify:

- **The interview differed.** `--grill` asked about genre reference, look,
  and efficiency; `--quick` asked four questions and moved on.
- **The plan is the same shape.** Same nine artifacts, same validation, same
  report sections, same gate. Only the *content* should differ — better
  grounded prompts, possibly fewer shots after the efficiency round.
- **`--grill` came out cheaper or better specified**, or it did not earn its
  twenty questions. Its efficiency round exists to buy back 15–25%.

If the two modes produce structurally different plans — a missing artifact, a
different report shape — that is a bug. The interview is supposed to be the
only difference.

## Test 2 — a person in the video

```text
/plan-video a potter throwing a bowl at her wheel, 20s, $8
```

Everything from Test 1, plus:

- A **character pack** is planned, and `continuity.json` describes wardrobe
  reproducibly ("torn left cuff, grey thermal collar") rather than with
  adjectives ("weathered").
- Shots showing hands, arms, boots or clothing **attach the character
  reference**. A macro of hands is not exempt — that mistake cost 20 credits
  on a real run.
- The cost includes the pack images.

> **Known gap:** nothing in `src/` generates a character pack today.
> `refcheck` checks for one; no code creates one. Expect this step to be
> manual, and treat a skill that silently skips it as a fail.

---

## Test 3 — the budget does not fit

```text
/plan-video a 60 second documentary about a lighthouse, $3
```

Verify it **argues** rather than silently shrinking the job:

- It states the gap in credits and dollars.
- It offers a real choice — shorter runtime, cheaper model, bigger budget.
- It does **not** quietly plan 20 seconds and call it done.
- It does **not** proceed to generate plates for a plan that cannot run.

---

## Dry run — testing with zero spend

To exercise everything except the plates, drive the CLI directly:

```bash
npx tsx src/cli/index.ts init <project> --idea "..." --budget 5
npm run plan:story -- <project>
npm run plan:audio -- <project>
npm run plan:storyboard -- <project>
npm run plan:edit -- <project>
npm run plan:generation -- <project>
npm run cost -- <project>
```

Everything above is free. Only the reference plates cost money, so this
validates artifacts, coherence and pricing for nothing.

To exercise the *whole* pipeline including generation and rendering with no
cost at all, use the fake provider:

```bash
PROVIDER_MODE=fake npx tsx src/cli/index.ts ...
```

It synthesises real H.264 files, so QA and rendering run for real against
them. That tests the machinery end to end but tells you nothing about whether
the *look* is right — only real plates can do that.

---

## When the plan is not good

The response depends on **which** claim failed. Re-running the whole skill is
almost never the right move — it is slow and it regenerates plates you
already paid for.

### The plates look wrong

The cheapest and most common failure. Do **not** approve the look gate.

1. Say precisely what is wrong — "too warm, should be flat overcast", "wrong
   ground texture", "that is a lake, not a riverbed". Vague feedback produces
   a vague reroll.
2. Fix `continuity.json` if the *plan* was wrong, not just the image. A plate
   that faithfully renders a bad description will regenerate just as wrong.
3. Regenerate only the offending plate — 1 credit — and look again.

Rerolling the same prompt hoping for a better dice roll is the trap. If the
description is wrong, every roll is wrong.

### The artifacts disagree

Fix the artifact, then re-run only the affected stage:

```bash
npm run plan:edit -- <project>
```

Then re-run `/verify-plan-coherence`. Do not hand-edit generated JSON without
re-validating — a malformed artifact fails later, at a more expensive moment.

### The prompts break a realism rule

Fix `continuity.json` or `storyboard.json` — the prompts derive from them, so
patching a prompt alone leaves the source wrong and the next regeneration
reintroduces it. Then:

```bash
npm run plan:generation -- <project>
```

### The price is wrong or incomplete

If the total omits plates or retries, that is the known estimate gap. Add
them by hand for now and record the real number. If a **model price** is
unknown, do not guess: resolve it with a live estimate or a measured balance
delta, and write it into `config/models.json` with its source. A guessed
price is how a budget silently becomes wrong.

### The plan is incomplete

If `plan.json` is missing a key that `/run-video` would need, that is a skill
bug, not a project problem. Note which key, and fix the skill — otherwise
every future project inherits it.

### You are not sure

Stop. The gate exists exactly for this. Two credits of plates and an unspent
budget is a good outcome; 40 credits of video you do not like is not.

---

## Cleanup

Test projects are just directories:

```bash
rm -rf projects/<test-project>
```

Credits spent on plates are gone — a few credits per test run. Check real
spend with the `transactions` tool, **not** `npm run report`, which reads
$0.00 for MCP work because those generations never reach the manifest.

---

## Quick reference

| Check | Command | Pass looks like |
|---|---|---|
| Stopped correctly | `status <project>` | stage `gate-look`, look `pending` |
| Artifacts exist | `ls projects/<p>/planning/` | 9 files |
| Artifacts agree | `/verify-plan-coherence` | no blockers |
| Prompts sane | `/verify-realism` | no rule violations |
| References verified | `npm run refcheck -- <p>` (add `--no-character` when no person recurs) | PASS, no blockers |
| Plates correct | `Read` each plate | matches `continuity.json` |
| Character pack | `Read` all six | one person, six angles, exact filenames |
| Anchors correct | `Read` each start/end frame | right moment; end of N continuous with start of N+1 |
| References attached | read `generation-plan.json` | every peopled shot carries the character ref, macros included |
| Price honest | read `plan.json` `cost` | a range, includes plates + retries |
| Plan complete | read `plan.json` | runnable without the transcript |
