---
name: verify-realism
description: EMBEDDED CHECK - run before writing continuity.json, storyboard.json, or any generation prompt. Prevents the failure modes that made the first paid run look like imagination instead of real documentary footage. Applies to every project, not just the one that produced them.
allowed-tools: [Read, Grep, Glob]
---

# Verify realism

These rules come from real paid runs that the human rejected. Every rule
below is a mistake that was actually made, not a hypothetical. Check planning
artifacts against them BEFORE spending.

Report PASS/FAIL per check, quoting the offending prompt text.

## 1. Identity must be carried by an IMAGE, never by text

**What went wrong:** the character's face and jacket changed between shots.

**Cause:** the model was given a text description of the man
("weathered man in a faded green canvas work jacket"). Text cannot hold a
face. Kling 3.0 accepts only `start_image` / `end_image` - it has no
identity-reference input at all.

**Rule:**
- Generate a **six-image reference pack** before any video:
  - **3 face shots** - front, three-quarter, profile. These lock *identity*.
  - **3 body shots** - front, three-quarter, back. These lock *outfit and
    proportions*.
  - Body shots **must still show the face**, even small. Cropping or masking
    the head stops the reference teaching the model who this is.
  - Plain **grey background**. Clutter competes for the model's attention;
    grey gives it nothing to fixate on but the subject.

    This applies to CHARACTER packs. A prop that rests on a surface - a
    stool, a chair, a crate - must be shot ON that kind of surface with a
    visible contact shadow. On grey it has no ground plane, and the model
    reproduces an object touching nothing: oak-stool shot_004 rendered a
    stool hovering in mid-air beside the bench because its reference floated
    on a seamless backdrop. Held props (chisel, mallet) can stay on grey.
- Feed the pack into EVERY shot containing that character, via a model that
  accepts `image_references` (seedance_2_0, seedance_2_0_mini, wan2_7).
- A model with no identity-reference slot must not be used for shots
  containing a recurring person.
- FAIL if `continuity.json` describes a character but no reference image
  exists in `references/character/`.

**Why six and not one:** a single front-facing reference held identity in
wide shots and lost it in close-ups and unusual angles. Three face angles
give the model something to interpolate between; three body shots stop the
outfit drifting. Six Soul 2 images cost about 0.6 credits against 0.12 for
one - noise against a 250-credit run.

**"Contains the character" includes body parts.** This was missed on the
second run: a macro shot of "dirty bare hands gripping a shovel shaft" was
generated WITHOUT the reference, on the assumption that a hands-only shot
had no identity to hold. The result had different hands - darker skin - and
a different environment entirely (dry open farmland instead of damp forest).
It cost 20 credits and had to be regenerated.

A shot needs the character reference if it shows ANY of: hands, arms, boots,
legs, torso, or clothing. Only shots with no human presence at all - an
empty clearing, a tool standing alone, a finished structure - may omit it.

When in doubt, attach the reference. It costs nothing extra.

**Wardrobe details must be FIXABLE, not adjectives.** "Weathered jacket" is
unusable. "Olive-drab jacket with a torn left cuff, grey thermal collar
visible at the neck, mud line at the knees" gives the model something to
reproduce.

## 2. One shot = one continuous moment

**What went wrong:** the pit went from shallow to deep inside a single 8s
clip. It read as fake.

**Cause:** the prompt said "the pit walls rise around him... as time
passes". The model did exactly what was asked.

**Rule:**
- No prompt may contain: `time-lapse`, `as time passes`, `over the course
  of`, `progressively`, `gradually deepens`, `seasons change`, `days pass`.
- A shot describes ONE action: one shovelful, one log placed, one beam
  lowered.
- Progress is shown by CUTTING between shots. Shot 7 is a shallow pit,
  shot 8 is a deep pit, and the viewer infers the weeks between them.
- For anchor shots with start/end frames, the end frame differs from the
  start by SECONDS of action, never by a stage of construction.

## 3. Match the genre, not "cinematic" by default

**What went wrong:** shots were built like a film trailer - aerial drone
push, golden hour, sweeping moves. The human's reference was bushcraft
survival documentary.

**Rule:** establish the genre BEFORE writing any prompt, and check the
prompt vocabulary against it.

For handmade / DIY / bushcraft / survival / build content:
- Camera: handheld, low, close, small natural shake. NO drone, NO aerial,
  NO crane, NO slow motion.
- Light: flat overcast. NO golden hour, NO rim light, NO lens flare.
- Framing: hands and tools fill the frame. The appeal is watching someone
  actually do the work, not the landscape.
- Finish: muddy, rough, unpolished. NO colour grading, NO gloss.
- Audio: native tool sounds. NOT a music bed.
- Locations at a **three-quarter angle**. A head-on wall gives the model no
  depth cue; three-quarter gives it geometry to work with.

FAIL if the negative prompt does not exclude the wrong-genre vocabulary.

## 4. Handmade things must look handmade

**What went wrong:** the finished dwelling had a clean architectural window
with machined framing. It looked like a designer earth-home, not something
built by one person with hand tools.

**Rule:** anything the character built must show evidence of hand
construction:
- Rough-cut, irregular timber with visible tool marks - not milled lumber.
- Salvaged or uneven glass in a crooked frame - not architectural glazing.
- Asymmetry, gaps, mud, loose soil, scattered tools still lying around.
- FAIL on: `architectural`, `designer`, `polished`, `pristine`, `modern`,
  `sleek` describing anything the character made.

**Match on word boundaries.** A naive substring search flags "unpolished",
which is the word we WANT. Use `\b(polished|pristine|...)\b` and check the
positive prompts only - these terms belong in `negativePrompt`, where their
presence is correct rather than a violation.

**When a model gets a specific detail wrong, correct the reference, not the
prompt.** If it presses the wrong button on a remote, add a red arrow to the
prop sheet pointing at the right one and re-upload. Arguing with the prompt
costs a generation each time; fixing the reference fixes it once.

## 5. The negative prompt does real work

Every generation prompt carries a negative prompt that excludes the failure
modes above. Minimum for documentary/DIY content:

```text
cinematic color grading, golden hour, lens flare, drone shot, aerial view,
slow motion, time-lapse, modern machinery, power tools, architectural glass,
designer interior, polished, glossy, oversaturated, film trailer look,
text overlay, watermark, multiple people
```

## 6. Prove the reference holds before committing to the run

**What went wrong:** fourteen shots were generated against a character
reference that had never been verified. One came back with a different
person's hands and a different environment. Cost: 20 credits to discover,
20 more to fix.

**Rule:** before generating any shot, run the **drift test**:

1. Generate 5-10 cheap sample images from the reference pack, in varied
   settings ("the character in a forest", "the character indoors").
2. Compare each against the master with `runDriftTest` in
   `src/qa/identity.ts`.
3. Identity holds across all samples → commit to the full run.
4. Identity drifts → regenerate the reference with more distinctive,
   reproducible detail. Do NOT start the run.

The test costs about one credit. The mistake it catches costs the price of
every shot generated against a reference that was never going to work.

Applies whenever the reference changes - a new character, a new outfit, a
new model.

## 7. A clip can drift within itself

A generation can start on-model and end as someone else. Every check in the
pipeline looked at the start frame, so nothing would ever have seen it.

**Rule:** machine QA compares the **last frame to the first** on any shot
containing the character (`checkIdentityDrift: true` in `runMachineQa`).

A low score WARNS for human review; it never triggers a paid retry on its
own - this tier does not spend (architecture section 15). Perceptual hashing
cannot prove two faces are the same person, only that the frame changed a
lot, so the human decides.

**Keep clips short.** Four to six seconds drifts less than ten. A long video
is many short clips, not a few long ones. Do not stretch a shot to fill time.

## 8. Prove the look on ONE shot before generating the set

**What went wrong:** three shots were generated on an unvalidated style, and
all three had the same defects.

**Rule:** when the visual approach changes - new genre, new model, new
character reference - generate exactly ONE shot and have the human look at
it before committing to the rest. Cost of being wrong drops from N clips to
one.

## How to run

Before any paid generation, read `planning/continuity.json` and
`planning/storyboard.json` and check:

1. Does a six-image character reference pack exist, and does the chosen
   model accept `image_references`?
2. Has the drift test been run against that pack, and did it hold?
3. Does any prompt compress time inside a single shot?
4. Does the camera/light vocabulary match the stated genre?
5. Do built objects read as handmade?
6. Does every prompt carry a negative prompt excluding wrong-genre terms?
7. Is `checkIdentityDrift` enabled for shots containing the character?
8. Has one shot been approved before the batch?

Any FAIL blocks generation. These mistakes cost real credits the first time.
