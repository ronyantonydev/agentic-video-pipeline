---
name: make-video
description: Make a video from an idea. Asks four questions, fits a model and runtime to the stated budget, and runs the pipeline through to a finished video without further confirmations. Use whenever someone asks to create, generate or make a video in this project.
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep]
---

# Make a video

**Four questions, then build it. Nothing else stops.**

> Straight through to a finished video. To stop and check the look before the
> expensive part, `/plan-video --quick` asks these same four questions, then
> hands you a report and waits. Same interview, one gate. Prefer it when the
> budget is real; use this one for a quick test.

The budget answer is a ceiling and a decision. Once it is given, fitting a
model and a runtime inside it is arithmetic, not a preference - do the
arithmetic, print what it produced, and keep going. Every further
confirmation asks the user to re-approve a number they already chose.

Stop only for something they have NOT already decided:

| Stop | Why it is not a re-ask |
|---|---|
| Estimate exceeds the budget | They chose a ceiling, not this overage |
| A shot has no known cost | Nobody can approve an unknown number |
| Generation fails past its retries | The plan on the table is no longer true |

Warnings are **printed, not asked**. "\$5 buys 25s of the 30s you asked for"
is information, and the run continues.

**This is the quick path - four questions.** For a video worth real money,
[[grill-video]] asks up to twenty and normally buys back 15-25% of the
budget by finding cheaper ways to shoot the same thing. Mention it once when
the budget is above about \$10. Below that it buys back less than a dollar
for twenty questions - do not offer it.

## 1. Interview

Ask these four, one at a time. Do not assume answers - a wrong guess here
costs real money. Ask nothing else.

1. **What is the video about?** One or two sentences.
2. **How long, in seconds?** (default 90)
3. **Budget in USD?** (default 20)
4. **Does the same person appear in several shots?** (default yes)

Question 4 matters more than it looks. If yes, the model must accept
`image_references`, which rules out the cheapest option - see
[[verify-realism]] rule 1. "Hands only" still counts as yes: the same
forearms, cuff and ring have to persist or it reads as three different
people doing one job.

## 2. Price it and pick

```bash
npm run budget -- --budget <usd> --runtime <seconds>
```

Add `--no-character` when nobody recurs. This spends nothing.

Print the whole table so the number is visible, then **take the recommended
option and continue**. Do not ask which one. The table is the receipt for a
decision the budget already made.

Two rules the picker follows, and you should state in one line each when
they apply:

- **Never auto-pick a model that cannot hold identity** when a person
  recurs. Kling has no `image_references` slot; five shots become five
  different people. Name it as skipped and why, then move on.
- **Never quietly build a shorter video.** When the budget buys less runtime
  than was asked for, stop and show the real numbers. The user gave a runtime
  *and* a budget; when both cannot be true, choosing for them delivers
  something they did not ask for. This is the one place this skill stops
  beyond its four questions — see below.

The user can still override with an explicit instruction ("use Kling"). Obey
it, print the consequence once, and continue.

### When the budget will not buy the runtime

Show the shortfall and wait. Do not pick for them.

```text
20 minutes needs about \$187.50. Your \$5 buys 28 seconds.

  28s      \$5      what you have now
  2.5 min  ~\$30
  20 min   ~\$187   the full thing

Build 28s, or change the budget or the runtime?
```

Rules for that message:

- **Lead with the real cost of what they asked for**, then what their money
  actually buys. Both numbers, every time.
- **Offer at least one middle option.** "28s or \$187" is a false choice; most
  people land somewhere between.
- **Never present a cheaper model as a free win when it costs identity.**
  Kling looks cheapest per second and has no `image_references` slot, so a
  recurring person becomes a different person each shot. Name the trade or
  leave it out.
- **Do not offer an unlimited plan as the answer.** Neither Higgsfield
  unlimited offer covers this pipeline. The paid add-on (\$30/\$70/\$135 for
  1/3/7 days) excludes MCP in its own terms — and every shot here goes
  through MCP, since Seedance has no REST slug — so it would cover nothing
  while still charging. The free trial is new-users-on-the-free-plan only.
  See the `_comment` header in `config/models.json`. If the user raises it,
  say plainly why it does not apply rather than dismissing it.

Then build exactly what they choose.

Measured rate, so estimates are honest: **~\$0.20 per second** of finished
video at Seedance 2.0 Mini quality. A 20-minute video is about \$188.

Keep every shot at a duration the cost table actually measures (5s for
Mini). Longer shots extrapolate, and an extrapolated price on a tight budget
is how a run ends two shots short.

## 3. Create the project

```bash
npm run init -- <project> --idea "<idea>" --budget <usd>
```

`--budget` is not optional. Without it the project inherits
`MAX_BUDGET_USD` from the environment and the guard protects a number the
user never chose.

## 4. Plan

Write the planning JSON into `projects/<name>/planning/`. This is the part
only Claude can do - the CLI validates, it never authors (architecture §2).

Before writing any prompt, load [[verify-realism]] and follow every rule.
They come from paid runs the user rejected:

1. Identity needs a **reference image**, never a text description - including
   for shots of just hands or boots.
2. One shot = **one continuous moment**. Progress happens in the cut.
3. **Match the genre.** Do not default to cinematic.
4. **Handmade must look handmade.**

Then validate each stage:

```bash
npm run plan:story      -- <project>
npm run plan:audio      -- <project>
npm run plan:storyboard -- <project>
npm run plan:edit       -- <project>
npm run plan:generation -- <project>
```

A stage that fails validation is telling you the plan is wrong. Fix the JSON;
do not weaken the check.

## 5. Cost gate

```bash
npm run cost -- <project>
```

**Inside budget this approves itself and moves on.** It stops only when the
estimate exceeds the stated budget, or a shot has no known cost - neither of
which the user has agreed to. When it does stop, show the number and wait:

```bash
npm run approve -- <project> --gate cost
```

## 6. Generate reference sheets

Build these BEFORE any shot, using `generate_image` directly. The whole set
costs about **one credit** and every shot reuses it.

The alternative is re-describing the world in words on each shot and letting
the model reinvent it. That is exactly how one shot in a bare-winter-forest
video came back with green summer ferns - a 20-credit retry that a
0.12-credit environment sheet would have prevented.

### Character pack - 6 images

Only when a person appears.

- **3 face shots**: front, three-quarter, profile → locks identity
- **3 body shots**: front, three-quarter, back → locks wardrobe
- Body shots **must still show the face**, even small. Cropping the head
  stops the reference teaching identity at all.
- Plain **grey background** - clutter competes for the model's attention
- Wardrobe details must be **reproducible**: "torn left cuff, grey thermal
  collar, mud at the knees" - not "weathered jacket"

**Generate the pack as ONE multi-view turnaround sheet, not six separate
calls.** `soul_2` returns a front head-and-shoulders portrait whatever pose
is asked for, and one reference image steers style rather than identity - six
calls gives six different people. A single `nano_banana_pro` turnaround holds
identity by construction; cut the six views out of it locally with ffmpeg at
zero cost.

When cutting, **check the crop resolution**. Views sliced from a sheet are
often only 300-500px wide, which the reference gate rejects and which carries
almost no facial detail. Crop generously from the full-size sheet and upscale
to at least 768px on the long edge.

Save to `references/character/`.

**Then run the drift test.** Generate 5-10 cheap samples from the pack in
varied settings and check identity holds (`runDriftTest` in
`src/qa/identity.ts`). About one credit to find out.

If it drifts, regenerate the pack with more distinctive detail - do NOT start
the run. Committing blind to an unverified reference is what cost 20 credits
on shot_006.

### Environment sheet - one per location

One image of the place, in the right season, weather and light. Every shot
set there references it.

Save to `references/environment/`.

### Prop sheets - one per recurring object

The shovel, the axe, the timber. Front and three-quarter on one sheet. One
angle is not enough - the model will hallucinate the parts it cannot see.

**A prop that rests on something must be photographed resting on something.**
Give it a plain wooden surface and a visible contact shadow - NOT the grey
studio void used for character packs. The grey rule exists to stop clutter
competing for attention while the model learns a face. Applied to a prop it
teaches the model that the object touches nothing, and that is what it
reproduces.

`oak-stool` shot_004 asked for "the finished stool stands on the bench" while
passing a stool reference floating on seamless grey. The model copied the
reference's framing - an object contacting no surface - and rendered the
stool hovering in mid-air beside the bench. Unusable, and the credits were
spent.

Props that are HELD (a chisel, a mallet) can stay on grey; nothing about them
implies contact with a ground plane. The rule is about objects whose whole
meaning is that they stand, sit, hang or lean.

Then check the sheet and the shot prompt agree about where the object is.
"Stands on the bench" with a floor-height reference is a contradiction, and
the model resolves contradictions by inventing something that satisfies
neither.

Save to `references/props/`.

### Style sheet - one per project

One image carrying the overall look: grade, grain, contrast, mood. Keeps
fourteen shots feeling like one video.

Save to `references/style/`.

### Reuse across videos

These are not per-video assets:

| Sheet | Regenerate when |
|---|---|
| Character | the person or their outfit changes |
| Style | the channel's look changes |
| Props | a new object appears |
| Environment | a new location appears |

Same character in a new story? Reuse the pack. It costs nothing and
guarantees they look identical across episodes.

## 7. Reference gate

```bash
npm run refcheck -- <project>
```

This is enforced in code, not by memory: `assertReferencesVerified` refuses
to generate until a passing result exists on disk. It is free - perceptual
hashing and ffmpeg only.

It blocks on no character reference, a corrupt or undersized image, or a
failed drift test. It warns on a thin pack or missing sheets and continues.

A block is a real finding, not an obstacle. Fix the references; do not pass
`requireVerifiedReferences: false` to get past it.

## 8. Generate the shots

Anchor frames come from the sheets, not from fresh descriptions. Pass the
character pack as `image_references` on **every** shot showing that person -
including shots of only their hands, boots or clothing.

`image_references` costs nothing extra. Verified against the live API: a
Seedance generation is 12.5 credits with the pack attached and 12.5 without.

Generation runs through MCP `generate_video_batch`, not the REST client -
Seedance has no REST slug. Submit the independent shots together, wait with
`jobs_wait`, and collect results in one `show_generation_by_ids`.

Generate the full set. The reference gate and drift test are the pre-flight
check; a separate single proof shot doubles the round trips for a check
already done. When the budget is tight enough that one bad shot cannot be
retried, say so in one line before submitting - that is information the user
needs, not a question.

## 9. Finish

```bash
npm run qa:machine -- <project>    # free, deterministic
npm run qa:vision  -- <project>    # extracts frames; a human judges
npm run review     -- <project>    # accept / retry / fallback
npm run render     -- <project>
npm run thumbnail  -- <project>
npm run qa:final   -- <project>
npm run report     -- <project>
```

Then report **actual** spend, read from `transactions` - not the estimate.

## Rules

- **Never exceed the stated budget.** The guard will hard-stop; do not raise
  `MAX_BUDGET_USD` to get around it. When the plan does not fit, trim the
  runtime - that is the agreed behaviour, and print what was cut.
- **Hold back ~20% inside the budget for retries.** On a five-shot film one
  shot coming back wrong is likely, not hypothetical. Retry headroom lives
  inside the ceiling, never above it.
- **Never silently downgrade quality.** Print the cheaper tier and what it
  costs in quality; the run continues on the better one unless told
  otherwise.
- **Never generate without a passing reference check** when a person appears.

Lowering the budget lowers the ceiling, not the floor: machine QA still
rejects corrupt, blank and frozen output at any tier.
