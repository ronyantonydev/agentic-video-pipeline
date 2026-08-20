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

Before writing any prompt, load [[verify-realism]] and follow all four rules.
They come from a paid run the user rejected:

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

## 7. Generate

Character reference first, always:

- one image of the person, with **fixable** wardrobe details
  ("torn left cuff", not "weathered jacket")
- feed it into every shot showing them

**Prove the look on ONE shot before generating the set.** All three clips in
the rejected run shared the same defect because none was checked first.

## 8. Finish

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
