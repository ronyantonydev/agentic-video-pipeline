---
name: verify-spend-safety
description: EMBEDDED CHECK - run automatically before any code that could spend money is written, changed, or executed. Verifies that every paid call is preceded by a budget authorization, that no cost is ever guessed, and that HardStop can never be swallowed. Architecture rule 3.
allowed-tools: [Read, Grep, Glob, Bash]
---

# Verify spend safety

This is the most important verification in the project. It encodes
architecture rule 3: **check the budget before every single paid call.**

Run it whenever touching `src/budget/`, `src/higgsfield/`, `src/images/`,
`src/audio/`, or anything that submits a generation.

Report PASS/FAIL per check with `file:line`. A FAIL here blocks the change.

## 1. No paid call without authorization

Every function that submits a generation must call `authorizeSpend()` first,
in the same function or its direct caller.

- Grep for `fetch(` in `src/higgsfield/` - each POST that generates (not
  estimates, not `/models`) must be preceded by an authorization.
- Grep for MCP tool calls anywhere in `src/` - there must be none. Code
  spends via REST; Claude does not improvise paid calls (architecture §2).
- The order is fixed and must not be rearranged:

  ```
  resolveCost -> authorizeSpend -> appendEntry -> submit -> settleSpend
  ```

  `appendEntry` before submission is what makes a crash recoverable (§23).

## 2. No invented prices

- `resolveCost` must throw `UnknownCostError` when nothing resolves. A
  fallback that returns a number is a FAIL.
- No `?? 0`, `|| 0`, `?? 1`, or numeric literal applied to a credits/USD
  value outside `config/`.
- `parseEstimate` must return `null` for an unrecognised response shape, and
  must reject a zero cost from a paid endpoint - that is a parse miss, not a
  free generation.
- Sanity bands only WARN. They must never be used to synthesise a price.

## 3. HardStop is terminal

- No `catch` block in a paid path may swallow `HardStop`. Rethrow it, or do
  not catch it.
- Grep: `catch` inside `src/budget/`, `src/higgsfield/`, `src/images/`,
  `src/audio/`.
- `process.exitCode` for a HardStop is 4, distinct from a generic failure.

## 4. Reservations prevent concurrent overspend

Without reservation, two parallel jobs each see the full remaining budget and
both proceed, overspending by design.

- `authorizeSpend` increments `reservedUSD` before returning.
- Every authorization is eventually settled (`settleSpend`) or released
  (`releaseReservation`). A path that does neither leaks budget headroom.
- `releaseReservation` is what runs when a generation fails - Higgsfield does
  not charge for failures, so nothing may be deducted.

## 5. Unknown spend blocks authorization

- `authorizeSpend` refuses outright when any chargeable manifest entry has no
  recorded cost. Unknown total spend means unknown headroom.
- `assertFullyPriced` exists and is used before budget decisions.

## 6. Billable duration never rounds down

Architecture §7.

- `resolveBillableDuration` output always satisfies
  `billableSeconds >= requiredSeconds`.
- Discrete models snap UP to the next allowed value; range models clamp to
  the minimum floor.
- Rounding down would leave the edit short of footage it already planned for.

## 7. Escalation cannot silently raise cost

Architecture §8.

- `selectVideoModel` sets `requiresApproval: true` whenever the chosen model
  costs more than the preferred one.
- When a price is unknown, tier ranking decides - erring toward asking.
- Auto-switching is permitted only when it is free or cheaper.

## 8. The two catalogues are not confused

The REST API (`GET /models`, 13 models, `higgsfield-ai/*` slugs) is what the
API key can spend against. The MCP catalogue (Kling, Veo, Seedance, Nano
Banana) is reachable only through Claude's tools.

- Code in `src/` must use REST slugs, never MCP model ids.
- A MCP id like `kling3_0` appearing in a REST request path is a FAIL - it
  returns `model_not_found`.

## How to run

```bash
npx vitest run tests/budget.test.ts tests/duration.test.ts tests/model-selection.test.ts
npx tsc -p tsconfig.json --noEmit
```

Both must pass. Then verify checks 1-8 by inspection.

If any check fails, do not proceed to generation. Report the failure and
stop - this check exists precisely to catch the errors that cost money.
