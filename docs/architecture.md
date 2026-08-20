# Architecture

How the pipeline is built, and why each part is the shape it is.

This describes the system **as built**, not as originally planned. Where the
two differ, the reason is recorded — usually because something failed and
cost credits to discover.

Code comments cite this document by section number (`section 22`, `§13`).
Those numbers come from the original design and are preserved in
[§ Design reference](#15-design-reference) at the end, so a citation in the
code resolves to a rule stated here.

---

## Contents

1. [The core principle](#1-the-core-principle)
2. [Pipeline stages](#2-pipeline-stages)
3. [Who spends money](#3-who-spends-money)
4. [Budget protection](#4-budget-protection)
5. [Cost resolution](#5-cost-resolution)
6. [Planning artifacts](#6-planning-artifacts)
   - [Reference sheets](#6a-reference-sheets)
7. [Continuity and scheduling](#7-continuity-and-scheduling)
8. [Quality assurance](#8-quality-assurance)
9. [Gates and resumability](#9-gates-and-resumability)
10. [The manifest](#10-the-manifest)
11. [Rendering](#11-rendering)
12. [Skills](#12-skills)
13. [What we learned the expensive way](#13-what-we-learned-the-expensive-way)
14. [Known limitations](#14-known-limitations)
15. [Design reference](#15-design-reference) — the numbered rules the code cites

---

## 1. The core principle

**Claude plans. Deterministic code spends.**

| Claude | Code |
|---|---|
| Story, hook, progression | Validating JSON |
| Storyboard and prompts | Calculating cost |
| Edit decisions | Checking budget |
| Model recommendations | Submitting paid jobs |
| Interpreting QA results | Polling, downloading |
| | FFmpeg processing, machine QA |
| | State, resume, rendering |

The separation exists because an LLM improvising a paid API call has no
budget guard in front of it. Every generation in this pipeline passes through
`authorizeSpend` first, and that function is code.

`verify-spend-safety` enforces the boundary: no MCP call may appear anywhere
in `src/`.

---

## 2. Pipeline stages

Thirty-one ordered stages in `src/schemas/state.ts`. Order matters — resume
compares indexes, so a gate provably precedes the work it guards.

```text
init → story → music → beat-grid → progression → continuity → shotlist
     → storyboard → edit-plan → motion-lint-1 → generation-plan
     → cost-estimate → 🛑 gate-cost
     → references → 🔒 reference-check → target-frames → contact-sheet → 🛑 gate-look
     → generate-shots → normalize → qa-machine → qa-vision → 🛑 review
     → motion-lint-2 → audio-finalize → render → upscale → thumbnail
     → qa-final → report → done
```

Three human gates (🛑) plus one automatic gate (🔒 reference-check, which
refuses to proceed unless references have been verified). Motion lint runs
twice — once on the plan, once after
fallbacks — because each fallback looks reasonable alone while three together
produce a slideshow.

---

## 3. Who spends money

One setting decides: `PROVIDER_MODE` in `.env`.

| Mode | Who pays | Catalogue | Budget enforcement |
|---|---|---|---|
| `mcp` | Claude, via subscription credits | Kling, Veo, Seedance, Cinema Studio | Code checks, Claude calls |
| `rest` | Node, via a Cloud API key | dop, soul | Fully mechanical |
| `fake` | nobody | synthesised media | N/A |

### The two wallets

Higgsfield bills **API and subscription from separate balances**. This was
discovered by a `403 not_enough_credits` on every submit while the MCP
connector simultaneously reported 1385 credits available.

- **Subscription (Max plan)** — spendable through the web app and MCP
- **Higgsfield Cloud (REST)** — funded separately at cloud.higgsfield.ai

The two also reach **different model catalogues, which barely overlap**. A
generation plan written for one mode will not run in the other, so
`catalogueFor()` records which is which rather than letting the mismatch
surface at submission time.

---

## 4. Budget protection

Four independent guards, all in `src/budget/guard.ts`, all before money moves.

**1. Per-call ceiling.** No single generation above `MAX_SINGLE_CALL_USD`.
Catches a runaway setting — 4K at 30 seconds — that the total budget alone
would permit.

**2. Project budget.** `spent + reserved + thisCall ≤ MAX_BUDGET_USD`,
checked before every paid call. Not only at the approval gate.

**3. Reservations.** `authorizeSpend` reserves before returning. Without
this, two parallel jobs both see the full remaining budget and both proceed.

**4. Unknown cost is a refusal.** A price that cannot be established stops
the run. There is deliberately no "guess" tier.

Failed generations are not charged — Higgsfield refunds them — so
`releaseReservation` returns the headroom rather than deducting it.

`HardStop` is terminal. Nothing catches it and continues.

### Budget-driven model selection

`src/budget/budget-fit.ts` fits a model to the money rather than picking one
and hoping:

```text
Budget $20.00 = 319 credits (12% held back for images and retries)

→ Seedance 2.0 Mini        90s   15 shots   225cr  $14.11
  Kling 3.0                90s   15 shots   135cr   $8.46
    ! no identity references: a recurring character will drift
  Seedance 2.0 (1080p)     31s    5 shots   279cr  $17.49
    ! budget covers 31s of the 90s requested
```

Cheaper tiers are always shown with what they cost in quality. Selection
refuses to trade away identity silently: Kling is cheaper per second but has
no `image_references` slot, so it is offered with that consequence stated and
chosen only when no character recurs.

---

## 5. Cost resolution

Five tiers, strictest first (`src/budget/cost.ts`):

1. **Estimate endpoint** — exact quote for these exact settings
2. **Learned cost** — measured from a prior identical configuration
3. **`base_credits`** from `GET /models`, scaled by duration, **rounded up**
4. **Config `costCredits`** — measured previously, settings unknown
5. **`UnknownCostError`** — refuse

Every tier is a real price from a real source. Where a tier is inexact it
**over**-estimates, so the actual spend lands under the quote rather than
over it.

Learned costs are keyed by **full configuration**, not model alone — a 15s
clip must never inherit the price of a 5s one.

**Measured rate:** Seedance 2.0 Mini bills 2.5 credits/second. A test asserts
this reproduces the 249 credits a real 80-second video actually cost, so a
wrong rate fails the suite instead of the budget.

---

## 6. Planning artifacts

Ten JSON files, each Zod-validated before it can drive a paid call.

| File | Answers |
|---|---|
| `story.json` | What is the story? |
| `music.json` | Mood, BPM, energy curve |
| `beat-grid.json` | Where can cuts land? |
| `progression.json` | What changes from start to end? |
| `continuity.json` | Character, wardrobe, environment, lighting |
| `shotlist.json` | Which shots, in what order, with what dependencies |
| `storyboard.json` | What should the viewer see? |
| `edit-plan.json` | How will the timeline present it? |
| `generation-plan.json` | What paid assets do we actually need? |
| `audio-plan.json` | Music, SFX, narration |

**Claude writes these. The CLI only validates.** Nothing in `src/planning/`
authors content — that separation is what keeps the core principle honest.

Cross-artifact validation runs on every stage: a storyboard referencing a
shot the shotlist does not contain fails at planning time, not at generation
time.

### Billable duration

Models expose durations two ways, and assuming one shape breaks the other:

- **Discrete** — Seedance 1.5 allows only `[4, 8, 12]`
- **Range** — Kling 3.0 allows anything from 3 to 15

Discrete models snap **up** to the next allowed value; range models clamp to
their floor. Rounding down is forbidden — it would leave the edit short of
footage it already planned for. A sweep test asserts
`billableSeconds >= requiredSeconds` across every model shape.

---

## 6a. Reference sheets

Generated once, reused by every shot. About **one credit** for a full set,
against ~20 credits for a single clip.

| Sheet | Contents | Regenerate when |
|---|---|---|
| **Character pack** | 6 images — 3 face angles, 3 body angles, grey background | the person or outfit changes |
| **Environment** | one image per location, correct season and light | a new location appears |
| **Props** | front + three-quarter per recurring object | a new object appears |
| **Style** | one image carrying grade, grain, mood | the channel's look changes |

**Why they exist.** Without a sheet, each shot re-describes its subject in
text and the model reinvents it. That is how one shot in a bare-winter-forest
video came back with green summer ferns — a 20-credit retry that a
0.12-credit environment sheet would have prevented.

**Character detail must be reproducible.** "Weathered jacket" is unusable;
"torn left cuff, grey thermal collar, mud at the knees" gives the model
something to draw twice. Body shots must still show the face — cropping the
head stops the reference teaching identity at all.

### The reference gate

**Enforced in code, not by instruction.** `generateShot` calls
`assertReferencesVerified` before it prices or reserves anything, and refuses
to proceed unless a passing `reference-check.json` exists on disk.

This is the same shape as the cost gate: code holds the checkpoint, the human
or Claude does the work behind it. The distinction matters because an
instruction in a skill file is followed *most* of the time, which is the
wrong bar when each miss costs 20 credits — and both real failures on this
project were reference problems.

```text
Claude generates references     ← only Claude can; MCP is not reachable from code
   ↓
checkReferences()               ← free: hashing and FFmpeg, locally
   ↓
reference-check.json written
   ↓
🔒 generateShot refuses unless that file exists and passes
```

**Blocks:** no character reference, a corrupt or blank reference image, a
failed drift test.
**Warns:** fewer than six images, missing environment or style sheet, drift
test not run.

The split reflects what is actually fatal. A missing environment sheet
degrades consistency; a broken character reference poisons every shot that
uses it.

**The drift test.** Generate 5–10 cheap samples from the character pack and
check identity holds (`runDriftTest` in `src/qa/identity.ts`). About one
credit to find out whether a reference works; 250 to discover it afterwards.
Its result is recorded in the gate file, so a failed test blocks the run
rather than merely warning.

**Escape hatch:** `requireVerifiedReferences: false` exists for tests and for
shots with no character, but it must be passed deliberately — the default is
on.

**Reuse across videos is where this compounds.** The character and style
sheets are not per-video assets. Same person in a new story means reusing the
pack at no cost, and the character looks identical across episodes.

**`image_references` is free.** Verified against the live API: a Seedance
generation costs 12.5 credits with the six-image pack attached and 12.5
without. There is no reason to omit it.

Claude generates these directly with `generate_image` — there is no CLI
command, because the user types an idea and Claude does the rest. The
`make-video` and `grill-video` skills carry the instruction.

---

## 7. Continuity and scheduling

Three continuity modes decide what can run in parallel:

| Mode | Meaning | Execution |
|---|---|---|
| `independent` | No dependency | parallel |
| `reference-only` | Same look, not the same frame | parallel |
| `previous-shot` | Needs the prior clip's end frame | **serial** |

`src/planning/continuity-graph.ts` validates before anything runs:

- **No cycles** — detected by colour marking, so a shared tail is not
  mistaken for a cycle
- **No dangling references**
- **No dependency later than its dependant**
- **Long chains warn** — drift accumulates, but that is a quality risk rather
  than a correctness failure

The scheduler runs the parallel batch first, then each chain. A chain stops
at the first failure and marks everything downstream `skipped`: a shot whose
start frame does not exist must never be submitted.

One failure does not abort the parallel batch — other shots may already be
paid for.

---

## 8. Quality assurance

Three tiers, cheapest first.

### Tier 0 — anchor validation (before spending)

The highest-leverage check in the pipeline, because of the cost asymmetry:

```text
Soul 2 image      0.12 credits
Seedance 8s clip 20.00 credits      ~167x
```

A video model given a start and end frame fills in the middle, so a bad
anchor guarantees a bad clip. `src/qa/anchor.ts` validates before
`authorizeSpend` and **throws** on failure — proceeding would knowingly spend
20 credits on an input already known to be wrong.

Blocking checks: missing, corrupt, blank, too small. Retries are capped at
three; three failures means the prompt is wrong, not the generation.

### Tier 1 — machine QA (free, deterministic)

`src/qa/machine.ts`. Runs before any expensive judgement or paid retry:

- corrupt file, wrong duration, wrong format
- black frames, blank render, frozen video
- missing audio
- identity drift **within** a clip — the end frame compared to the first

A check that cannot run reports `unknown`, never `pass`.

### Tier 2 — vision QA (free, flags only)

`src/qa/vision.ts` extracts representative frames and builds contact sheets.
It **does not judge** — machine QA covers what can be measured, and anything
needing a look is presented rather than guessed at.

`autoSpendOnRetry` is `false`. This tier cannot burn credits on its own.

### Human review

Accept / retry / fallback, with a **failure class from a fixed list**:

```text
prompt-issue · bad-random-generation · model-capability-issue
continuity-issue · unusable
```

Validated against `quality-policy.json` rather than free text, because the
plan is to automate retry decisions from this data later, and free-text
labels would make it useless.

### Motion-ratio lint

Cost optimisation must not produce a slideshow:

- real motion ≥ 55% of runtime
- no still longer than 3 seconds
- no more than 2 consecutive stills
- opening and closing shots must move

**A Ken Burns move on a still does not count as motion.** That substitution
is precisely what the lint exists to detect.

Runs twice — after edit planning, and after fallbacks.

---

## 9. Gates and resumability

Gates **write state and exit**. They never block on stdin, and never poll.

```bash
npm run cost -- my-project        # stops, prints the estimate, exits
npm run approve -- my-project --gate cost
```

This makes a run safe against a closed terminal, a sleeping laptop, an SSH
disconnect, or an ended Claude session.

Gates are independent — approving `cost` does not unlock `look`. A rejected
gate stays blocked and reports its reason.

The one exception is `src/cli/wizard.ts`, which reads stdin during setup.
Nothing has been spent at that point and there is no run to resume.

---

## 10. The manifest

`manifest.json` records every paid generation. Two rules govern it:

**1. Written BEFORE submission.** A crash between submitting and completing
still leaves a recoverable entry, found by `findInFlight` and re-attached by
polling its job id rather than resubmitting.

**2. Never deleted, never rewritten.** `updateEntry` cannot change
`assetHash`, `prompt`, `model`, `provider` or `submittedAt` — rewriting that
history would break cost accounting.

### Asset identity

`computeAssetHash` covers every input that changes the output: kind, model,
prompt, duration, start/end frame **contents**, seed, settings.

Adding a new provider parameter **requires** adding it to the hash, or two
different generations collide and the second silently reuses the first.

An identical asset is reused, never repaid.

### Accounting

Unknown costs are surfaced via `unpricedEntries`, never counted as zero.
`assertFullyPriced` refuses a budget decision while any chargeable entry has
no recorded cost — treating unknown as `$0` understates spend and lets the
guard approve a call it should refuse.

---

## 11. Rendering

`edit-plan.json` compiles to a **HyperFrames project** — a directory
containing `hyperframes.json` and `index.html`, not a bare HTML file.

Timing lives in data attributes: `data-start`, `data-duration`,
`data-track-index`, `data-volume`, `data-has-audio`.

**Lint before render.** `hyperframes lint` costs seconds; discovering the
same mistake after a multi-minute headless-Chrome render costs the render.
On the first real run it caught six errors, two of them fatal:

- a `<video>` with `data-start` but no `id` renders **frozen**
- `muted` alongside `data-has-audio` **silences** the clip

Media is symlinked into `<project>/assets/` and referenced root-relative.
Paths traversing above the project root work in renders but 404 in preview.

FFmpeg remains the technical layer beneath: normalisation to locked project
settings, frame extraction, machine QA. Different model outputs never enter
the timeline directly.

---

## 12. Skills

Eight skills in `.claude/skills/`, in two kinds.

### User-invoked — you type them

| Skill | Questions | For |
|---|---:|---|
| `/make-video` | 4 | a quick test |
| `/grill-video` | up to 20 | a video worth spending on |

`grill-video` covers six rounds — genre, character, story, look, budget,
efficiency — re-prices after rounds 2, 5 and 6 so the cost moves as you
answer, and pushes back when runtime and budget do not fit.

Its final round exists purely to buy back budget: which shots need no
character reference, which could be a still, whether it is all one location.
That typically recovers 15–25%.

### Model-invoked — guardrails Claude reaches for automatically

| Skill | Protects |
|---|---|
| `verify-realism` | The eight prompt rules. Blocks generation with no character reference. |
| `verify-spend-safety` | No paid call without a budget check. No invented prices. |
| `verify-plan-coherence` | Artifacts agree; the graph executes; motion lint runs twice. |
| `verify-provider-contract` | Providers never enforce policy; recovery re-attaches. |
| `verify-schema-integrity` | Nothing unvalidated reaches execution. |
| `verify-project-conventions` | Strict TypeScript, config-driven behaviour. |

Encoding a rule as a skill beats writing a comment: a comment is read once, a
skill is enforced every time. These caught three cost bugs during
development.

---

## 13. What we learned the expensive way

Every item here is a real failure with a real cost.

### Identity needs an image, never a description

The character's face and jacket changed between shots because the model was
given words. Text cannot hold a face, and Kling 3.0 has no identity input at
all.

**Fix:** a six-image reference pack — 3 face angles lock identity, 3 body
shots lock wardrobe, and body shots must still show the face. A single
front-facing reference held in wide shots and failed in close-ups.

**This includes body parts.** A macro of "dirty bare hands" was generated
without the reference on the assumption that hands carry no identity. It came
back with a different person's hands and a different environment entirely.
**Cost: 20 credits.**

### One shot is one moment

A prompt saying "the pit deepens as time passes" compressed weeks into eight
seconds and read as fake. Progress belongs in the **cut between shots**.

### Match the genre, do not default to cinematic

Aerial drone pushes and golden hour were wrong for bushcraft content. Genre
must be established before any prompt is written.

### Prove the look on one shot first

Three clips were generated on an unvalidated style; all three shared the same
defect. Cost of being wrong drops from N clips to one.

### Cost bugs are subtle and expensive

Three reached the codebase during development, all caught by automated
checks:

- a manifest total counting an unknown cost as `$0`
- an estimate parser defaulting missing credits to `0`
- **settlement scaling the estimate by an actual/estimated ratio** — a 32×
  undercount that would have let a `$20` budget permit `$640`

Each looked reasonable while being written. That is the argument for
mechanical checks over care.

### Test on the target platform

The `gradients` FFmpeg filter exists in Homebrew's build but not Ubuntu's. A
test passed locally and failed in CI. The same filter was also used by the
fake provider, which would have broken `PROVIDER_MODE=fake` entirely on
Linux — CI did not catch that one; grepping for the same mistake elsewhere
did.

---

## 14. Known limitations

Documented rather than hidden.

**Blank detection cannot see through letterboxing.** Padding a 4:3 source
into 16:9 adds black bars, which are themselves high contrast. The check is
reliable on original downloads and on any source that fills the frame; on a
padded file it can only catch a clip blank edge to edge.

**Composition comparison is not identity verification.** A perceptual hash
compares light and dark structure, not who is in frame. Measured on real
assets, an empty landscape scored 80% against the character master while a
correct close-up scored 47%. It therefore **warns and never blocks**.
Judging identity properly needs vision QA or a human.

**Kling 3.0 cannot hold a recurring character.** No `image_references` slot.
It is offered for landscape and object work, with the consequence stated.

**No repair ladder yet.** Retries are currently binary: accept or regenerate.
A graduated ladder needs failure-pattern data the project does not have — two
retries so far. `failureClass` is collecting it.

**Per-second pricing is a wall.** Roughly `$0.20` per second of finished
video. A 20-minute video is about `$188`. No prompt technique moves this.

---

## 15. Design reference

Code comments cite these numbers. They come from the original design
document, and are preserved here so a citation resolves to a rule rather than
to a deleted file.

Each entry states the rule, then how it was actually implemented — including
where the built version departs from the design.

### §2 — Claude plans, code spends

Claude is responsible for understanding the idea, story, hooks, progression,
storyboard, prompts, edit decisions, and QA interpretation. Deterministic
code owns JSON validation, cost calculation, budget checks, paid submission,
polling, download, FFmpeg, machine QA, state, resume, and rendering.

**Claude must never improvise a paid API call.**

*Built:* `verify-spend-safety` fails any MCP call appearing in `src/`.
Verified: zero present.

### §6 — Three distinct planning artifacts

- `storyboard.json` — *what should the viewer see?*
- `edit-plan.json` — *how will the timeline present it?*
- `generation-plan.json` — *what paid assets do we actually need?*

Screen time is not generation time. A shot may occupy 6 seconds of timeline
while needing 3 seconds of motion and billing 5.

### §7 — Billable duration

Never assume arbitrary durations. If the edit needs 3.2s and the model bills
in 5s units, generate 5s and trim. **Rounding down is forbidden** — it would
leave the edit short of footage it planned for.

*Departure from the design:* §7 assumed every model exposes
`allowedDurations: [5, 10]`. The live API shows two shapes — discrete
(Seedance `[4, 8, 12]`) and continuous ranges (Kling 3–15). Discrete models
snap up; range models clamp to their floor. A sweep test asserts
`billableSeconds >= requiredSeconds` for both.

### §8 — Model configuration and selection

Each model records provider, cost, allowed durations, frame support, native
audio, resolution, fps, quality tier, enabled.

Selection stays deliberately simple: cheaper model for normal shots, quality
model for anchors, escalate on capability failure.

*Built:* escalation that raises cost **requires approval**. Auto-switching is
permitted only when free or cheaper. Where a price is unknown, tier ranking
decides — erring toward asking.

### §9 — Anchor shots

Roughly 2–4 shots per video carry the most weight: opening reveal, major
transformation, climax, final reveal. These get quality treatment; supporting
shots can use cheaper models.

### §12 — Three continuity modes

| Mode | Meaning | Execution |
|---|---|---|
| `independent` | no dependency | parallel |
| `reference-only` | same look, not the same frame | parallel |
| `previous-shot` | needs the prior clip's end frame | **serial** |

### §13 — Chain rules

A `previous-shot` sequence runs strictly in order, and **a bad shot_04 must
never cause paid generation of shot_05**. Graph validation checks for cycles,
missing references, and invalid shot ids before anything runs. Long chains
warn rather than fail — drift is a quality risk, not a correctness failure.

*Built:* `runChain` stops at the first failure and marks everything
downstream `skipped`.

### §14 — Independent-shot processing

Independent and reference-only shots run concurrently, capped. Polling uses
exponential backoff, a global job timeout, and retry-safe state.

*Built:* one failure does not abort the batch — other shots may already be
paid for.

### §15 — QA architecture

**Tier 1, free machine QA**, run before any expensive judgement: corrupt
file, wrong duration, black frames, blank video, frozen video, unexpected
fps, resolution mismatch, missing audio.

**Tier 2, vision QA**: extract frames and check intent, character, wardrobe,
environment, progression, morphing, anatomy, object consistency, start and
end similarity.

Vision QA **flags**. It does not autonomously spend retry credits.

*Built:* `autoSpendOnRetry: false` in `quality-policy.json`, asserted by a
test. Two additions the design did not anticipate: identity drift **within**
a clip (end frame vs first), and **tier 0 anchor validation** before any
spend at all.

### §16 — Human retry decision

A flagged shot goes to a human: **accept / retry / fallback**. The failure
class is recorded — `prompt-issue`, `bad-random-generation`,
`model-capability-issue`, `continuity-issue`, `unusable` — so that after the
first few videos the decision can be automated from real data.

*Built:* classes are validated against `quality-policy.json`, not free text.
Free-text labels would make the accumulated data useless.

### §17 — Fallback strategy

When a retry is not worth the cost, use a high-quality still with a subtle
move. One difficult shot must not block the whole project.

*Built:* `applyFallbacks` does not mutate the caller's plan, and the second
motion lint catches the case where several fallbacks together break the ratio.

### §18 — Motion-ratio policy

Cost optimisation must not produce a slideshow:

- real motion ≥ 55% of runtime
- no still longer than 3 seconds
- no more than 2 consecutive non-motion shots
- opening and closing shots must move

Run the lint **twice** — after edit planning, and again after failures and
fallbacks.

*Built:* a Ken Burns move on a still does **not** count as motion. That
substitution is exactly what the lint exists to detect.

### §19 — Budget protection

Before **every** paid call — first generation, retries, escalated models,
paid images, paid audio — check:

```text
current spend + expected call cost ≤ maxBudgetUSD
```

Otherwise **hard stop**. Not only at the approval gate.

*Built:* four guards — per-call ceiling, project budget, reservations so
parallel jobs cannot both claim the last dollar, and refusal when a cost
cannot be established. `HardStop` is never caught and continued.

### §20 — Dry run

Plan, storyboard, edit plan, generation plan, billable durations, model
choices and estimated cost, with **$0 spent**. Writes
`reports/cost-estimate.md`.

### §21 — Gates are resumable

Never keep the CLI waiting for interactive input. A gate writes state, prints
what the human needs, and exits. Approval is a separate invocation.

This makes a run safe against a closed terminal, a sleeping laptop, an SSH
disconnect, or an ended Claude session.

*Built:* gates are independent — approving `cost` does not unlock `look`. The
only stdin read is the setup wizard, where nothing has been spent and there
is no run to resume.

### §22 — Paid asset protection

**Never overwrite a paid asset.** Each generation gets an identity hashed
from prompt, model, start/end frame contents, duration and settings. An
identical asset is reused, never repaid.

*Built:* adding a new provider parameter **requires** adding it to
`computeAssetHash`, or two different generations collide and the second
silently reuses the first.

### §23 — Manifest

Every paid generation is written to `manifest.json` **before** polling and
download finish, so a crash after submission still leaves the job
recoverable.

Records: shot, asset hash, provider, model, prompt, seed, job id, remote URL,
submission time, billable duration, estimated and actual cost, status, local
file, accepted.

*Built:* entries are never deleted, and `updateEntry` cannot rewrite
`assetHash`, `prompt`, `model`, `provider` or `submittedAt`.

### §24 — Prompt library

No separate prompt-library workflow. An accepted shot already carries its
prompt, model, seed and quality result in the manifest, so the library is a
**query over historical manifests** and improves automatically.

### §25 — Proof mode

About 15 seconds and 3 shots, using the **actual** production model,
resolution, prompt process, references, QA and render path. Proof assets live
in the same project and manifest, so accepted proof shots are reused in the
full video rather than regenerated.

### §26 — FFmpeg normalisation

Project settings are locked at initialisation — width, height, fps,
colorspace. Every clip is downloaded, normalised, and only then enters the
timeline. Different model outputs never go in directly.

*Built:* scaling **pads rather than crops**, so nothing composed into the
frame is silently discarded. A silent source is given a generated audio
track, without which concatenation drops audio from every later clip.

### §27 — HyperFrames role

HyperFrames is the creative editing layer: cuts, timing, transitions, Ken
Burns, zoom, pan, speed, overlays, captions, music, SFX, mixing, final
composition. FFmpeg stays the technical layer beneath it.

*Built:* lint before render. On the first real run it caught six errors, two
fatal — a `<video>` without an `id` renders frozen, and `muted` alongside
`data-has-audio` silences the clip.

### §29 — Final QA is report only

Checks runtime, resolution, fps, audio presence, black frames, render
corruption, motion ratio and suspicious shots. It writes `qa-report.json` and
**does not trigger paid regeneration**. The human decides whether further
spending is worthwhile.

### §30 — Thumbnail

An explicit stage, taken from the **final-resolution output** so it matches
what a viewer sees.

*Built:* the strongest frame is chosen by in-frame contrast across 12
candidates, sampled away from the edges where fades live.

### §33 — Project layout

```text
projects/<name>/
├── idea.md
├── state.json          where the run is
├── manifest.json       what has been paid for
├── planning/           the ten artifacts
├── references/         character, environment, props, style, progression
├── storyboard/         contact sheet and frames
├── shots/              original.mp4, normalized.mp4, frames
├── stills/  audio/  checkpoints/  logs/
├── reports/            cost-estimate.md, cost.md, qa-report.json
└── output/             final.mp4, thumbnail.png
```

*Built:* adds `hyperframes/` for the compiled composition.

### §34 — CLI stages

Each stage is a separate command that writes state and exits:

```text
plan:story · plan:audio · plan:storyboard · plan:edit · plan:generation
cost · approve · gen:references · gen:shots
qa:machine · qa:vision · review · render · upscale · thumbnail
qa:final · report
```

Plus `--proof`, `--dry-run`, `--resume`.

*Built:* adds `budget` (price a plan without creating anything), `start` (the
setup wizard), `status`, and `doctor`.

### §35 — Zod validation

Every planning artifact is validated before it can drive execution: story,
music, beat grid, progression, continuity, shotlist, storyboard, edit plan,
generation plan, audio plan, state, manifest.

**Invalid JSON must fail before any paid API call.**

### The five rules that matter most

1. Claude plans; deterministic code spends.
2. Plan the timeline before paying for video generation.
3. Check the budget before every single paid call.
4. Never regenerate or overwrite a paid asset that can be reused.
5. A continuity-chain shot must pass QA before the next dependent shot is
   generated.
