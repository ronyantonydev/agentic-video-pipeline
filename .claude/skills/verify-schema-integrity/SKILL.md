---
name: verify-schema-integrity
description: Check that every planning artifact is Zod-validated before it can drive execution, that state.json and manifest.json writes are atomic and validated, and that paid work can never be lost or double-charged. Run after editing src/schemas/, src/state/, or src/manifest/.
allowed-tools: [Read, Grep, Glob, Bash]
---

# Verify schema and persistence integrity

These rules protect the two files that represent real money: `state.json`
(where the run is) and `manifest.json` (what has been paid for).

Report PASS/FAIL per check with `file:line`. Report before fixing.

## 1. Nothing unvalidated reaches execution

Architecture §35: invalid JSON must fail before any paid API call.

- Every artifact in `PLANNING_ARTIFACTS` has a schema and is parsed with
  `safeParse` (or `parse`) before its data is used.
- No `JSON.parse(...)` result flows into a generation path without passing
  through a Zod schema first.
- `as` casts on parsed JSON are a FAIL - that defeats validation.
- Grep: `JSON.parse` outside `src/schemas/`, `src/config/`, `src/state/`,
  `src/manifest/` should be justified.

## 2. Writes are atomic and validated

- `state.json` and `manifest.json` are only ever written via
  `writeJsonAtomic` / `writeFileAtomic`. A direct `writeFileSync` to either
  is a FAIL.
- `writeState` and `writeManifest` validate before writing, never after.
- Grep: `writeFileSync.*state.json`, `writeFileSync.*manifest.json`.

## 3. Paid work is never lost

Architecture §23: the manifest entry is written BEFORE the job is submitted.

- No code path deletes a manifest entry.
- `updateEntry` must not permit changing `assetHash`, `prompt`, `model`,
  `provider`, or `submittedAt` - rewriting that history breaks accounting.
- Entries with status `submitted` or `polling` must be discoverable after a
  crash (`findInFlight`).

## 4. Paid work is never double-charged

Architecture §22.

- `appendEntry` refuses a duplicate `assetHash`.
- `computeAssetHash` includes every input that changes the output: kind,
  model, prompt, duration, start/end frame hashes, seed, settings.
- Adding a new generation parameter REQUIRES adding it to the hash. If you
  see a parameter passed to a provider that is not in `computeAssetHash`,
  that is a FAIL - two different generations would collide.

## 5. Cost accounting is honest

- `totalSpentUSD` / `totalSpentCredits` prefer `actual*` over `estimated*`.
- `failed`, `cancelled`, and `refunded` entries are excluded - Higgsfield
  does not charge for these, and counting them would block spending that is
  actually available.
- No cost value defaults to `0` when unknown. Unknown is `null`.

## 6. State is resumable

Architecture §21.

- `STAGES` order is never rearranged without a migration - resume compares
  indexes.
- Gate stages precede the work they guard: `gate-cost` before `references`,
  `gate-look` before `generate-shots`.
- Motion lint runs twice: once before generation, once after.
- A corrupt `state.json` throws rather than silently resetting to `init`,
  which would re-run paid stages.

## 7. Budget invariant holds at the schema level

- `BudgetStateSchema` rejects `spentUSD + reservedUSD > maxBudgetUSD`.
- This is enforced on write, so invalid state cannot be persisted at all.

## How to run

```bash
npx tsc -p tsconfig.json --noEmit
npx vitest run tests/schemas.test.ts tests/persistence.test.ts tests/store.test.ts
```

Both must pass. Then verify checks 1-7 by inspection.

Pay particular attention to check 4 whenever a new provider parameter is
introduced - it is the easiest rule to violate silently.
