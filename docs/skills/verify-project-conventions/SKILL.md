---
name: verify-project-conventions
description: Check that code in this repo follows the pipeline's structural rules - strict TypeScript, no silent cost defaults, config-driven model selection, and the Claude-plans/code-spends separation. Run after editing anything under src/ or config/.
allowed-tools: [Read, Grep, Glob, Bash]
---

# Verify project conventions

Structural rules for the agentic video pipeline. These encode decisions that
are easy to violate accidentally and expensive to discover late.

Report each check as PASS or FAIL with the offending `file:line`. Do not fix
anything unless asked - report first.

## 1. No silent cost defaults

The single most dangerous class of bug here: a cost that defaults to zero or a
guess, passes a budget check, and spends real money.

- `grep -rn "costCredits" src/ config/` - every unpriced entry must be `null`,
  never `0` and never a made-up number.
- No `?? 0`, `|| 0`, or `?? 1` applied to any cost, price, or credit value.
- Cost resolution must go through the documented order: estimate endpoint →
  learned/measured value → refuse. A fallback that invents a number is a FAIL.
- `UnknownCostError` must be thrown, not swallowed, when no source resolves.

## 2. HardStop is never caught and continued

`HardStop` means "stop spending now" (architecture §19).

- Search for `catch` blocks that could swallow it: any `catch` in a paid path
  must rethrow `HardStop` or not catch it at all.
- FAIL on `catch {}` or `catch (e) { log... }` anywhere under `src/budget/`,
  `src/higgsfield/`, `src/images/`, or `src/audio/`.

## 3. Strict TypeScript, honestly

- `tsconfig.json` keeps `strict: true` and `noUncheckedIndexedAccess: true`.
- No `any` in `src/` - use `unknown` and narrow.
- No `@ts-ignore` / `@ts-expect-error` without a comment explaining why.
- `npx tsc --noEmit` exits clean.

## 4. Config drives behaviour, code does not hardcode it

Model IDs, durations, resolutions, and thresholds live in `config/*.json`.

- No hardcoded model id strings (`kling3_0`, `nano_banana`, `veo3_1_lite`, …)
  in `src/` outside of `src/config/`. Tests may reference them.
- No hardcoded `1920`, `1080`, `30` for project video settings outside
  `config/` and `src/config/`.
- Quality thresholds come from `quality-policy.json`, not literals.

## 5. Claude plans, code spends

Architecture §2. The boundary must stay visible.

- Nothing in `src/` may call an MCP tool or otherwise improvise a paid request.
- Every paid call site must be preceded by an explicit budget check in the same
  function or its direct caller.
- Planning artifacts are validated by Zod before they can drive execution -
  `src/planning/` must not pass unparsed JSON into any generation path.

## 6. Errors are typed

- Throw the classes in `src/util/errors.ts`, not bare `Error`, for: budget
  stops, validation failures, unknown costs, capability mismatches, gates.
- `process.exit()` is not called outside `src/cli/` - stages set `exitCode`.

## 7. Tests exist for what matters

- Anything under `src/budget/`, `src/schemas/`, or `src/manifest/` has a
  matching test file in `tests/`.
- `npx vitest run` passes.

## How to run

```bash
npx tsc -p tsconfig.json --noEmit
npx vitest run
npx tsx src/cli/index.ts doctor
```

All three must succeed. Then work through checks 1-7 by inspection and report
a table of PASS/FAIL with file:line for every failure.
