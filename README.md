# Agentic Video Pipeline

[![CI](https://github.com/ronyantonydev/agentic-video-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/ronyantonydev/agentic-video-pipeline/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

**Turn one sentence into a finished video — without losing control of the
budget.**

You describe an idea. Claude interviews you, prices the options, and waits.
You choose. Then deterministic code does the spending, checks every clip, and
renders the result.

```text
your idea → interview → price → you choose → generate → QA → edit → final.mp4
```

Built after a real video was rejected for looking like *"imagination, not
DIY"*. Everything here exists because something went wrong first.

---

## 30-second setup

```bash
git clone https://github.com/ronyantonydev/agentic-video-pipeline
cd agentic-video-pipeline
npm install
cp .env.sample .env
npm run doctor
```

`doctor` tells you what is missing. You need **Node 22+**, **FFmpeg**
(`brew install ffmpeg`), and a **Higgsfield account** with credits.

Then start talking:

```bash
claude
```

```text
/plan-video rain arriving on a dry riverbed, 15s, $5
```

That plans and prices the whole thing and stops at two reference pictures.
Look at them, then `/run-video rain-riverbed` to build it. For a quick test
without the split, `/make-video` does it in one go.

---

## Why this exists

### 1. AI video is priced per second, and it adds up fast

Ask for a 20-minute video and you are asking for about **$188** of
generation. Most tools discover this after you have spent it.

This one tells you first:

```bash
npm run budget -- --budget 20 --runtime 90
```

```text
  Budget $20.00 = 319 credits (12% held back for reference images and retries)

→ Seedance 2.0 Mini        90s   15 shots    225cr  $14.11
  Kling 3.0                90s   15 shots    135cr   $8.46
    ! no identity references: a recurring character will change
      appearance between shots
  Seedance 2.0 (1080p)     31s    5 shots    279cr  $17.49
    ! budget covers 31s of the 90s requested
```

Nothing is spent. Cheaper options are always shown, with what they cost you
in quality.

### 2. A budget you can exceed is not a budget

Four guards, all in code, all before the money moves:

- **Per-call ceiling** — no single generation above `MAX_SINGLE_CALL_USD`
- **Project budget** — `spent + this call ≤ MAX_BUDGET_USD`, checked before
  every paid call
- **Reservations** — two parallel jobs cannot both claim the last dollar
- **Unknown cost = refusal** — a price that cannot be established stops the
  run rather than being guessed

Failed generations are not charged, and release their reservation
automatically.

### 3. The same character keeps turning into a different person

Text descriptions cannot hold a face. The first paid run put *"weathered man
in a green jacket"* in every prompt and got a different man each time.

The fix is a **reference image**, fed into every shot — including shots of
just their hands. `verify-realism` enforces it, and blocks generation when no
reference exists.

### 4. Cost-cutting quietly turns a video into a slideshow

Replacing a failed clip with a photograph is cheap. Do it three times and the
video is dead.

**Motion-ratio lint runs twice** — after edit planning, and again after any
fallbacks. A panning photograph does not count as motion, which is exactly
the substitution it is looking for.

---

## Talk to it

Four skills. Two run the whole thing in one go; two split it in half so you
can price and inspect before committing.

**Plan first, then run** — the safer shape, and the one to prefer for
anything that costs real money:

| | Spends | Ends at |
| --- | --- | --- |
| `/plan-video` | ~2 credits on reference plates | you looking at the plates |
| `/run-video` | the rest of the plan | a finished video |

```text
/plan-video rain arriving on a dry riverbed, 15s, $5
```

`plan-video` writes every artifact, checks them against each other, prices
the **whole** job — plates and retries included, not just the shots — and
generates the cheap reference images. Then it stops. You look at two pictures
and decide. `/run-video` takes it from there and makes no creative choices at
all; if it wants one, the plan was incomplete and it says so.

Why the split: every expensive failure on this project was a planning
failure, not a generation failure. A winter forest that came back summer (no
environment sheet), wrong hands (no reference attached), three rejected clips
that shared one defect (none checked before the next). None needed a better
model. All needed a better plan — and a look before the money moved.

**One shot, no split** — for a quick test, or when you would rather answer
questions than review a plan:

| | Questions | Use it for |
| --- | ---: | --- |
| `/make-video` | 4 | a quick test |
| `/grill-video` | up to 20 | a video worth real money |

```text
/grill-video restoring an old motorcycle
```

**`grill-video`** covers six rounds — genre, character, story, look, budget,
efficiency — re-prices as you answer, and argues when the numbers do not fit:

> *"90 seconds needs about $14. At $8 you get 50 seconds. Shorter video, or
> bigger budget?"*

Its final round exists purely to buy back budget: which shots need no
character reference, which could be a still, whether it is all one location.
**That typically recovers 15–25%.**

Both stop and wait for you to choose before anything is generated.

> Type the slash command. If you just describe an idea, Claude picks a skill
> for you — and it cannot know whether this video matters enough for the long
> interview.

---

## Or drive it yourself

Every stage is a separate command that writes state and exits, so a run
survives a closed laptop.

```bash
npm run budget  -- --budget 20 --runtime 90   # price it, spend nothing
npm run start                                  # 4 questions, then create

npm run plan:story      -- my-project          # validate what Claude wrote
npm run plan:audio      -- my-project
npm run plan:storyboard -- my-project
npm run plan:edit       -- my-project          # motion lint #1
npm run plan:generation -- my-project

npm run cost    -- my-project --dry-run        # full price, $0 spent
npm run cost    -- my-project                  # asks for approval, exits
npm run approve -- my-project --gate cost

npm run qa:machine -- my-project               # free, deterministic
npm run qa:vision  -- my-project               # frames for a human to judge
npm run review     -- my-project               # accept / retry / fallback
npm run render     -- my-project               # HyperFrames → final.mp4
npm run thumbnail  -- my-project
npm run qa:final   -- my-project
npm run report     -- my-project

npm run status  -- my-project                  # where did it stop?
npm run debug   -- my-project                  # bundle for a bug report
```

The `plan:*` commands **validate**; they never author. Planning JSON is
written by Claude — that separation is what keeps *"Claude plans, code
spends"* honest.

---

## Skills reference

Skills live in `.claude/skills/`. Two kinds:

**User-invoked** — you type them. They orchestrate.

| Skill | What it does |
| --- | --- |
| `/plan-video` | Plans everything, prices everything, makes the cheap plates. Stops for one look. Free apart from ~2 credits. |
| `/run-video` | Executes an approved plan. No creative decisions — a missing decision means the plan was incomplete. |
| `/make-video` | Four questions, prices it, builds it. For a quick test. |
| `/grill-video` | Twenty questions across six rounds. For a video worth spending on. |

`plan-video` writes `plan.json`, which fully determines the run — it is the
contract `run-video` executes, and deliberately one data structure rather
than intent spread across a conversation.

**Model-invoked** — Claude reaches for these automatically when the task
fits. They are guardrails, not workflows.

| Skill | What it protects |
| --- | --- |
| `verify-realism` | The four prompt rules. Blocks generation when no character reference exists. |
| `verify-spend-safety` | No paid call without a budget check. No invented prices. `HardStop` is terminal. |
| `verify-plan-coherence` | Artifacts agree, continuity graph is executable, motion lint runs twice. |
| `verify-provider-contract` | Providers never enforce policy; recovery re-attaches rather than resubmitting. |
| `verify-schema-integrity` | Nothing unvalidated reaches execution; paid work is never lost or double-charged. |
| `verify-project-conventions` | Strict TypeScript, config-driven behaviour, typed errors. |

---

## The four prompt rules

Each one cost real credits to learn. `verify-realism` enforces them.

**1. Identity needs a reference image, never a text description.**
Generate one character reference and feed it into every shot showing that
person — *including shots of just their hands*. Use a model with an
`image_references` slot (Seedance, Wan). Kling has none.

**2. One shot = one moment.**
Never `time-lapse`, `as time passes`, `progressively`. Progress belongs in
the cut between shots; the viewer infers the weeks.

**3. Match the genre.**
Bushcraft is handheld, close, flat overcast, muddy. Not drone shots and
golden hour. Establish the genre *before* writing any prompt.

**4. Handmade must look handmade.**
Tool marks, irregular timber, salvaged glass — not architectural glazing.

Plus: **prove a new look on one shot before generating the set.** Three
rejected clips shared the same defect because none was checked first.

---

## What it actually costs

Measured from a real 80-second video, not estimated:

| | |
| --- | --- |
| Runtime | 79.6s across 14 shots |
| Spend | 259.84 credits (~$16.29) |
| Rate | Seedance 2.0 Mini bills 2.5 credits/second |

**≈ $0.20 per second of finished video.** A 20-minute video is about $188.
That per-second rate is a wall; no prompt technique moves it.

A test asserts this rate reproduces the real spend, so a wrong figure fails
the suite instead of your budget.

---

## Who spends the money

One setting in `.env`:

```bash
PROVIDER_MODE=mcp
```

| Mode | Who pays | Reaches | Notes |
| --- | --- | --- | --- |
| `mcp` | Claude, via your subscription credits | Kling, Veo, Seedance, Cinema Studio | No API key. **Start here.** |
| `rest` | Node, via a Higgsfield Cloud key | dop, soul | Budget checks fully mechanical. Cloud bills from a **separate wallet** that must be funded on its own. |
| `fake` | nobody | synthesised media | Development and CI. |

For `mcp`, add these to `~/.claude/settings.json` under `permissions.allow`,
then restart Claude Code:

```json
"mcp__claude_ai_Higgsfield__balance",
"mcp__claude_ai_Higgsfield__models_explore",
"mcp__claude_ai_Higgsfield__generate_image",
"mcp__claude_ai_Higgsfield__generate_video",
"mcp__claude_ai_Higgsfield__jobs_wait",
"mcp__claude_ai_Higgsfield__transactions"
```

---

## Where things live

```text
.claude/skills/         the skills, loaded by Claude Code
config/                 models, project defaults, quality thresholds
src/                    the pipeline
projects/<name>/
├── state.json          where the run is; resume reads this
├── manifest.json       every paid generation, written before submission
├── planning/           the JSON Claude writes
├── references/         character and environment references
├── shots/              original.mp4, normalized.mp4, qa frames
├── hyperframes/        the compiled composition
├── reports/            cost.md, qa-report.json
└── output/             final.mp4, thumbnail.png
```

Generated media is git-ignored — large, and reproducible from the manifest.
Planning JSON is committed, because it is the valuable part.

---

## Resuming

Nothing blocks on input. Every stage writes state and exits, so a closed
terminal or a sleeping laptop loses nothing:

```bash
npm run status  -- my-project
npm run approve -- my-project --gate cost
```

A crash mid-generation is recoverable too: the manifest records each job
*before* submission, so an interrupted run re-attaches to work already paid
for rather than paying twice.

---

## Development

```bash
npm test          # 305 tests
npm run typecheck
npm run doctor
```

`PROVIDER_MODE=fake` exercises the whole pipeline with synthesised media and
no cost — real H.264 files, so QA and rendering run for real.

---

## Stack

**Claude** plans. **Higgsfield** generates (Seedance, Kling, Veo, Soul).
**FFmpeg** normalises and checks. **HyperFrames** edits and renders.
**Zod** validates every artifact before it can drive a paid call.

---

## Reporting a problem

If a video comes out wrong, the video alone cannot explain why. Run:

```bash
npm run debug -- my-project
```

That writes a zip of about 1MB containing what a diagnosis needs: `state.json`
(where it stopped, which shots failed and their failure class),
`manifest.json` (every generation with its prompt, model, seed and cost),
`qa-report.json`, the planning JSON, `run.log`, sample frames from each shot,
and your Node/FFmpeg/provider versions.

It deliberately **excludes the video** — the real one is over 100MB, and the
sampled frames show the same defect.

It also **strips secrets rather than trusting them to be absent**. Your `.env`
is never collected, and anything matching a key, token or authorization
pattern in the collected files is redacted first, keeping only the last four
characters so lines can still be correlated. A test asserts no fragment of a
redacted value survives.

## Documentation

| | |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | How it works and why — stages, budget guards, QA tiers, skills, what we learned the expensive way, and the numbered design rules the code cites |
| [docs/testing-plan-video.md](docs/testing-plan-video.md) | How to test `/plan-video` — what to run, what to verify at the stop, and what to do when the plan is not good |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, the rules that matter, how to test |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: never let a cost
be guessed, and read `verify-spend-safety` before touching anything that
spends.

## License

[MIT](LICENSE)
