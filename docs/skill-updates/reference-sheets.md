# Reference sheets — updates for two skills

Claude generates these directly with the MCP tools. There is no CLI command
and none is needed: the user types an idea, Claude does the rest.

The gap this closes: `verify-realism` already *requires* a six-image
character pack and a drift test, but neither `make-video` nor `grill-video`
told Claude to produce the other sheets. So the environment got re-described
in words on every shot, and the model reinvented it each time. That is what
put summer ferns in shot_005 of a bare-winter-forest video, and cost 20
credits to fix.

Paste each block over the section it replaces. I cannot write into
`.claude/` — the harness blocks agent writes there — so these are staged for
you to merge.

---

## 1 · `make-video` — replace section 7 entirely

Currently lines 106–115. Replace with:

```markdown
## 7. Generate reference sheets

Build these BEFORE any shot. All of it costs about one credit, and every
shot reuses it — the alternative is re-describing the world in words on each
shot and letting the model reinvent it.

### Character pack — 6 images

Only when a person appears.

- **3 face shots**: front, three-quarter, profile → locks identity
- **3 body shots**: front, three-quarter, back → locks wardrobe
- Body shots **must still show the face**, even small
- Plain **grey background** — clutter competes for the model's attention
- Wardrobe details must be **reproducible**: "torn left cuff, grey thermal
  collar" — not "weathered jacket"

Save to `references/character/`.

**Then run the drift test.** Generate 5–10 cheap samples from the pack in
varied settings and check identity holds. About one credit to find out.
If it drifts, regenerate the pack with more distinctive detail — do NOT
start the run. Blind commitment to an unverified reference is what cost 20
credits on shot_006.

### Environment sheet — one per location

One image of the place, in the right season, weather and light. Every shot
set there references it.

Without this each shot re-describes the location in text and the model
invents a new one. That is exactly how a winter forest became a summer one.

Save to `references/environment/`.

### Prop sheets — one per recurring object

The shovel, the axe, the timber. Front and three-quarter on one sheet, on
grey — one angle is not enough, and the model will hallucinate the parts it
cannot see.

Save to `references/props/`.

### Style sheet — one per project

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
character pack as `image_references` on every shot showing that person —
including shots of only their hands, boots or clothing.

`image_references` costs nothing extra. Verified against the live API:
12.5 credits with the pack attached, 12.5 without.

**Prove the look on ONE shot before generating the set.** All three clips in
the rejected run shared the same defect because none was checked first.
```

Then renumber the old `## 8. Finish` to `## 9. Finish`.

---

## 2 · `grill-video` — add to Round 6

After the existing question 24, add:

```markdown
25. **Which locations, props and characters repeat?**
    Each one becomes a single reference sheet, generated once and reused by
    every shot that needs it — roughly one credit for the whole set.

    This is not only a quality measure. Without a sheet, each shot
    re-describes the subject in words and the model reinvents it, which is
    how one shot in a winter-forest video came back with summer ferns and
    cost 20 credits to redo.

26. **Have you made a video with this character or in this style before?**
    If so, reuse those sheets instead of regenerating. Identical character
    across episodes, at no cost.
```

---

## 3 · `grill-video` — add to the summary block

In "Then summarise, and wait", add a line to the summary table:

```markdown
Sheets       character pack (6) + 1 environment + 2 props + 1 style ≈ 1 credit
```

---

## Why no CLI command

An earlier plan was `npm run gen:references`. It was the wrong shape: the
user types an idea and Claude does everything, so a command the user has to
remember defeats the point.

Claude generates these with `generate_image` directly, the same way it
already generates the character reference. The skill just has to say so.
