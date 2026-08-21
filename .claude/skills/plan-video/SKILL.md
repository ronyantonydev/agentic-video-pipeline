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

### Ask what they want BEFORE asking what they will pay

**Length and quality first. Then price it, then let them choose.**

Opening with "what is your budget?" gets the order backwards, and it fails in
a specific way: to make the budget options mean anything you have to attach a
runtime to each of them —

```text
$30   ~2.5 minutes at Mini quality
$15   ~75 seconds
```

— and now **the runtime was chosen for the user**, by you, from a number they
picked for an entirely different reason. That is the thing "never quietly plan
a shorter video" exists to forbid, done one step earlier and less visibly.

The budget is a **ceiling on a thing**. Ask what the thing is first.

So, when no `--quick` / `--grill` flag was given:

1. **How long, in seconds?** Take it from the idea if it carries one
   (`"...3 minutes"`), otherwise ask. This is the only question that decides
   how many shots exist.
2. **What quality?** Three real answers, and the price gap between them is
   large enough to be a genuine choice:

   | | Model | 3 min (27 × 5s) | Reads as |
   |---|---|---|---|
   | Budget | `seedance_2_0_mini` throughout | 338cr, **\$21** | 720p, fine, the default |
   | Tiered | Mini + `seedance_2_0` on 4 anchors | 468cr, **\$29** | the shots carrying the film get the better model |
   | Quality | `seedance_2_0` throughout | 1215cr, **\$76** | only when every second must hold up |

   Measured, not estimated: Mini is 12.5cr per 5s shot, `seedance_2_0` is
   45cr - **3.6× dearer**. Tiering four anchors costs +39% over all-Mini,
   which is the interesting middle and usually the right answer.

3. **Does the same person appear in several shots?** See
   [[verify-realism]] rule 1 - "hands only" still counts as yes.
4. **Now price it and show the table:**

   ```bash
   npm run budget -- --budget <ceiling-guess> --runtime <seconds>
   ```

   Show what each tier costs for the runtime they asked for. **This is where
   the budget question belongs** - by now it is "does this number work for
   you", asked against real figures, rather than a riddle.

5. **Recommend the interview mode with the number attached**, and offer the
   other. Above ~\$10, `--grill`'s efficiency round usually recovers 15-25%,
   which more than pays for the extra questions. Below it, recommend
   `--quick` and say why.

**Never ask when a flag was given.** An explicit `--quick` or `--grill` is
the answer; asking again re-opens a decision the user already made.

### When the budget will not buy the runtime

Once you have both, check whether they can both be true:

```bash
npm run budget -- --budget <usd> --runtime <seconds>
```

If the runtime costs more than the budget, **stop and show the numbers** — see
the same rule in [[make-video]] for the message shape and the four rules
governing it. Lead with what they asked for, then what their money buys, and
offer at least one middle option. Never quietly plan a shorter video: they
gave a runtime *and* a budget, and when both cannot hold, choosing for them
delivers something they did not ask for.

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
2. **Create the project — AFTER the model is chosen, never before.**

   ```bash
   npm run init -- <project> --idea "<idea>" --budget <usd>
   ```

   `--budget` is the ceiling the guard enforces, and it depends on which
   model was picked: the same 3-minute video is ~\$17 on Kling and ~\$28 on
   Seedance Mini. Init before that choice and you are guessing, so the cost
   gate blocks on a number nobody agreed to.

   If the budget does need to change later, say so and use
   `npm run set-budget -- <project> --budget <usd>`. Never raise it silently
   to clear a gate — the ceiling is the user's decision, not a formality.
3. **Decide the runtime split BEFORE the shotlist.** See "Runtime is not all
   generated" below. This decides how many shots exist, so deciding it after
   the shotlist means rewriting the shotlist.
4. **Write the ten planning artifacts.** Each answers exactly one question,
   and every one is Zod-validated. `npm run plan:*` where a generator exists.

   | File | Answers |
   |---|---|
   | `story.json` | What is the story? Title, logline, hook, beats. |
   | `music.json` | What does it sound like? Mood, genre, BPM, energy curve. |
   | `beat-grid.json` | Where can cuts land? Every usable cut point, from the BPM. |
   | `progression.json` | What changes from start to end? The stages, in order. |
   | `continuity.json` | What must stay the same? Face, wardrobe, location, light, palette, negative prompt. |
   | `shotlist.json` | Which shots, in what order, with what dependencies? |
   | `storyboard.json` | What should the viewer SEE? Prompts, frames, which references attach. |
   | `edit-plan.json` | WHEN do they see it? Times, durations, transitions, captions. |
   | `generation-plan.json` | What do we actually PAY for? Generated clips only. |
   | `audio-plan.json` | Music, SFX and narration cues. |

   Two distinctions the names hide:

   - **storyboard vs edit-plan** - the storyboard is what the viewer sees; the
     edit plan is when. Same shots, different question.
   - **shotlist vs generation-plan** - the shotlist holds every timeline item,
     the generation plan only the ones that cost money. The difference is the
     composed material, and it is the runtime split made concrete.

   Two things that are easy to leave empty and expensive to skip:

   - **`startFramePrompt` / `endFramePrompt` on anchor shots.** See "Anchors
     earn their name" below.
   - **Model tier per shot.** Anchors go on a dearer model; supporting shots
     go cheap. One model for every shot is a plan that has not been tiered.
5. **Check realism.** Run [[verify-realism]] against continuity.json and
   storyboard.json BEFORE any prompt is final. The four rules are not
   optional: identity needs an image, one shot is one moment, match the
   genre, handmade looks handmade.
6. **Check coherence.** Run [[verify-plan-coherence]]. Artifacts must agree
   with each other and the continuity graph must be executable.
7. **Price it completely.** See "The estimate must be complete" below.
8. **Generate the cheap plates.** Reference sheets, and a character pack if
   a person recurs. A few credits, not forty.
9. **Verify the plates.** `npm run refcheck` — and LOOK at them yourself
   with Read. A file that downloaded is not a file that is correct.
10. **Generate a start and end frame for EVERY shot** — the `target-frames`
    stage. See "Frame every shot, not just the anchors" below.
    `npm run refcheck` then assembles the `contact-sheet` automatically from
    the plates and frames, and names it at the gate.
11. **Write `plan.json` and validate it.** `npm run plan:contract`. This is
    the contract `/run-video` reads - see "plan.json is the contract" below.
12. **Run the readiness check.** `npm run readiness -- <project>`. This is the
    one that asks the whole question - see below. It must print READY.
13. **Raise the look gate** and stop.

## The readiness check is the definition of done

```bash
npm run readiness -- <project>
```

Every other check answers one part well: schemas validate shape, the motion
lint checks the edit, `refcheck` checks images. **None of them asks whether the
parts add up**, and that is exactly where the holes are. A plan can pass all of
them and still be unrunnable.

Two real ones, both found only when this check was written, and both green
everywhere else:

- Ten title cards had text and timing but **no source image**.
  `compileComposition` resolves a still to `shots/<id>/start.png` and THROWS
  when it is missing, so the render would have died on all ten.
- Those cards **reused the video shot's id**, so each card and its clip
  resolved to the same directory and the card would have shown the footage.

Nine layers, nineteen checks. Every blocker names its fix. It is free.

### ARTIFACTS

1. **All 10 planning artifacts present and valid.** A missing or malformed
   file, caught before anything reads it.

### SHOTS

2. **Every video item in the edit has a generation entry.** A clip in the
   timeline that nobody planned to generate renders as a gap.
3. **Every shot names a model.** No model means no price and no way to make it.

### FRAMES

4. **Frame prompts written for every generated shot.** A shot with no frame is
   a dice roll nobody reviewed and cannot correct before the run. Composed
   stills need none and are not counted.
5. **Every planned frame exists on disk.** The prompt existing is not the same
   as the image existing - `usesStartFrame` with no file hands the generator a
   path to nothing.

### STILLS

6. **Stills have their own ids.** A card sharing a clip's id resolves to the
   same `shots/<id>/` directory and shows the footage instead of the text.
7. **Every still has an image to render.** `compileComposition` resolves a
   still to `shots/<id>/start.png` and THROWS when it is missing - the render
   dies rather than leaving a gap.

### EDIT — the HyperFrames layer

`compileComposition` only *warns* about a transition it cannot render, and it
warns at render time, after every clip is paid for. These move that to
planning, where it is still free.

8. **Every transition is one the compiler can render.** Only `cut`,
   `crossfade`, `dissolve`, `fade` exist; anything else silently becomes a
   hard cut, so the plan says one thing and the video does another.
9. **Timeline is continuous - no gaps, no overlaps.** A gap renders as black;
   an overlap double-books a second.
10. **Declared runtime matches the timeline.** Cost and music length are both
    sized off that number.
11. **Sped-up clips have enough source footage.** `speedFactor: 2` over 5s of
    screen time consumes **10s** of source. Playing faster needs MORE footage,
    and running out renders frozen. Reports only when the plan changes speed.
12. **Every caption sits on a card.** A caption over footage is a subtitle,
    not a title card - warns, since it may be intended.

### AUDIO

13. **Music is generated at run time or already on disk.** Blocks only when
    the edit names a file that neither exists nor is planned as generated.
14. **Every SFX cue lands on a real timeline item.** A cue pointing at a shot
    that was cut.
15. **Narration has a script**, when narration is planned at all.

### REFERENCES

16. **Character pack exists when shots reference it.** Shots asking for a face
    with no face to hold.
17. **Environment and style sheets exist.** Without them each shot
    re-describes the world in text and the model reinvents it - warns.

### COST

18. **Cost gate approved.** The price was agreed.

### CONTRACT

19. **plan.json exists and is valid.** The one file `/run-video` reads.

**READY with zero blockers is the definition of a finished plan.** Do not raise
the look gate on a plan that does not print it. "The schemas all validate" is
not the same claim and never was.

Two things it deliberately accepts, because they are correct:

- **Music not yet generated.** `audio-finalize` runs after the gate. It only
  blocks when the edit names a music file that neither exists nor is planned
  as generated.
- **`shots/` and `output/` empty.** That is `/run-video`'s work. Planning ends
  at the gate.

## Runtime is not all generated

**The most expensive mistake in planning is assuming runtime equals paid
seconds.** It does not. The motion-ratio lint floors real motion at 55% of
runtime, which means up to **45% can be titles, cards, stills, Ken Burns and
graphics** — the HyperFrames layer, which costs nothing to generate.

Planned as 100% generated footage, a 3-minute video is 32 shots and ~400
credits. With 30 seconds carried by an opening title, a few cards and a end
card, it is 26 shots and ~325 credits. Same film, 75 credits cheaper, and
the titles do work that a generated clip cannot: naming the subject, marking
a passage of time, giving the eye somewhere to rest.

So decide the split explicitly, and write it into `plan.json`:

```json
"runtime": { "totalSeconds": 180, "generatedSeconds": 150, "composedSeconds": 30 }
```

Rules:

- **100% generated is a decision, not a default.** It can be right — an
  unbroken observational piece may want no titles at all. Say so if you
  choose it, rather than arriving there by never asking.
- **A Ken Burns move on a still is NOT motion.** The lint exists to catch
  exactly that substitution, so it cannot be used to pad the motion figure.
- **Never fall below 55% real motion.** Cheaper is not better if the result
  is a slideshow.

## Frame every shot, not just the anchors

**Generate a start and end frame for every shot in the plan.** Measured on
last-repair-shop: 27 shots, 54 frames at 1cr each = **54 credits, \$3.38**
against \$29.22 of video. Twelve percent, and a single 5s Mini clip costs
12.5cr — so preventing **one** bad clip pays for twelve frames.

§9's "2-4 anchors" is about which shots get a **dearer video model**. It is
not a budget for frames. Those are different decisions and conflating them
leaves most of the film unplanned.

The reason this matters is not the arithmetic. It is that a plan the user can
**correct** is worth more than a plan they can only accept or reject:

```text
"change the start frame of shot_018, he should already be holding the cloth"
```

That sentence is only possible if shot_018 has a start frame. Without one the
only available feedback is "approve" or "start again", and every un-framed
shot is a dice roll the human never got to see. Framing every shot converts
the look gate from a yes/no into a review.

So: frames for all of them, then **look at every pair**. The end frame must
differ from the start by seconds of action — never by framing, posture, or a
stage of progress. Regenerate the ones that are wrong; that is the whole
point of having them.

## Anchors earn their name

Two separate things share the word, and both were skipped on the first run of
this skill.

**Anchor shots** (§9): roughly **2-4 per video**, not nine. The opening
reveal, the central transformation, the closing image. They carry the weight,
so they get a **dearer model** — `seedance_2_0` at 45cr rather than
`seedance_2_0_mini` at 12.5cr. Supporting shots go cheap. A generation plan
where every shot uses one model has not been tiered, whatever its shotlist
claims about importance.

**Anchor frames**: the start and end images a shot opens and closes on. A
video model given both fills in the middle, so **a wrong frame guarantees a
wrong clip at roughly 100× the frame's cost.** Both failures on the first
paid project were visible in the frame and cost a full clip each to find.

These go on **every** shot, not only the anchors — see "Frame every shot"
above. Write `startFramePrompt` and `endFramePrompt` into `storyboard.json`,
set `usesStartFrame` / `usesEndFrame` in `generation-plan.json`, generate at
step 10, and **look at every pair**. The end frame must differ from the start
by seconds of action, never by a stage of progress — that is
[[verify-realism]] rule 2 applied to a single shot.

**Generate the end frame FROM the start frame**, passing it as an
`image_references` input and listing only what changes. Generating both from
text independently produced a start frame of a seated man in a medium shot
and an "end frame" that was a wide shot of him standing across the room — two
different shots, not one moment.

## The estimate must be complete

`estimateGenerationPlan` walks `generation-plan.json` items only — video
shots. It does not count reference images, character packs, music
generation, or upscales.

Observed on rain-riverbed 2026-08-21: estimated \$2.34, actually cost \$2.47,
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
| `runtime` | totalSeconds, generatedSeconds, composedSeconds — must add up |
| `shots[]` | id, prompt, negativePrompt, model, seconds, importance, references, startFrame, endFrame, aspect |
| `references[]` | every plate to generate, with its category, prompt and model |
| `characterPack` | pack images and the master, or `null` when no person recurs |
| `music` | the music plan, and whether a file must be generated |
| `edit` | transitions, captions, titleCards, music gain and fades |
| `cost` | per-line breakdown, the range, and the retry allowance |
| `retryPolicy` | maxAttemptsPerShot (max 2), allowanceCredits |
| `gates` | which are approved, and on what evidence |

Validate it — the schema is enforced, not advisory:

```bash
npm run plan:contract -- <project>
```

That checks the shape **and** cross-checks every claim against the artifact
that owns the fact: shot count and models against `generation-plan.json`,
the runtime split against `edit-plan.json`. A contract that disagrees with
the artifacts is worse than none, because the run follows the contract while
the human reviewed the artifacts.

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
