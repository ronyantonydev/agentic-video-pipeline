> **Historical.** This is the original design, written before implementation.
> It is kept because the reasoning is still sound and the section numbers are
> referenced throughout the code.
>
> For how the system actually works, see **[architecture.md](architecture.md)**.
>
> Where the two differ, the built version is right and records why — usually
> because something failed and cost credits to discover. The main divergences:
> Higgsfield bills API and subscription from separate wallets; models expose
> durations as either discrete values or ranges, not just discrete; identity
> requires a six-image reference pack rather than one; and anchor images are
> validated before generation, which section 15 did not anticipate.

# Final V1 Video Automation Architecture

## 1. Product Goal

The user interacts **only with Claude CLI**.

Input:

```text
Create a 90-second cinematic video of a man building an underground house.
```

Everything else happens through the project automatically:

```text
Idea
→ Story
→ Music/tempo
→ Storyboard
→ Edit plan
→ Generation plan
→ Cost approval
→ References
→ Visual approval
→ Higgsfield generation
→ QA
→ HyperFrames edit
→ Final video
→ Thumbnail
→ Cost report
```

---

# 2. Core Architecture Principle

### Claude plans. Code spends.

Claude is responsible for:

- understanding the idea
- story creation
- hook creation
- progression
- storyboard
- prompts
- edit decisions
- generation planning
- model recommendations
- QA interpretation

Deterministic Node.js code is responsible for:

- validating JSON
- calculating cost
- checking budget
- submitting paid Higgsfield jobs
- saving job IDs
- polling
- downloading
- FFmpeg processing
- machine QA
- state/resume
- HyperFrames rendering

**Claude should never improvise paid API calls directly.**

---

# 3. Technology Stack

```text
Claude CLI
    ↓
Claude Video Skill
    ↓
Node.js / TypeScript
    ↓
Nano Banana / image generation
    ↓
Higgsfield MCP/API
    ↓
FFmpeg
    ↓
HyperFrames
    ↓
Final MP4
```

### Responsibilities

**Claude**
- director
- planner
- prompt writer
- decision maker

**Nano Banana**
- character references
- environment references
- props
- style references
- progression images
- storyboard images
- start/end target frames

**Higgsfield**
- Wan/Kling/etc.
- paid motion generation
- native audio when supported
- additional SFX/ambience where needed

**FFmpeg**
- normalization
- frame extraction
- trims
- audio extraction
- machine QA
- final technical verification

**HyperFrames**
- creative timeline
- transitions
- zooms
- Ken Burns
- speed effects
- still animation
- music
- SFX
- audio mixing
- titles/captions
- final composition

---

# 4. Final Pipeline

```text
USER IDEA
    ↓

STORY + HOOK
    ↓

MUSIC / MOOD / BPM
    ↓
Optional VO if story requires narration
    ↓

SIMPLE BEAT GRID
    ↓

PROGRESSION
    ↓

CONTINUITY PLAN
    ↓

STORYBOARD
    ↓

HYPERFRAMES EDIT PLAN
    ↓

MOTION-RATIO LINT #1
    ↓

GENERATION PLAN
    ↓

MODEL SELECTION
    ↓

BILLABLE DURATION ROUNDING
    ↓

COST ESTIMATION

════════════════════════
GATE 1 — COST APPROVAL
════════════════════════

    ↓

REFERENCE IMAGES
    ↓

START / END TARGET FRAMES
    ↓

CONTACT SHEET

════════════════════════
GATE 2 — LOOK APPROVAL
════════════════════════

    ↓

PAID VIDEO GENERATION
    ↓

NORMALIZATION
    ↓

QA
    ↓

HUMAN ACCEPT / RETRY / FALLBACK
    ↓

MOTION-RATIO LINT #2
    ↓

SFX / AUDIO FINALIZATION
    ↓

HYPERFRAMES COMPOSITION
    ↓

FINAL RENDER
    ↓

OPTIONAL UPSCALE
    ↓

THUMBNAIL
    ↓

FINAL QA — REPORT ONLY

    ↓

final.mp4
thumbnail.png
cost.md
manifest.json
qa-report.json
```

---

# 5. Audio Ordering

Music is chosen **before storyboard/edit planning**, because pacing should follow the music.

```text
Story
↓
Music mood
↓
BPM
↓
Beat grid
↓
Storyboard
↓
Edit plan
```

If narration is required:

```text
Story
↓
Generate VO
↓
Measure VO duration
↓
Music / beat grid
↓
Shots fit narration timing
```

SFX happens later because it depends partly on the selected video model.

```text
Model selected
↓
Does model provide useful native audio?

YES
→ preserve native audio

NO / poor quality
→ add SFX / ambience separately

↓
HyperFrames mixes everything
```

---

# 6. Storyboard vs Edit Plan vs Generation Plan

These are three separate artifacts.

### `storyboard.json`

Defines:

> What should the viewer see?

Example:

```text
Man begins digging the ground.
```

### `edit-plan.json`

Defines:

> How will the final timeline present it?

Example:

```text
Final screen time: 6 seconds
3 sec motion
2 sec slowed motion
1 sec transition
```

### `generation-plan.json`

Defines:

> What paid assets do we actually need?

Example:

```text
Need approximately 3 seconds of motion.
Model minimum billable duration = 5 seconds.
Generate 5 seconds.
Trim to required section.
```

---

# 7. Billable Duration Rule

Never assume arbitrary video durations.

Each model defines:

```json
{
  "allowedDurations": [5, 10]
}
```

If the edit needs:

```text
3.2 seconds
```

the generation system chooses:

```text
5-second billable generation
```

not 3.2 seconds.

Cost estimates therefore always use the **actual billable duration**.

---

# 8. Model Configuration

`config/models.json`

Each model stores:

```text
provider
modelId
costPerBillableUnit
allowedDurations
supportsStartFrame
supportsEndFrame
supportsStartEndFrames
supportsNativeAudio
maxResolution
fps
qualityTier
averageLatency
enabled
```

V1 model selection stays simple:

```text
normal/simple shot
→ cheaper model

anchor / difficult shot
→ quality model

cheap model fails due to capability
→ escalate
```

Avoid complicated adaptive model intelligence in v1.

---

# 9. Anchor Shots

Claude automatically identifies approximately 2–4 important shots.

Example:

```text
opening reveal
major transformation point
climax
final reveal
```

These receive higher quality treatment.

Supporting shots can use cheaper models.

Anchors are generated dynamically from the user's idea.

---

# 10. Progression System

Do not hard-code construction stages.

Use generic:

```text
progression.json
```

Examples:

### Underground house

```text
empty ground
→ shallow hole
→ deep pit
→ walls
→ roof
→ finished house
```

### Car restoration

```text
rusted car
→ stripped
→ repaired
→ painted
→ finished
```

### Cooking

```text
raw ingredients
→ prepared
→ cooking
→ plating
→ finished dish
```

Claude generates progression automatically from the idea.

---

# 11. Continuity

Create:

```text
planning/continuity.json
```

It can contain:

- character appearance
- wardrobe
- environment
- time of day
- lighting
- lens/camera style
- props
- object states
- progression state
- scene-specific constraints

Shot prompts are composed using continuity information rather than completely free-written prompts.

---

# 12. Three Continuity Modes

Every shot has:

```text
continuityMode
```

### `independent`

No dependency on previous shot.

```text
Can generate in parallel.
```

### `reference-only`

Same:

- person
- environment
- style
- lighting
- props

but it does not need the exact final frame from the previous shot.

```text
Can normally generate in parallel.
```

### `previous-shot`

Requires actual previous ending frame.

```text
shot_04/end_actual.png
        ↓
shot_05/start.png
```

Must execute serially.

---

# 13. Chain Rules

For `previous-shot` sequences:

```text
Shot N
↓
generate
↓
download
↓
normalize
↓
machine QA
↓
vision QA
↓
human decision
↓
accepted
↓
extract end_actual
↓
prepare next start frame
↓
Shot N+1
```

A bad `shot_04` must **never cause paid generation of shot_05**.

Continuity graph validation checks:

- no cycles
- no missing `previousShot`
- valid shot references
- warn on long chains because drift increases

Long chains generate a warning rather than a hard failure.

---

# 14. Independent-Shot Processing

Independent/reference-only shots can run concurrently:

```text
Generate batch
↓
Download batch
↓
Normalize batch
↓
Machine QA batch
↓
Vision QA
↓
Human review flagged shots
```

Concurrency is capped.

Polling uses:

- exponential backoff
- global job timeout
- retry-safe state

---

# 15. QA Architecture

## Tier 1 — Free Machine QA

Run before expensive intelligence/retries.

Checks:

- corrupt file
- wrong duration
- black frames
- blank video
- frozen video
- unexpected FPS
- resolution mismatch
- aspect mismatch
- missing audio where required

---

## Tier 2 — Vision QA

Extract representative frames using FFmpeg.

Check:

- shot matches intent
- correct character
- correct wardrobe
- correct environment
- progression makes sense
- bad morphing
- severe anatomy problems
- object consistency
- start-frame similarity
- end-target similarity

Vision QA **flags problems**.

During v1 it does not autonomously spend retry credits.

---

# 16. Human Retry Decision — V1

During early production:

```text
Vision QA
↓
FLAGGED
↓
Human chooses:

ACCEPT
RETRY
FALLBACK
```

Possible failure classes can be recorded:

```text
prompt issue
bad random generation
model capability issue
continuity issue
unusable
```

Later, after videos 1–5 provide real failure data, this can become automated.

---

# 17. Fallback Strategy

If retry isn't worth the cost:

```text
Video failed
↓
Use high-quality image
↓
HyperFrames:
- push-in
- pan
- crop
- parallax
- subtle motion
```

This prevents one difficult shot from blocking the entire project.

---

# 18. Motion-Ratio Policy

Cost optimization must not make the result look like a slideshow.

Example v1 policy:

```text
real motion ≥ ~55–60% total runtime

no still > 3 seconds

no more than 2 consecutive non-motion shots

opening = real motion

closing = real motion
```

Run the lint twice.

### Lint #1

After edit planning.

### Lint #2

After video failures/fallbacks.

This catches situations where multiple fallback images reduce the real-motion ratio.

---

# 19. Budget Protection

`state.json` contains:

```text
maxBudgetUSD
spentUSD
reservedUSD
creditsStart
creditsUsed
creditsRemaining
```

Before **every paid API call**:

```text
current spend
+
expected call cost
≤
maxBudgetUSD
```

Otherwise:

```text
HARD STOP
```

This applies to:

- first generation
- retries
- escalated models
- paid image generation
- paid audio generation

Not only to the first approval gate.

---

# 20. Dry Run

Support:

```bash
npm run video -- --dry-run
```

Dry run performs:

```text
Idea
→ planning
→ storyboard specification
→ edit plan
→ generation plan
→ billable durations
→ model choices
→ estimated cost
```

with:

```text
$0 spent
```

Outputs:

```text
reports/cost-estimate.md
```

---

# 21. Gates Are Resumable

Never keep the CLI waiting indefinitely for interactive input.

At Gate 1:

```text
write state
print review information
exit
```

Resume:

```bash
npm run approve -- project-name --gate cost
```

At Gate 2:

```text
write contact sheet
write state
exit
```

Resume:

```bash
npm run approve -- project-name --gate look
```

Same principle for human retry decisions.

This makes runs safe against:

- terminal closing
- laptop sleep
- SSH disconnect
- Claude session ending

---

# 22. Paid Asset Protection

**Never overwrite a paid asset.**

Each generation gets a unique identity based on inputs such as:

```text
hash(
  prompt
  + model
  + startFrameHash
  + endFrameHash
  + duration
  + important settings
)
```

If the exact asset already exists:

```text
reuse it
```

Do not pay again.

---

# 23. Manifest

Every paid generation is immediately written into:

```text
manifest.json
```

before polling/download finishes.

Example information:

```text
shotId
assetHash
provider
model
prompt
seed
jobId
remoteURL
submittedAt
billableDuration
estimatedCost
actualCost
status
localFile
accepted
```

If the application crashes after submission, the job is still recoverable.

---

# 24. Prompt Library

No separate manual prompt-library workflow.

When a shot is accepted:

```text
accepted prompt
+
model
+
seed
+
shot type
+
quality result
```

already exists in the manifest.

The prompt library becomes a query over historical manifests.

Examples:

```text
best accepted digging prompts
best reveal prompts
best hands-close-up prompts
best transformation prompts
```

It improves automatically as more videos are produced.

---

# 25. Proof Mode

Support:

```bash
npm run video -- --proof
```

Creates approximately:

```text
15 seconds
3 shots
```

But uses:

- actual production model
- actual resolution
- actual prompt process
- actual references
- actual QA
- actual HyperFrames path

It validates both:

- technical pipeline
- visual quality

Proof assets live inside the **same project and manifest** as the full video.

Therefore accepted proof shots can be reused in the final video.

No regeneration.

---

# 26. FFmpeg Normalization

Project settings are locked at project initialization:

```json
{
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "colorspace": "bt709"
}
```

Every generated clip goes through:

```text
download
↓
normalize
↓
HyperFrames
```

Different AI model outputs never go directly into the final timeline.

---

# 27. HyperFrames Role

HyperFrames is the main creative editing layer.

It handles:

- cuts
- timing
- transitions
- Ken Burns
- still animation
- zoom
- pan
- speed changes
- overlays
- text
- captions
- music
- SFX
- ambience
- native video audio
- fades
- volume automation
- final composition

FFmpeg remains the technical processing layer.

No Remotion required for v1.

---

# 28. Optional Upscale

Not mandatory.

```text
Final HyperFrames Render
↓
If upscale enabled:
    AI/local upscale
↓
Thumbnail
```

Otherwise:

```text
Final Render
↓
Thumbnail
```

Thumbnail should come from the final-resolution output.

---

# 29. Final QA

Final QA is **report only**.

It may check:

```text
runtime
resolution
fps
audio presence
black frames
render corruption
motion ratio
potential suspicious shots
```

But it does **not automatically trigger paid regeneration**.

It creates:

```text
qa-report.json
```

Human decides whether further spending is worthwhile.

---

# 30. Thumbnail

Thumbnail creation is an explicit stage.

Possible strategies:

```text
extract strongest final frame
```

or:

```text
generate dedicated thumbnail image
```

Outputs:

```text
thumbnail.png
```

Title suggestions can also be generated by Claude as packaging output.

---

# 31. Development Mode

Initially:

```text
Idea
↓
Gate 1
↓
Gate 2
↓
Generation
↓
Machine QA
↓
Vision QA
↓
Human retry decisions
↓
Final render
```

This is used for the first several videos.

---

# 32. Automation Mode — Later

Once real failure patterns are understood:

```text
Idea
↓
Automatic pipeline
↓
Stop only when:
- budget exceeded
- unrecoverable technical error
- QA confidence below configured threshold
```

Human checkpoints can gradually become optional.

---

# 33. Final Folder Structure

```text
video-automation/
│
├── CLAUDE.md
├── package.json
├── tsconfig.json
├── .env
│
├── config/
│   ├── models.json
│   ├── project-defaults.json
│   └── quality-policy.json
│
├── .claude/
│   └── skills/
│       └── video-generator/
│           ├── SKILL.md
│           └── references/
│               ├── story.md
│               ├── audio.md
│               ├── storyboard.md
│               ├── edit-plan.md
│               ├── model-selection.md
│               ├── generation.md
│               ├── qa.md
│               └── hyperframes.md
│
├── src/
│   ├── cli/
│   ├── schemas/
│   ├── orchestrator/
│   ├── planning/
│   ├── state/
│   ├── manifest/
│   ├── budget/
│   ├── gates/
│   ├── images/
│   ├── higgsfield/
│   ├── audio/
│   ├── ffmpeg/
│   ├── qa/
│   ├── timeline/
│   ├── thumbnail/
│   └── reports/
│
├── hyperframes/
│   ├── components/
│   ├── templates/
│   ├── compositions/
│   └── render.ts
│
├── assets/
│   └── music/
│
└── projects/
    └── <project-name>/
        │
        ├── idea.md
        ├── state.json
        ├── manifest.json
        │
        ├── planning/
        │   ├── story.json
        │   ├── music.json
        │   ├── beat-grid.json
        │   ├── progression.json
        │   ├── continuity.json
        │   ├── shotlist.json
        │   ├── storyboard.json
        │   ├── edit-plan.json
        │   ├── generation-plan.json
        │   └── audio-plan.json
        │
        ├── references/
        │   ├── character/
        │   ├── environment/
        │   ├── props/
        │   ├── style/
        │   └── progression/
        │
        ├── storyboard/
        │   ├── contact-sheet.png
        │   └── frames/
        │
        ├── shots/
        │   └── shot_001/
        │       ├── start.png
        │       ├── end_target.png
        │       ├── original.mp4
        │       ├── normalized.mp4
        │       ├── end_actual.png
        │       └── metadata.json
        │
        ├── stills/
        ├── audio/
        ├── checkpoints/
        ├── logs/
        │
        ├── reports/
        │   ├── cost-estimate.md
        │   ├── cost.md
        │   └── qa-report.json
        │
        └── output/
            ├── final.mp4
            └── thumbnail.png
```

# 34. Main CLI Stages

Conceptually:

```bash
npm run plan:story
npm run plan:audio
npm run plan:storyboard
npm run plan:edit
npm run plan:generation

npm run cost

npm run approve -- <project> --gate cost

npm run gen:references

npm run approve -- <project> --gate look

npm run gen:shots

npm run qa:machine
npm run qa:vision

npm run review -- <project>

npm run render

npm run upscale

npm run thumbnail

npm run qa:final

npm run report
```

And convenience commands:

```bash
npm run video -- --proof
npm run video -- --dry-run
npm run video -- --resume <project>
```

---

# 35. Zod Validation

Every planning artifact is validated before it can drive execution.

Especially:

```text
story
music
beat-grid
progression
continuity
shotlist
storyboard
edit-plan
generation-plan
audio-plan
state
manifest
```

Invalid JSON must fail **before any paid API call**.

---

# 36. Final User Experience

Ultimately:

```text
$ claude

> Create a 90-second cinematic video of a man
> converting an abandoned bus into a luxury home.
```

Claude handles everything.

During v1 it may stop at:

```text
Cost approval required.
```

then:

```text
Visual approval required.
```

and later:

```text
2 shots require review.
```

Once the system matures, even those gates can become optional.

---

# 37. The Five Most Important Rules

**1. Claude plans; deterministic code spends.**

**2. Plan the HyperFrames timeline before paying for video generation.**

**3. Check the budget before every single paid call.**

**4. Never regenerate or overwrite a paid asset when it can be resumed/reused.**

**5. A continuity-chain shot must pass QA before generating the next dependent shot.**

This is the **locked v1 architecture**. Further architecture changes should now come from evidence gathered during the first `--proof` and the first 3–5 real videos.