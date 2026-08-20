# Agentic Video Pipeline

Turn one sentence into a finished video. Claude plans; deterministic code
spends.

```
your idea → story → shots → prompts → generation → QA → edit → final.mp4
```

---

## What you need

| | |
|---|---|
| **Node 22+** | `node -v` — HyperFrames requires it |
| **FFmpeg** | `brew install ffmpeg` |
| **Higgsfield account** | with credits, for generation |
| **Claude Code** | with the Higgsfield MCP connector |

---

## First run

### 1. Install

```bash
npm install
```

### 2. Configure

```bash
cp .env.sample .env
```

Open `.env` and set **who spends money**:

```bash
PROVIDER_MODE=mcp     # Claude calls Higgsfield, billed to your subscription
```

Three modes:

- **`mcp`** — uses your Higgsfield subscription credits. No API key needed.
  Reaches Kling, Veo, Seedance. **Start here.**
- **`rest`** — Node calls the Higgsfield Cloud API directly using a key.
  Budget checks are fully mechanical. Note that Cloud bills from a *separate*
  wallet that must be funded on its own.
- **`fake`** — synthesised media, no network, no cost. For development.

Then set your ceiling:

```bash
MAX_BUDGET_USD=20        # code refuses any call that would exceed this
MAX_SINGLE_CALL_USD=3    # and any single call above this
```

### 3. Grant MCP permissions

For `PROVIDER_MODE=mcp`, add these to `~/.claude/settings.json` under
`permissions.allow`:

```json
"mcp__claude_ai_Higgsfield__balance",
"mcp__claude_ai_Higgsfield__models_explore",
"mcp__claude_ai_Higgsfield__generate_image",
"mcp__claude_ai_Higgsfield__generate_video",
"mcp__claude_ai_Higgsfield__jobs_wait",
"mcp__claude_ai_Higgsfield__transactions"
```

Restart Claude Code afterwards — settings load at session start.

### 4. Check everything works

```bash
npm run doctor
```

Every line should be green before you continue.

---

## Making a video

### Start with the budget

```bash
npm run budget -- --budget 20 --runtime 90
```

This spends nothing. It tells you which model your money buys:

```
  Budget $20.00 = 319 credits (12% held back for reference images and retries)

→ Seedance 2.0 Mini        90s   15 shots    225cr  $14.11
  Kling 3.0                90s   15 shots    135cr   $8.46
    ! no identity references: a recurring character will change
      appearance between shots
  Seedance 2.0 (1080p)     31s    5 shots    279cr  $17.49
    ! budget covers 31s of the 90s requested
```

The arrow marks the recommendation. Cheaper models are always shown, with
what they cost you in quality.

### Then create the project

```bash
npm run start
```

It asks four questions — idea, runtime, budget, whether the same person
appears in several shots — prices the answer, and only then creates anything.

Non-interactive:

```bash
npm run start -- --idea "a man building an underground shelter" \
                 --runtime 90 --budget 20
```

### Then plan, price, approve, generate

Claude writes the planning JSON into `projects/<name>/planning/`. Each command
below **validates** it and moves the run forward:

```bash
npm run plan:story      -- my-project
npm run plan:audio      -- my-project
npm run plan:storyboard -- my-project
npm run plan:edit       -- my-project    # motion-ratio lint #1
npm run plan:generation -- my-project

npm run cost -- my-project --dry-run     # full price, $0 spent
npm run cost -- my-project               # requests approval, then stops

npm run approve -- my-project --gate cost
```

After approval, generation, QA, and render:

```bash
npm run qa:machine -- my-project    # free, deterministic
npm run qa:vision  -- my-project    # extracts frames for a human to check
npm run review     -- my-project    # accept / retry / fallback
npm run render     -- my-project    # HyperFrames → final.mp4
npm run thumbnail  -- my-project
npm run qa:final   -- my-project
npm run report     -- my-project
```

Check where a run is at any point:

```bash
npm run status -- my-project
```

---

## How the budget is protected

Four independent guards, all in code:

1. **Per-call ceiling** — no single generation above `MAX_SINGLE_CALL_USD`
2. **Project budget** — `spent + this call ≤ MAX_BUDGET_USD`, checked before
   every paid call
3. **Reservations** — two parallel jobs cannot both claim the last dollar
4. **Unknown cost = refusal** — a price that cannot be established stops the
   run rather than being guessed

Failed generations are not charged and release their reservation
automatically.

---

## Quality checks

Cheaper models produce weaker footage, but the floor holds regardless of
budget.

**Machine QA** (free, automatic) rejects: corrupt files, wrong duration,
black frames, blank renders, frozen video, missing audio, wrong format.

**Vision QA** (free) extracts frames for inspection. It flags; it never
spends. A human decides accept / retry / fallback.

**Motion-ratio lint** runs twice — after edit planning, and again after any
fallbacks — so cost-cutting cannot quietly turn the video into a slideshow.

---

## Four rules for prompts

Learned from a paid run that was rejected. `docs/skills/verify-realism/`
enforces them.

1. **Identity needs a reference image, never a text description.** Generate
   one character reference and feed it into every shot showing that person —
   including shots of just their hands. Use a model with an
   `image_references` slot (Seedance, Wan). Kling has none.

2. **One shot = one moment.** Never `time-lapse`, `as time passes`,
   `progressively`. Progress belongs in the cut between shots.

3. **Match the genre.** Bushcraft is handheld, close, flat overcast light,
   muddy. Not drone shots and golden hour.

4. **Handmade must look handmade.** Tool marks, irregular timber, salvaged
   materials — not architectural glazing.

Plus: **prove a new look on one shot before generating the set.**

---

## Where things live

```
projects/<name>/
├── idea.md
├── state.json          where the run is; resume reads this
├── manifest.json       every paid generation, written before submission
├── planning/           the JSON Claude writes
├── references/         character and environment references
├── shots/              original.mp4, normalized.mp4, frames
├── hyperframes/        the compiled composition
├── reports/            cost.md, qa-report.json
└── output/             final.mp4, thumbnail.png
```

Generated media is git-ignored — it is large and reproducible from the
manifest. Planning JSON is committed, because it is the valuable part.

---

## Resuming

Every stage writes state and exits. Nothing blocks on input, so a closed
terminal or a sleeping laptop loses nothing:

```bash
npm run status -- my-project     # see where it stopped
npm run approve -- my-project --gate cost
```

A crash mid-generation is recoverable too: the manifest records each job
before submission, so an interrupted run re-attaches to jobs already paid for
rather than resubmitting them.

---

## Development

```bash
npm test          # 305 tests
npm run typecheck
npm run doctor
```

Set `PROVIDER_MODE=fake` to exercise the whole pipeline with synthesised
media and no cost.

---

## What it actually costs

Measured, not estimated — from a real 80-second video:

| | |
|---|---|
| Runtime | 79.6s, 14 shots |
| Spend | 259.84 credits (~$16.29) |
| Rate | Seedance 2.0 Mini bills 2.5 credits/second |

So roughly **$0.20 per second** of finished video at that quality. A
20-minute video is about $188 — the per-second rate is the wall, and no
prompt trick moves it.
