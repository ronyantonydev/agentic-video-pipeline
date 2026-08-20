# Contributing

This project spends real money. Most of the rules below exist because
something went wrong once and cost credits to discover.

## Setup

```bash
npm install
cp .env.sample .env
npm run doctor
```

Set `PROVIDER_MODE=fake` for development. It exercises every code path with
synthesised H.264 media and makes a paid call impossible.

```bash
npm test          # 305 tests
npm run typecheck
```

## The rule that matters most

**Never let a cost be guessed.**

`resolveCost` throws `UnknownCostError` when no trusted source yields a
price. Do not add a fallback that returns a number. An invented price passes
a budget check and spends money.

Three cost bugs made it into this codebase during development, all caught by
the automated checks before reaching production:

- a manifest total that counted an unknown cost as `$0`
- an estimate parser that defaulted missing credits to `0`
- settlement that scaled the estimate by an actual/estimated *ratio*,
  producing a 32× undercount — a `$20` budget would have permitted `$640`

Every one of them looked reasonable while being written. That is why the
checks are mechanical rather than a matter of care.

## Before touching anything that spends

Read `.claude/skills/verify-spend-safety/SKILL.md` and check your change
against it. The order below is fixed and must not be rearranged:

```text
resolveCost → authorizeSpend → appendEntry → submit → poll → settleSpend
```

`appendEntry` before `submit` is what makes a crash recoverable.
`authorizeSpend` before `appendEntry` is what enforces the budget.

`HardStop` is terminal. Never catch it and continue.

## Before touching prompts or planning

Read `.claude/skills/verify-realism/SKILL.md`. The four rules there came from
a paid run the user rejected, and they apply to every video, not just the one
that produced them.

## Tests

Prefer real fixtures over mocks. The QA suite builds actual MP4s with ffmpeg
because that is what caught the bug where a "blank frame" check was measuring
brightness *between* frames instead of contrast *within* one — it failed eight
perfectly good clips.

A test that would have caught a bug you just fixed is worth more than three
that assert what already works.

## Documenting limitations

If a check cannot do what its name suggests, say so in the code and assert
the boundary in a test. The blank-frame detector cannot see through letterbox
padding; `machine.ts` says so, and `qa.test.ts` asserts both the working case
and the limited one.

Hiding a limitation is worse than having one.

## Commits

Explain **why**, not what. The diff already shows what.

When a change fixes a bug, say what the bug would have cost. When a design
decision has a trade-off, name it.

## Skills

Skills live in `.claude/skills/`. Two kinds:

- **User-invoked** (`make-video`, `grill-video`) — orchestrate a workflow
- **Model-invoked** (`verify-*`) — guardrails Claude reaches for automatically

Adding a rule to a `verify-*` skill is usually better than adding a comment.
A comment is read once; a skill is enforced every time.

## Claude Code settings

Two files, and the difference matters:

| File | Committed | Contains |
|---|---|---|
| `.claude/settings.json` | yes | Shared, conservative defaults for everyone |
| `.claude/settings.local.json` | **no** (gitignored) | Your personal choices |

The shared file allows only free, local, read-only things: build, typecheck,
test, and the Higgsfield tools that just report status or balance. Anything
that **spends money** — `generate_*`, `upscale_*`, `npm run gen:*` — is in
`ask`, so it stops and confirms.

That is deliberate. A clone should never be able to spend your credits
without asking. If you want generation to run unattended on your own machine,
put those entries in `settings.local.json` — never in the shared file.

Do not commit `defaultMode: "dontAsk"`. It disables confirmation for every
tool, including on someone else's machine and someone else's card.
