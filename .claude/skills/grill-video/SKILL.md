---
name: grill-video
description: Deep interview before making a video. Asks up to 26 adaptive questions across genre, character, story, look, budget, efficiency and reference reuse, showing a running cost estimate as answers come in, and pushes back when the budget and the ambition do not match. Use for a real video worth spending on; use make-video instead for a quick test.
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep]
---

# Grill the brief

Every question here exists because a wrong answer costs credits. Ask them
before generating, not after.

Use this for a video worth spending on. For a quick test, [[make-video]]
asks four questions and gets on with it.

> This runs straight through to a finished video. `/plan-video --grill` asks
> these same rounds, then stops at a report so you can check the references
> before the expensive part — usually the better shape for a video worth this
> many questions.

## How to run the interview

**Ask one question at a time.** A wall of twenty-six questions gets skimmed,
and skimmed answers are what produce a rejected video.

**Adapt.** Skip whole rounds that do not apply - no person on screen means
round 2 is one question, not five.

**Show the cost moving.** After rounds 2, 5 and 6, run:

```bash
npm run budget -- --budget <usd> --runtime <seconds>
```

so the user sees what their answers cost as they give them, not at the end.

**Push back.** If the answers do not add up, say so plainly and offer the
choice. Do not quietly resolve it yourself.

---

## Round 1 — Genre and reference

The single biggest quality lever. The first paid run was rejected because
this round was skipped and "cinematic" was assumed.

1. **Is there a channel, film or video this should feel like?** A name is
   worth more than any adjective. If they give one, look at what that genre
   actually does - handheld or locked off, music or ambient, polished or
   rough - and mirror it.

2. **Documentary, cinematic, ASMR, or tutorial?** These want opposite
   treatments. Documentary and ASMR are close and unglamorous; cinematic is
   wide and composed.

3. **Handheld or locked off?** Handheld reads as real. Locked off reads as
   produced.

4. **Music bed, or real ambient sound?** Bushcraft, cooking and craft
   content live on tool sounds. A music bed over them reads as an advert.

Record the answers into `continuity.json` as `styleKeywords` and, just as
importantly, into `negativePrompt` as their opposites.

---

## Round 2 — Character

The biggest cost lever. A recurring person forces a model that accepts
`image_references`, which is not the cheapest tier.

5. **Does a person appear on screen?**
   If no: skip to round 3, and note that the cheaper tier is available.

6. **In how many shots?**
   One shot means identity barely matters. Several means a character
   reference pack is mandatory - see [[verify-realism]] rule 1.

7. **Describe them.** Push for **reproducible** detail. "Weathered man" is
   unusable; "mid-30s, short dark hair, three-day stubble, plain face" can be
   drawn twice.

8. **What are they wearing, exactly?** Ask for one detail that must never
   change - a torn cuff, a specific collar, mud at the knees. That single
   fixable detail is how a viewer knows it is the same person.

9. **Do they speak?** Speech needs lip-sync and pushes toward a dearer
   model. Most build and craft content has none.

**Then price it**, because this round moves the number more than any other:

```bash
npm run budget -- --budget <usd> --runtime <seconds>
```

Show the table. If they said a person recurs, point out that the cheapest row
is now unavailable and why.

---

## Round 3 — Story and progression

10. **What is visibly different between the first and last shot?** If
    nothing, there is no story yet - stop and work on that before spending.

11. **How many distinct stages?** This sets the shot count. Six stages at
    two shots each is twelve shots; that is a real number with a real price.

12. **What are the first three seconds?** The hook. It must be motion, not a
    title card.

13. **What is the payoff?** The last shot. Also motion.

---

## Round 4 — Look and constraints

14. **Time of day, and weather?** Constant across shots unless the story
    needs otherwise. Drifting light is a continuity break.

15. **Season?** Easy to forget and immediately obvious when wrong - a summer
    fern in a winter forest got a shot rejected on the real project.

16. **What must never appear?** Modern machinery, text overlays, other
    people, brand logos. Goes straight into `negativePrompt`, where it does
    real work.

---

## Round 5 — Budget reality

17. **Target runtime, in seconds?**

18. **Budget, in USD?**

**Price it, then confront any gap honestly:**

```bash
npm run budget -- --budget <usd> --runtime <seconds>
```

Measured rate: **~\$0.20 per second** of finished video at Seedance 2.0 Mini
quality. Twenty minutes is about \$188. That is a per-second wall; no prompt
technique moves it.

19. **If the two do not fit: shorter video, or bigger budget?**
    Put it in money terms - "90 seconds needs about \$14; at \$8 you get 50
    seconds." Never shorten it silently.

20. **Is this a test, or the real thing?**
    A test should be three shots and a few dollars. Say so.

---

## Round 6 — Efficiency

This round exists purely to buy more video for the same money.

21. **Which shots have no person in them?** Landscapes, tools, the finished
    build. Those can use the cheaper tier - no identity to hold - which frees
    budget for the shots that need quality.

22. **Could any shot work as a still with a slow push?** A held still costs
    almost nothing against roughly 15 credits for a generated clip.
    **But:** motion-ratio lint refuses to count a panning photograph as
    motion, and will fail the plan if stills take over. Two or three at most,
    never consecutive, never the opening or closing shot.

23. **Is it all one location?** One environment reference, reused across
    every shot, instead of one per shot.

24. **Any shot that could be shorter?** Billing is per second. Trimming a
    10-second establishing shot to 6 saves 10 credits and usually improves
    the edit.

25. **Which locations, props and characters repeat?**
    Each becomes a single reference sheet, generated once and reused by every
    shot that needs it - roughly one credit for the whole set.

    This is not only a quality measure. Without a sheet, each shot
    re-describes its subject in words and the model reinvents it, which is
    how one shot in a winter-forest video came back with summer ferns and
    cost 20 credits to redo.

26. **Have you made a video with this character or in this style before?**
    If so, reuse those sheets rather than regenerating. Identical character
    across episodes, at no cost. Character and style sheets are not
    per-video assets.

**Re-price after this round.** It normally buys back 15-25% of the budget.

---

## Then summarise, and wait

Before creating anything, state back:

```text
Genre        bushcraft documentary, handheld, ambient sound
Character    one man, 9 of 14 shots, olive jacket with torn left cuff
Story        empty ground -> finished shelter, 6 stages, 14 shots
Look         bare winter forest, flat overcast, no green foliage
Runtime      90s
Model        Seedance 2.0 Mini (holds identity)
Sheets       character pack (6) + 1 environment + 2 props + 1 style ≈ 1 credit
Cost         about \$14.11 of a \$20 budget
Efficiency   5 shots need no character reference; 1 still; single location
```

Ask for explicit confirmation. Then:

```bash
npm run start -- --idea "<idea>" --runtime <seconds> --budget <usd>
```

and continue with [[make-video]] from its planning step, including its
reference-sheet stage.

---

## Rules

- **One question at a time.**
- **Never generate before the summary is confirmed.**
- **Never exceed the stated budget**, and never raise `MAX_BUDGET_USD` to get
  around a hard stop.
- **Push back on a mismatch** rather than resolving it silently.
- **Reproducible details, not adjectives.** If an answer cannot be drawn
  twice, ask again.

A thorough interview is cheap. A rejected 14-shot video is not.
