# The Pipeline in Plain English

A beginner's tour of the 31 stages. If you want the reasoning, the trade-offs,
and the rules the code cites, read [architecture.md](architecture.md) instead.
This page just answers: *what does each step actually do?*

---

## The one-sentence version

You describe a video. The pipeline writes the story, prices it, shows you cheap
test images, stops for your approval, generates the real shots, checks them,
stops again, then assembles and renders the finished file.

---

## The shape of it

```text
        PLAN (free)                    CHECK (cheap)              MAKE (paid)
  ┌──────────────────────┐      ┌──────────────────────┐   ┌──────────────────┐
  │ story → shots →      │      │ reference images →   │   │ generate shots → │
  │ prompts → price      │ ───► │ do they match? →     │──►│ QA → render      │
  │                      │      │ you look at them     │   │                  │
  └──────────────────────┘      └──────────────────────┘   └──────────────────┘
           🛑 cost                      🔒 + 🛑 look              🛑 review
```

Money is only spent in the last two boxes, and never before a gate has let it
through.

---

## Every stage, one at a time

### Planning — nothing is spent yet

| # | Stage | What it does |
|---|---|---|
| 1 | `init` | Creates the project folder and the state file that tracks everything. |
| 2 | `story` | Claude writes the actual story — the idea, the beats, the arc. |
| 3 | `music` | Picks or plans the music track the video will be cut to. |
| 4 | `beat-grid` | Marks where the musical beats land, in seconds. Cuts will land on these. |
| 5 | `progression` | Decides how the video builds — where it escalates, where it rests. |
| 6 | `continuity` | Works out what must stay consistent between shots: same face, same room, same jacket. |
| 7 | `shotlist` | Breaks the story into individual shots. This is the first time you see "shot 1, shot 2, shot 3…". |
| 8 | `storyboard` | Writes the actual text prompt for each shot — what the AI model will be told to make. |
| 9 | `edit-plan` | Decides the timeline: which shot plays when, for how long, and how it cuts to the next. |
| 10 | `motion-lint-1` | A sanity check on the plan: is there enough real movement, or is this secretly a slideshow? |
| 11 | `generation-plan` | Turns the storyboard into concrete jobs: this model, this resolution, this many seconds. |
| 12 | `cost-estimate` | Adds up what all of that will cost, in credits and dollars. |

### 🛑 Gate 1 — cost

**Stage: `gate-cost`.** The pipeline stops and shows you the bill.

**Important:** this gate approves *itself* if the estimate fits the budget you
already stated. You picked a number; being asked to re-confirm the same number
is pointless. It only stops for a human when:

- the estimate is **over** your budget, or
- some shot has **no known price** (it refuses to approve an unknown total).

```bash
npm run cost -- my-project              # prints the estimate
npm run approve -- my-project --gate cost
```

### Reference images — cheap spending starts here

| # | Stage | What it does |
|---|---|---|
| 13 | `references` | Generates cheap still images of your characters, locations and props. These are the "this is what things look like" plates. |
| 14 | 🔒 `reference-check` | **Automatic gate.** Code compares the plates against each other. Do they actually show the same person, the same place? If not, the run stops on its own — no human needed. |
| 15 | `target-frames` | Generates the start (and sometimes end) frame for each shot, built from the approved references. |
| 16 | `contact-sheet` | Lays every plate and frame onto one image so you can judge the whole look in a single glance. |

### 🛑 Gate 2 — look

**Stage: `gate-look`.** The pipeline stops and asks you to look at the contact
sheet. This is the last cheap moment. Everything after this is expensive video
generation, so this is where you catch a wrong face or a wrong mood.

```bash
npm run approve -- my-project --gate look
```

### Generation — the expensive part

| # | Stage | What it does |
|---|---|---|
| 17 | `generate-shots` | The real work. Each shot is sent to a video model and generated. |
| 18 | `normalize` | Makes every returned clip consistent — same resolution, same frame rate, same colour space. |
| 19 | `qa-machine` | Automatic checks: is it black, is it frozen, is it the right length, did it come back corrupt? |
| 20 | `qa-vision` | Claude actually *watches* the frames and judges whether the shot matches what was asked for. |

### 🛑 Gate 3 — review

**Stage: `review`.** Every shot that QA flagged is waiting for your decision:
keep it, retry it, or drop it to a **fallback still** (an animated photo instead
of real motion).

This gate closes only when **no shot is left undecided** — the code refuses to
mark it approved while anything is still pending.

### Finishing — assembly

| # | Stage | What it does |
|---|---|---|
| 21 | `motion-lint-2` | Runs the movement check *again*. Fallback stills each look fine alone, but three of them together turn the video into a slideshow. This catches that. |
| 22 | `audio-finalize` | Locks the music and any other audio to the final cut. |
| 23 | `render` | FFmpeg assembles all the clips, cuts and audio into one video file. |
| 24 | `upscale` | Raises the resolution of the finished video. |
| 25 | `thumbnail` | Makes the cover image. |
| 26 | `qa-final` | One last check on the actual finished file. |
| 27 | `report` | Writes up what was made and what it really cost. |
| 28 | `done` | Finished. |

---

## How gates actually work

The thing people get wrong: **a gate never sits there waiting for you to type.**

It writes its state to disk, prints what you need to decide, and **exits**. You
approve later with a separate command. That means you can close the terminal,
shut the laptop, lose the SSH connection, or end the Claude session — and the
run picks up exactly where it stopped.

```bash
npm run approve -- my-project --gate cost
npm run approve -- my-project --gate look
```

Each gate is independent. Approving `cost` does not unlock `look`. A rejected
gate stays blocked and tells you why.

The only place that reads your keyboard directly is the setup wizard
(`src/cli/wizard.ts`) — nothing has been spent at that point and there is no run
to resume.

---

## Why motion lint runs twice

It is the one stage that looks like a duplicate but isn't.

- **Pass 1** (stage 10) checks the *plan*: on paper, does this video move enough?
- **Pass 2** (stage 21) checks the *result*: after failed shots were swapped for
  stills, does it *still* move enough?

Each individual fallback is a reasonable decision. Three of them stacked up is a
slideshow, and only the second pass can see that.

---

## Where the money can go

| Stage | Cost |
|---|---|
| 1–12 (planning) | free |
| 13–16 (references, frames) | cheap — still images |
| 17 (generate-shots) | **this is the bill** |
| 24 (upscale) | small |
| everything else | free |

Every paid call passes through `authorizeSpend` in `src/budget/guard.ts` first,
and that is plain code, not Claude. See
[architecture.md § 4](architecture.md#4-budget-protection) for the four guards.
