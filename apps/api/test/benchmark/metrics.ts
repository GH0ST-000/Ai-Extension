/**
 * Benchmark metrics over traced case runs. Definitions (also in README.md):
 *
 * - reported            findings in "Risk Findings" (confirmed, UNVERIFIED LOW, unchecked LOW)
 * - true positive (TP)  a reported finding matching a ground-truth bug
 * - precision           TP reported / reported
 * - recall              ground-truth bugs reported / ground-truth bugs (confirmed or LOW)
 * - confirmed recall    ground-truth bugs reported as confirmed by verification / bugs
 * - recall incl. NI     bugs reported or in Needs Investigation / bugs
 * - HIGH/security recall  recall restricted to severity high or category security
 * - FP rate             reported findings matching no bug / reported findings
 * - clean-case FP rate  clean cases with ≥ 1 reported finding / clean cases
 * - FN rate             1 − recall
 * - NI rate             Needs Investigation entries / candidates that reached verification
 * - bugs stuck in NI    ground-truth bugs whose best outcome is Needs Investigation
 */
import type { CaseRun, FinalOutcome } from './harness';

const ratio = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 1000);

export type Metrics = {
  cases: number;
  truthBugs: number;
  reported: number;
  truePositives: number;
  falsePositives: number;
  precision: number | null;
  recall: number | null;
  confirmedRecall: number | null;
  recallIncludingNeedsInvestigation: number | null;
  highOrSecurityRecall: number | null;
  falsePositiveRate: number | null;
  cleanCaseFalsePositiveRate: number | null;
  falseNegativeRate: number | null;
  needsInvestigationRate: number | null;
  bugsStuckInNeedsInvestigation: string[];
  bugsDismissed: string[];
  bugsRejected: string[];
  bugsNotGenerated: string[];
  funnel: {
    generated: number;
    passedValidation: number;
    passedGates: number;
    verified: number;
    confirmed: number;
    dismissed: number;
    needsInvestigation: number;
    reported: number;
  };
  coverage: { reviewed: number; total: number; ratio: number | null };
  tokens: { input: number; output: number; calls: number; verificationCalls: number };
  estimatedCostUsd: number;
  usageUnits: number;
};

const REPORTED: FinalOutcome[] = ['confirmed', 'reported_unverified', 'reported_unchecked_low'];

export function computeMetrics(runs: CaseRun[]): Metrics {
  const truth = runs.flatMap((r) => r.truth);
  const candidates = runs.flatMap((r) => r.candidates);
  const reported = candidates.filter((c) => REPORTED.includes(c.final));
  const tp = reported.filter((c) => c.truth != null);
  const fp = reported.filter((c) => c.truth == null);
  const bugsReported = truth.filter((t) => REPORTED.includes(t.outcome));
  const highSec = truth.filter((t) => t.security || t.severity === 'high');
  const verified = candidates.filter((c) => c.verification != null);
  const clean = runs.filter((r) => r.clean);
  const idsWith = (o: FinalOutcome) => truth.filter((t) => t.outcome === o).map((t) => t.id);
  const sum = (f: (r: CaseRun) => number) => runs.reduce((n, r) => n + f(r), 0);
  return {
    cases: runs.length,
    truthBugs: truth.length,
    reported: reported.length,
    truePositives: tp.length,
    falsePositives: fp.length,
    precision: ratio(tp.length, reported.length),
    recall: ratio(bugsReported.length, truth.length),
    confirmedRecall: ratio(truth.filter((t) => t.outcome === 'confirmed').length, truth.length),
    recallIncludingNeedsInvestigation: ratio(
      truth.filter((t) => REPORTED.includes(t.outcome) || t.outcome === 'needs_investigation')
        .length,
      truth.length,
    ),
    highOrSecurityRecall: ratio(
      highSec.filter((t) => REPORTED.includes(t.outcome)).length,
      highSec.length,
    ),
    falsePositiveRate: ratio(fp.length, reported.length),
    cleanCaseFalsePositiveRate: ratio(
      clean.filter((r) => r.candidates.some((c) => REPORTED.includes(c.final))).length,
      clean.length,
    ),
    falseNegativeRate:
      truth.length === 0 ? null : ratio(truth.length - bugsReported.length, truth.length),
    needsInvestigationRate: ratio(
      candidates.filter((c) => c.final === 'needs_investigation').length,
      verified.length,
    ),
    bugsStuckInNeedsInvestigation: idsWith('needs_investigation'),
    bugsDismissed: idsWith('dismissed'),
    bugsRejected: idsWith('rejected'),
    bugsNotGenerated: idsWith('not_generated'),
    funnel: {
      generated: candidates.length,
      passedValidation: candidates.filter((c) => c.validation === 'passed').length,
      passedGates: candidates.filter((c) => c.gate === 'passed').length,
      verified: verified.length,
      confirmed: candidates.filter((c) => c.final === 'confirmed').length,
      dismissed: candidates.filter((c) => c.final === 'dismissed').length,
      needsInvestigation: candidates.filter((c) => c.final === 'needs_investigation').length,
      reported: reported.length,
    },
    coverage: {
      reviewed: sum((r) => r.coverage.reviewed),
      total: sum((r) => r.coverage.total),
      ratio: ratio(
        sum((r) => r.coverage.reviewed),
        sum((r) => r.coverage.total),
      ),
    },
    tokens: {
      input: sum((r) => r.tokens.input),
      output: sum((r) => r.tokens.output),
      calls: sum((r) => r.tokens.calls),
      verificationCalls: sum((r) => r.tokens.verificationCalls),
    },
    estimatedCostUsd: Math.round(sum((r) => r.costUsd) * 1e6) / 1e6,
    usageUnits: sum((r) => r.usageUnits),
  };
}

const pct = (v: number | null) => (v == null ? 'n/a' : `${Math.round(v * 1000) / 10}%`);

export function renderReport(runId: string, runs: CaseRun[], m: Metrics, replayMs: number): string {
  const rows = runs.flatMap((r) =>
    r.candidates.map(
      (c) =>
        `| ${r.caseId} | ${c.title.replace(/\|/g, '/')} | ${c.truth ?? '—'} | ${c.validation} | ${c.gate} | ${
          (c.verification?.decision as string | undefined) ?? '—'
        } | ${c.final} |`,
    ),
  );
  const truthRows = runs.flatMap((r) =>
    r.truth.map(
      (t) => `| ${t.id} | ${t.severity}${t.security ? ' · security' : ''} | ${t.outcome} |`,
    ),
  );
  return [
    `# Review quality benchmark — run \`${runId}\``,
    '',
    `> **Provenance: ${[...new Set(runs.map((r) => r.provenance))].join(', ') || 'n/a'}.** Replay of recorded responses through the real pipeline. With scripted responses this measures the deterministic pipeline, not live model recall.`,
    '',
    '## Metrics',
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Cases | ${m.cases} |`,
    `| Ground-truth bugs | ${m.truthBugs} |`,
    `| Reported findings | ${m.reported} (TP ${m.truePositives}, FP ${m.falsePositives}) |`,
    `| Precision | ${pct(m.precision)} |`,
    `| Recall (reported) | ${pct(m.recall)} |`,
    `| Confirmed recall | ${pct(m.confirmedRecall)} |`,
    `| Recall incl. Needs Investigation | ${pct(m.recallIncludingNeedsInvestigation)} |`,
    `| HIGH/security recall | ${pct(m.highOrSecurityRecall)} |`,
    `| FP rate (of reported) | ${pct(m.falsePositiveRate)} |`,
    `| Clean-case FP rate | ${pct(m.cleanCaseFalsePositiveRate)} |`,
    `| FN rate | ${pct(m.falseNegativeRate)} |`,
    `| Needs Investigation rate (of verified) | ${pct(m.needsInvestigationRate)} |`,
    `| Bugs stuck in Needs Investigation | ${m.bugsStuckInNeedsInvestigation.join(', ') || 'none'} |`,
    `| Bugs dismissed | ${m.bugsDismissed.join(', ') || 'none'} |`,
    `| Bugs rejected before verification | ${m.bugsRejected.join(', ') || 'none'} |`,
    `| Coverage | ${m.coverage.reviewed}/${m.coverage.total} files (${pct(m.coverage.ratio)}) |`,
    `| Tokens (replayed estimate) | ${m.tokens.input} in / ${m.tokens.output} out, ${m.tokens.calls} calls (${m.tokens.verificationCalls} verification) |`,
    `| Estimated cost (${'gpt-4o-mini'} pricing) | $${m.estimatedCostUsd} |`,
    `| Usage units | ${m.usageUnits} |`,
    `| Replay wall-clock | ${replayMs} ms (not model latency) |`,
    '',
    '## Funnel',
    '',
    `generated ${m.funnel.generated} → validated ${m.funnel.passedValidation} → past gates ${m.funnel.passedGates} → verified ${m.funnel.verified} → confirmed ${m.funnel.confirmed} · dismissed ${m.funnel.dismissed} · Needs Investigation ${m.funnel.needsInvestigation} → reported ${m.funnel.reported}`,
    '',
    '## Ground truth',
    '',
    '| Bug | Severity | Outcome |',
    '|---|---|---|',
    ...truthRows,
    '',
    '## Candidates (per stage)',
    '',
    '| Case | Candidate | Matches bug | Validation | Gates | Verification decision | Final |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

// ── run sets (several runs per case; scripted, captured or live) ───────────

/**
 * One measurement: `passes[i]` holds run i of every selected case. Metrics over a run set:
 *
 * - candidate-generation recall  bug-runs matched by ≥ 1 generated candidate / bug-runs
 * - confirmed recall             bug-runs confirmed by verification / bug-runs
 * - unresolved TP rate           bug-runs whose best outcome is Needs Investigation / bug-runs
 * - precision                    TP reported / reported (pooled over all runs)
 * - false positives              reported findings matching no bug (pooled count)
 * - security false-dismissal     security bug-runs dismissed / security bug-runs generated
 * - coverage                     files reviewed / changed files
 * - cost per review              mean and max of the per-review estimated cost
 * - latency                      p50 / p95 of review wall-clock (captured / live only)
 * - variance                     per-pass recall and precision (mean ± stddev, min–max) and
 *                                per-bug detection rate across runs; unstable bugs are
 *                                detected in some runs but not all
 */
export type RunSet = {
  label: string;
  provenance: CaseRun['provenance'];
  passes: CaseRun[][];
  /** Review wall-clock per case-run (captured / live); empty for scripted. */
  reviewLatencyMs: number[];
};

export type Spread = {
  mean: number | null;
  stddev: number | null;
  min: number | null;
  max: number | null;
};

export type RunSetMetrics = {
  provenance: CaseRun['provenance'];
  passes: number;
  reviews: number;
  bugRuns: number;
  candidateGenerationRecall: number | null;
  confirmedRecall: number | null;
  unresolvedTruePositiveRate: number | null;
  precision: number | null;
  falsePositives: number;
  securityFalseDismissalRate: number | null;
  coverage: number | null;
  costPerReviewUsd: { mean: number | null; max: number | null };
  latencyMs: { p50: number | null; p95: number | null };
  variance: {
    recall: Spread;
    precision: Spread;
    perBugDetectionRate: Record<string, number>;
    unstableBugs: string[];
  };
};

function spread(values: (number | null)[]): Spread {
  const v = values.filter((x): x is number => x != null);
  if (v.length === 0) return { mean: null, stddev: null, min: null, max: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { mean: r(mean), stddev: r(sd), min: r(Math.min(...v)), max: r(Math.max(...v)) };
}

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export function computeRunSetMetrics(set: RunSet): RunSetMetrics {
  const all = set.passes.flat();
  const truth = all.flatMap((r) => r.truth);
  const pooled = computeMetrics(all);
  const security = truth.filter((t) => t.security && t.outcome !== 'not_generated');
  const detection = new Map<string, number[]>();
  for (const t of truth) {
    detection.set(t.id, [...(detection.get(t.id) ?? []), REPORTED.includes(t.outcome) ? 1 : 0]);
  }
  const perBugDetectionRate = Object.fromEntries(
    [...detection].map(([id, hits]) => [
      id,
      ratio(
        hits.reduce((a, b) => a + b, 0),
        hits.length,
      )!,
    ]),
  );
  const costs = all.map((r) => r.costUsd);
  return {
    provenance: set.provenance,
    passes: set.passes.length,
    reviews: all.length,
    bugRuns: truth.length,
    candidateGenerationRecall: ratio(
      truth.filter((t) => t.outcome !== 'not_generated').length,
      truth.length,
    ),
    confirmedRecall: pooled.confirmedRecall,
    unresolvedTruePositiveRate: ratio(
      truth.filter((t) => t.outcome === 'needs_investigation').length,
      truth.length,
    ),
    precision: pooled.precision,
    falsePositives: pooled.falsePositives,
    securityFalseDismissalRate: ratio(
      security.filter((t) => t.outcome === 'dismissed').length,
      security.length,
    ),
    coverage: pooled.coverage.ratio,
    costPerReviewUsd: {
      mean: costs.length
        ? Math.round((costs.reduce((a, b) => a + b, 0) / costs.length) * 1e6) / 1e6
        : null,
      max: costs.length ? Math.max(...costs) : null,
    },
    latencyMs: {
      p50: percentile(set.reviewLatencyMs, 50),
      p95: percentile(set.reviewLatencyMs, 95),
    },
    variance: {
      recall: spread(set.passes.map((p) => computeMetrics(p).recall)),
      precision: spread(set.passes.map((p) => computeMetrics(p).precision)),
      perBugDetectionRate,
      unstableBugs: Object.entries(perBugDetectionRate)
        .filter(([, r]) => r > 0 && r < 1)
        .map(([id]) => id)
        .sort(),
    },
  };
}

const PROVENANCE_NOTE: Record<CaseRun['provenance'], string> = {
  scripted:
    '**Provenance: scripted.** Model answers were written by hand; this measures the deterministic pipeline, not model quality. Latency is not measured.',
  captured:
    '**Provenance: captured.** Real model answers recorded earlier, replayed through the current pipeline without contacting the model. Latency and cost are from the capture.',
  live: '**Provenance: live.** Real model calls made during this run.',
};

export function renderRunSetReport(set: RunSet, m: RunSetMetrics): string {
  const sp = (s: Spread) =>
    s.mean == null
      ? 'n/a'
      : `${pct(s.mean)} ± ${pct(s.stddev)} (min ${pct(s.min)}, max ${pct(s.max)})`;
  const ms = (v: number | null) => (v == null ? 'n/a' : `${v} ms`);
  const usd = (v: number | null) => (v == null ? 'n/a' : `$${v.toFixed(6)}`);
  return [
    `# Review quality — ${set.label} (${set.provenance})`,
    '',
    `> ${PROVENANCE_NOTE[set.provenance]}`,
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Provenance | ${m.provenance} |`,
    `| Runs per case / reviews / bug-runs | ${m.passes} / ${m.reviews} / ${m.bugRuns} |`,
    `| Candidate-generation recall | ${pct(m.candidateGenerationRecall)} |`,
    `| Confirmed recall | ${pct(m.confirmedRecall)} |`,
    `| Unresolved true-positive rate (Needs Investigation) | ${pct(m.unresolvedTruePositiveRate)} |`,
    `| Precision | ${pct(m.precision)} |`,
    `| False positives (count) | ${m.falsePositives} |`,
    `| Security false-dismissal rate | ${pct(m.securityFalseDismissalRate)} |`,
    `| Coverage | ${pct(m.coverage)} |`,
    `| Cost per review (mean / max) | ${usd(m.costPerReviewUsd.mean)} / ${usd(m.costPerReviewUsd.max)} |`,
    `| Latency p50 / p95 | ${ms(m.latencyMs.p50)} / ${ms(m.latencyMs.p95)} |`,
    `| Recall across runs | ${sp(m.variance.recall)} |`,
    `| Precision across runs | ${sp(m.variance.precision)} |`,
    `| Unstable bugs (detected in some runs only) | ${m.variance.unstableBugs.join(', ') || 'none'} |`,
    '',
    '## Per-bug detection rate across runs',
    '',
    '| Bug | Detected (reported) |',
    '|---|---|',
    ...Object.entries(m.variance.perBugDetectionRate).map(([id, r]) => `| ${id} | ${pct(r)} |`),
    '',
  ].join('\n');
}
