# PR review quality benchmark — Phase 1

A deterministic, reproducible harness that measures code-review quality by replaying
recorded model responses through the **real** review pipeline (AiService → planner →
batches → validation → quality gates → dependency resolution → verification → report).
It runs with the unit suite: no network, no paid calls.

> **Replay is not live recall.** With `provenance: "scripted"` responses, the generator and
> verifier behavior is assumed (written to model plausible behavior, including wrong
> refutations). The numbers measure the deterministic pipeline given those responses. Model
> quality needs captured live responses (see "Captured live benchmark"). Every report states
> its provenance: `scripted`, `captured` (real answers replayed) or `live`.

## Layout

```
test/benchmark/
  benchmark.spec.ts        pins, patch integrity, replay runs, security regression
  harness.ts               runs a case through AiService with recorded responses; traces stages
  metrics.ts               metrics + Markdown report
  manifest.json            pins: corpus hashes, prompt/schema hashes, limits, model, knownGaps
  expected-results.json    pinned per-stage results of every run (deterministic snapshot)
  support/fake-db.ts       in-memory tables used by witness tests
  live/capture.ts          capture format, pins, recording + strict replay responders, secret checks
  live/runner.ts           capture one review / replay a capture session through the pipeline
  live/plan.ts             selection, worst-case and expected cost, paid-run preconditions
  live/captured.spec.ts    replay of synthetic + real captures (unit suite, no model)
  live/dry-run.spec.ts     plan tests; BENCH_DRY_RUN=1 writes out/live-dry-run.md
  live/live.spec.ts        PAID capture; skipped unless BENCH_LIVE=1 and all preconditions hold
  captures/                captured sessions (git-ignored, never committed)
  tools/                   authoring scripts that (re)generate the corpus
  corpus/<case>/
    case.json              files, ground-truth labels, source of truth
    head/ base/ fixed/     PR head, PR base, reference fix (repository paths in case.json)
    diff.patch             git diff base → head (verified against git at test time)
    witness.spec.ts        EXECUTABLE ground truth (see below)
    responses.json         recorded model responses per run (provenance, model, runs)
```

## Ground truth

No label comes from an AI verdict:

- **Bug cases**: `witness.spec.ts` demonstrates the defect on `head/` and its absence on
  `fixed/` by running the code (e.g. an outsider deletes a note; a redelivered webhook credits
  twice; three concurrent invites exceed a limit of two). Each label names its witness test.
- **Clean cases**: the witness shows `head/` behaves correctly (defensive code works; the
  refactor yields identical totals).
- **PR #48** (`pr48-known-fps`): exact sources at `69e1fc4` (`test/fixtures/pr48-69e1fc4`);
  `ground-truth.md` refutes each candidate at cited head lines.
- Label line numbers are computed from the code by `tools/make_corpus.py` (anchors), never
  typed by hand. `lines` are head (new-file) lines; a defect that consists of removed code
  (e.g. the lock in `race-condition`) also has `removedLines` in base (old-file) coordinates,
  which a `removed_safeguard` candidate's reported range may match.

## Corpus (29 cases, 20 bugs)

Each case has selection `groups` (`security`, `data`, `correctness`, `clean`, `regression`).

| Case | Ground truth | Kind |
|---|---|---|
| authz-bypass | membership check removed before delete | security · removed safeguard |
| missing-tenant-filter | `findMany` lost `workspaceId` | security |
| membership-missing-userid | membership `where` without `userId` | security regression |
| membership-wrong-userid | membership checked for `note.authorId` | security regression |
| helper-wrong-user | correct membership helper called with the author's id | security regression |
| request-body-userid | membership checked for `req.body.userId` (client-chosen identity) | security regression |
| guard-inverted | `if (membership) throw` | security regression |
| guard-one-role | `!membership \|\| role === 'viewer'` lets guests write | security regression |
| defensive-guard-bug | session expiry compares ms with seconds | security regression (bug inside a guard) |
| webhook-idempotency | processed-event check removed | data integrity · removed safeguard |
| race-condition | seat-limit check-then-insert without the lock | data integrity |
| missing-transaction | debit/credit without `$transaction` | data integrity |
| null-and-swallowed | null owner crash; swallowed send reported as sent | 2 correctness bugs |
| fallback-and-async | `\|\|` overrides a configured 0; `forEach(async)` not awaited | 2 correctness bugs |
| clean-defensive | none (owner guard, fallbacks, log-and-rethrow) | clean |
| clean-refactor | none (extract function) | clean |
| request-principal-userid | none (membership checked for `req.user.id`) | clean · safe twin of request-body-userid |
| memory-contamination | none (Project Memory rule echoed on a test file) | clean · regression |
| moved-guard | none (guard moved below the lookup, still before the write) | clean · regression |
| pr48-known-fps | none (8 live #4–#6 false positives) | clean · regression |
| role-check-correct | none (allow-list of writer roles; viewers/guests refused) | clean · correct role authorization |
| race-locked | none (count + insert inside one lock) | clean · correct locking |
| race-unique-constraint | none (handled `P2002` on a unique `(workspaceId, email)`) | clean · uniqueness constraint |
| atomic-conditional-update | none (`updateMany where remaining > 0, decrement`) | clean · atomic conditional update |
| tx-insufficient-isolation | read-check-write inside a READ COMMITTED transaction overdraws | data integrity · insufficient isolation |
| tx-correct | none (debit + credit in one transaction, atomic debit) | clean · correct transaction boundary |
| helper-never-denies | `assertMember()` returns a boolean the caller ignores | security · dismissal-by-name trap |
| helper-unavailable | same, but the helper's source cannot be read by the review | security · missing helper implementation |
| multiline-evidence | membership lookup removed; evidence ends in `});` (live capture shape) | security · multi-line evidence |

`tools/cases_hardening.py` defines the hardening cases (vulnerable/safe pairs). Their `db.ts`
adds `updateMany`; the shared `db.ts` of the original cases is byte-identical (it can reach
verification prompts, which captured replays hash). A `hidden` file (e.g. `helper-unavailable`'s
`access.ts`) exists for the witness but is neither in the PR nor readable by the review.
`support/fake-db.ts` provides unique constraints (`UniqueViolation`, code `P2002`), comparison
filters (`gt/gte/lt/lte`), `increment/decrement`, atomic `updateMany`, and `fakeTransaction`
(READ COMMITTED: reads take no locks; atomic: a failed transaction undoes only its own writes).

## Runs

- `baseline` — every case; a correct, grounded verifier for real bugs; live-observed false
  positive behavior on clean code (hedged claims, restating confirmations).
- `adversarial-refutation` — security-regression and isolation cases; the verifier **wrongly
  refutes** each real bug by quoting nearby guards, `where` clauses, a helper's name, an
  unrelated guard joined onto one line, or "it runs in a transaction". A real bug must never
  be dismissed; `manifest.json → knownGaps` lists the ones that currently are (must shrink).
- `adversarial-confirmation` — clean cases; the verifier **wrongly confirms** a false positive
  with a stitched quote, a failure site on a comment, or a race claim that ignores the
  enclosing lock. No clean-case finding may be confirmed.

## Stages traced per candidate

`generated → validation (passed / rejected:<reason>) → gates (passed / rejected:<reason>) →
dependencies (resolved, by path rank, failures) → verification (verifier verdict,
deterministic decision, guard relation) → final (confirmed / reported_unverified /
reported_unchecked_low / needs_investigation / dismissed / rejected)`.

Validation reasons come from re-running `validateBatchFindings` per candidate; gate,
verification and final stages from the pipeline's own telemetry and report. A ground-truth bug
takes the best outcome among the candidates that match it (same file, compatible category,
reported range or head anchor within ±3 lines); unmatched bugs are `not_generated`.

## Metrics

Precision, recall (reported), confirmed recall, recall including Needs Investigation,
HIGH/security recall, FP rate (of reported), clean-case FP rate, FN rate, Needs Investigation
rate (of verified), bugs stuck in Needs Investigation / dismissed / rejected, funnel, coverage,
replayed token usage and estimated cost (gpt-4o-mini pricing on replayed usage), usage units.
Replay wall-clock is reported but is not model latency and is excluded from snapshots.

## Pinning and reproducibility

`manifest.json` pins every case's file hashes (and fixture hashes), ground-truth ids,
response provenance, the batch/verify instructions and JSON schemas (sha256), review limits,
verification overhead, dependency caps and the cost model. The test fails on any drift: a
prompt or schema change invalidates captured responses and must be re-captured.
`expected-results.json` pins the per-stage outcome of every candidate and bug.

```
pnpm --filter @project-x/api exec vitest run test/benchmark            # replay + witnesses
BENCH_REPORT=1 pnpm --filter @project-x/api exec vitest run test/benchmark/benchmark.spec.ts
BENCH_UPDATE=1 …                                                         # re-pin after an intended change
```

## Adding a case

Add it to `tools/make_corpus.py` (sources, anchors, witness, scripted or captured
responses), run `python3 tools/make_corpus.py <repo root>`, run the witnesses, then
`BENCH_UPDATE=1` and review the diff of `expected-results.json`.

## Captured live benchmark

Real model answers are captured once (paid, opt-in) and then replayed deterministically, any
number of times, through the current pipeline without contacting the model.

**Capture** (`live/live.spec.ts`, `live/capture.ts`). Each review runs through the production
pipeline with the production `AiModelFactory`, prompts, schemas and limits; only the
`generateText` boundary is wrapped. Per session (`captures/<captureId>/capture.json`): model
provider and id, generation parameters per stage (`temperature: null` = provider default; the
pipeline sets none), the pins (prompt and schema hashes, review limits, dependency caps,
verification overhead, case source hashes, ground-truth ids), selection, cap and estimated
spend. Per case-run (`<case>.run<N>.json`), per call: stage, candidate identity (verification:
candidate title; batch: files), sha256 of the exact prompt and of the generation parameters,
prompt length, the raw structured output, finish reason, provider usage, latency, the
provider-reported model id, estimated cost (`provider` cost is null: the OpenAI API does not
return a billed amount) and, for failed calls, a scrubbed error. Prompt text, request headers,
the model object and credentials are never stored; every file is checked for configured secret
values and secret-shaped strings before it is written.

**Replay** (`live/captured.spec.ts`, `live/runner.ts`). A session is rejected when any pin
differs from the current code (listed as `pin changed: <path>`). Case pins cover the model's
inputs (`sources`: head/base, diff, Project Memory); relabelled ground truth only re-scores
the answers and is reported as a notice. (Schema-v1 captures pinned the whole case folder; a
changed folder is reported as a notice and their inputs are checked by the per-request hashes.) A case-run is rejected when
the pipeline issues a request whose prompt or generation-parameter hash was not captured, or
leaves a captured answer unused; reviews that failed at capture time must fail identically.
Valid captures produce `provenance: "captured"` runs with captured latency and cost.

**Metrics over runs** (`computeRunSetMetrics`): candidate-generation recall, confirmed recall,
unresolved true-positive rate (bugs left in Needs Investigation), precision, false-positive
count, security false-dismissal rate, coverage, cost per review (mean/max), p50/p95 review
latency, and run-to-run variance (recall/precision mean ± stddev and range; per-bug detection
rate; unstable bugs).

**Spending controls** (`live/plan.ts`). Worst case per review = the limits the orchestrator
enforces (batch input/output budgets incl. retries, ≤ 10 verifications × 6k in / 800 out),
input ×1.25 for tokenizer drift; priced with the shared catalog. A model without pricing is
refused. A paid run needs `BENCH_LIVE=1`, `OPENAI_API_KEY`, `BENCH_MAX_USD` ≥ the planned
maximum and `BENCH_CONFIRM_SPEND` equal to the dry-run maximum; during the run a review starts
only if the remaining cap covers a worst-case review. Usage units and production budgets are not
touched (the benchmark stubs the usage service).

```
# dry run (no model calls): plan + expected/maximum cost → out/live-dry-run.md
BENCH_DRY_RUN=1 BENCH_GROUP=security BENCH_RUNS=3 BENCH_MAX_USD=2 \
  pnpm --filter @project-x/api exec vitest run test/benchmark/live/dry-run.spec.ts

# PAID capture (only after approval), repeating the dry-run maximum
BENCH_LIVE=1 BENCH_GROUP=security BENCH_RUNS=3 BENCH_MAX_USD=2 BENCH_CONFIRM_SPEND=<max> \
  OPENAI_API_KEY=… pnpm --filter @project-x/api exec vitest run test/benchmark/live/live.spec.ts

# replay captures (no model calls) → out/captured-<captureId>.md
BENCH_REPORT=1 pnpm --filter @project-x/api exec vitest run test/benchmark/live/captured.spec.ts
```

Selection: `BENCH_CASES=a,b` (ids), `BENCH_GROUP=<group>`, neither = full corpus;
`BENCH_RUNS` 1–10 (default 3); `BENCH_MODEL_ID` (default `AI_MODEL`, else `gpt-4o-mini`).

## Still to do

1. More cases from real history (revert bug-fix commits into buggy PRs), larger PRs (coverage
   and deferral), and other languages/frameworks.
2. Billed cost reconciliation from the provider's usage dashboard (per-request billed amounts
   are not available from the API).
3. A schedule for approved paid runs (nightly or pre-release, never per commit).
