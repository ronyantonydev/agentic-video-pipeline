---
name: verify-provider-contract
description: Check that every generation backend honours the same contract, that the fake and real providers are interchangeable, that concurrency respects continuity chains, and that crash recovery never resubmits paid work. Run after editing src/higgsfield/ or src/orchestrator/.
allowed-tools: [Read, Grep, Glob, Bash]
---

# Verify provider contract

The pipeline is written against `GenerationProvider`, not against Higgsfield.
That is what let the whole thing be proven at \$0 before Phase 6. These checks
keep the seam intact.

Report PASS/FAIL per check with `file:line`.

## 1. Providers never enforce policy

A provider submits and polls. Nothing else.

- No provider implementation calls `authorizeSpend`, reads `state.json`, or
  touches the manifest. Budget policy lives in the guard, which runs before
  submit is ever reached.
- A provider that silently declines a call for cost reasons is a FAIL: the
  refusal must come from the guard, where it is visible and testable.

## 2. Fake and real are interchangeable

- `FakeProvider` and the real backend implement the same interface with no
  extra required arguments.
- The fake mirrors the real API's *constraints*, not just its shape:
  image2video models reject a missing start image, first-last-frame models
  reject a missing end image. Discovering those in Phase 6 is too late.
- `isPaid` is accurate. Cost learning must only record measurements from a
  paid provider - learning "1 credit" from the fake would poison pricing.

## 3. Settlement uses absolute figures, not ratios

The bug this check exists for: settlement once scaled the estimate by an
actual/estimated credit RATIO. A provider reporting credits on a different
scale settled at a fraction of the true cost, and the budget permitted many
times the intended spend.

- Convert reported credits to USD through the configured rate.
- Never compute `actual/estimated * estimatedUSD`.
- With no reported credit figure, settle at the AUTHORIZED amount. Never
  settle for less without positive evidence of a smaller charge.

## 4. Chains stop at the first failure

Architecture §13.

- `runChain` marks every downstream shot `skipped`, never attempts it.
- The skip reason names the shot that broke the chain.
- A shot whose start frame does not exist must not be submitted - that is
  money spent on a missing input.

## 5. Parallel work is capped and resilient

- `runParallel` never exceeds `maxConcurrency`.
- One failure does not abort the batch: other shots may already be paid for.
- Results come back in input order regardless of completion order.

## 6. Polling never loses a paid job

- Exponential backoff, capped at `maxDelayMs`, never sleeping past the
  deadline.
- On timeout the manifest entry stays `polling`, NOT `failed`. The job may
  still be running and already charged; marking it failed would lose it.
- The timeout message must say the job remains recoverable.

## 7. Recovery re-attaches, never resubmits

Architecture §23.

- `recoverInFlight` polls existing `jobId`s. It must never call `submit*`.
- Verify by asserting the provider's job count is unchanged after recovery.
- An entry with no `jobId` cannot be recovered - the crash landed before the
  provider answered. Mark it failed rather than resubmitting blind.

## 8. Asset identity covers every paid input

- Adding any parameter that reaches a provider REQUIRES adding it to
  `computeAssetHash`, or two different generations collide and the second
  silently reuses the first.
- Frame CONTENTS are hashed, not paths. A changed start frame is a different
  asset.

## How to run

```bash
npx vitest run tests/scheduler.test.ts tests/generation.test.ts
npx tsc -p tsconfig.json --noEmit
```

Then confirm an end-to-end run against `FakeProvider` produces: manifest
entries equal to shot count, every entry `completed` with a `localFile`,
`reservedUSD` back to zero, and recorded spend matching the dry-run estimate.
