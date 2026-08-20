# Additions for `.claude/skills/verify-realism/SKILL.md`

Paste these sections into the existing skill. They come from the older
brainstorming notes in `docs/brainstorming/character-video-pipeline.md` and
the two tutorial transcripts, and each one addresses a failure the project
actually hit.

I cannot write into `.claude/` directly - the harness blocks agent writes
there - so these are staged here for you to merge by hand.

---

## Replace rule 1's "Generate ONE character reference image" with this

**Rule:**
- Generate a **six-image reference pack**, not one image:
  - **3 face shots** - front, three-quarter, profile. These lock *identity*.
  - **3 body shots** - front, three-quarter, back. These lock *outfit and
    proportions*.
  - Body shots **must still show the face**, even small. Never crop or mask
    the head, or the reference stops teaching the model who this is.
- Feed the pack into EVERY shot containing that character, via a model that
  accepts `image_references` (seedance_2_0, seedance_2_0_mini, wan2_7).

**Why six and not one:** a single front-facing reference held identity in
wide shots and lost it in close-ups and unusual angles. Three face angles
give the model something to interpolate between; three body shots stop the
outfit drifting. Six Soul 2 images cost about 0.6 credits against 0.12 for
one - the difference is noise against a 250-credit run.

**Generate them on a plain grey background.** Background clutter competes for
the model's attention; grey gives it nothing to fixate on but the subject.

---

## Add as rule 5

## 5. Prove the reference holds before committing to the run

**What went wrong:** fourteen shots were generated against a reference that
had never been tested. One came back with a different person's hands and a
different environment. Cost: 20 credits to discover, 20 more to fix.

**Rule:** before generating any shot, run the **drift test**:

1. Generate 5-10 cheap sample images from the reference pack, in varied
   settings ("the character in a forest", "the character indoors").
2. Compare each against the master with `runDriftTest` in
   `src/qa/identity.ts`.
3. Identity holds across all samples → commit to the full run.
4. Identity drifts → regenerate the reference with more distinctive,
   reproducible detail. Do not start the run.

The test costs about one credit. The mistake it catches costs the price of
every shot generated against a reference that was never going to work.

Applies whenever the reference changes - a new character, a new outfit, a
new model.

---

## Add as rule 6

## 6. A clip can drift within itself

**What went wrong:** nothing yet, but the check exists because a generation
can start on-model and end as someone else. Every check we had looked at the
start frame, so no check would ever have seen it.

**Rule:** machine QA compares the **last frame to the first** on any shot
containing the character (`checkIdentityDrift: true`). A low score warns for
human review; it never triggers a paid retry on its own - this tier does not
spend (section 15).

**Keep clips short.** Four to six seconds drifts less than ten. A long video
is many short clips, not a few long ones. Our real clips run 4-8s, which is
about right; do not stretch a shot to fill time.

---

## Add to rule 3 (Match the genre)

Two framing details from the tutorials, both cheap and both worth doing:

- **Locations at a three-quarter angle.** A head-on wall gives the model no
  depth cue; three-quarter gives it geometry to work with.
- **Character and prop sheets on plain grey.** Same reasoning as the
  reference pack - remove everything that is not the subject.

---

## Add to rule 4 (Handmade must look handmade)

**When a model gets a specific detail wrong, correct the reference, not the
prompt.** If it presses the wrong button on a remote, add a red arrow to the
prop sheet pointing at the right one and re-upload. Arguing with the prompt
costs a generation each time; fixing the reference fixes it once.
