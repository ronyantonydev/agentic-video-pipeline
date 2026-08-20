---
name: make-video
description: Make a video from an idea. Interviews the user for idea, runtime and budget, prices the options, recommends one, and runs the pipeline after they choose. Use whenever someone asks to create, generate or make a video in this project.
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep]
---

# Make a video

Interview, price, recommend, confirm, then build. Never generate before the
user has picked an option and seen the number.

**This is the quick path - four questions.** For a video worth real money,
[[grill-video]] asks up to twenty and normally buys back 15-25% of the
budget by finding cheaper ways to shoot the same thing. Offer it when the
budget is above about $10, or when a person appears in several shots.

## 1. Interview

Ask these four, one at a time. Do not assume answers - a wrong guess here
costs real money.

1. **What is the video about?** One or two sentences.
2. **How long, in seconds?** (default 90)
3. **Budget in USD?** (default 20)
4. **Does the same person appear in several shots?** (default yes)

Question 4 matters more than it looks. If yes, the model must accept
`image_references`, which rules out the cheapest option - see
[[verify-realism]] rule 1.

## 2. Price it

```bash
npm run budget -- --budget <usd> --runtime <seconds>
```

Add `--no-character` when nobody recurs.

This spends nothing. Show the user the whole table, not just the winner -
they are choosing, not being told.

## 3. Recommend

State plainly:

- **which** option you recommend
- **why** - usually "holds the character and fits the runtime"
- **what they give up** on the cheaper option
- **the real number**: seconds of video, credits, dollars

When the budget will not cover the requested runtime, say so in money terms:
"90 seconds needs about $14; at $8 you get 50 seconds." Offer both a shorter
video and a larger budget. Do not quietly shorten it.

Measured rate, so estimates are honest: **~$0.20 per second** of finished
video at Seedance 2.0 Mini quality. A 20-minute video is about $188.

## 4. Confirm

Wait for an explicit choice. Then:

```bash
npm run start -- --idea "<idea>" --runtime <seconds> --budget <usd>
```

## 5. Plan

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

## 6. Cost gate

```bash
npm run cost -- <project>
```

This stops and asks for approval. That is the design (§21) - it writes state
and exits rather than blocking. Show the user the estimate and wait.

```bash
npm run approve -- <project> --gate cost
```

## 7. Generate reference sheets

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

The shovel, the axe, the timber. Front and three-quarter on one sheet, on
grey. One angle is not enough - the model will hallucinate the parts it
cannot see.

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

## 8. Generate the shots

Anchor frames come from the sheets, not from fresh descriptions. Pass the
character pack as `image_references` on **every** shot showing that person -
including shots of only their hands, boots or clothing.

`image_references` costs nothing extra. Verified against the live API: a
Seedance generation is 12.5 credits with the pack attached and 12.5 without.

**Prove the look on ONE shot before generating the set.** All three clips in
the rejected run shared the same defect because none was checked first.

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

## Rules

- **Never generate before the user picks an option.**
- **Never exceed the stated budget.** The guard will hard-stop; do not raise
  `MAX_BUDGET_USD` to get around it.
- **Never silently downgrade quality.** Offer the cheaper tier, say what it
  costs in quality, let the user decide.
- **Report actual spend**, not the estimate. Read it from `transactions`.

Lowering the budget lowers the ceiling, not the floor: machine QA still
rejects corrupt, blank and frozen output at any tier.
