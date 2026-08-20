# Architecture

How the pipeline is built, and why each part is the shape it is.

This describes the system **as built**, not as originally planned. Where the
two differ, the reason is recorded — usually because something failed and
cost credits to discover. The original design document is preserved at
[video-automation-architecture.md](video-automation-architecture.md).

---

## Contents

1. [The core principle](#1-the-core-principle)
2. [Pipeline stages](#2-pipeline-stages)
3. [Who spends money](#3-who-spends-money)
4. [Budget protection](#4-budget-protection)
5. [Cost resolution](#5-cost-resolution)
6. [Planning artifacts](#6-planning-artifacts)
7. [Continuity and scheduling](#7-continuity-and-scheduling)
8. [Quality assurance](#8-quality-assurance)
9. [Gates and resumability](#9-gates-and-resumability)
10. [The manifest](#10-the-manifest)
11. [Rendering](#11-rendering)
12. [Skills](#12-skills)
13. [What we learned the expensive way](#13-what-we-learned-the-expensive-way)
14. [Known limitations](#14-known-limitations)

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

Thirty ordered stages in `src/schemas/state.ts`. Order matters — resume
compares indexes, so a gate provably precedes the work it guards.

```text
init → story → music → beat-grid → progression → continuity → shotlist
     → storyboard → edit-plan → motion-lint-1 → generation-plan
     → cost-estimate → 🛑 gate-cost
     → references → target-frames → contact-sheet → 🛑 gate-look
     → generate-shots → normalize → qa-machine → qa-vision → 🛑 review
     → motion-lint-2 → audio-finalize → render → upscale → thumbnail
     → qa-final → report → done
```

Three human gates. Motion lint runs twice — once on the plan, once after
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
