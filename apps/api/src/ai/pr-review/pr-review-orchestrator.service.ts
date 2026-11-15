import { Injectable, Logger } from '@nestjs/common';
import { APICallError, generateText, NoObjectGeneratedError, Output, zodSchema } from 'ai';
import type { PRReviewBatchOutcome, PRReviewCoverage } from '@project-x/types';

import { AiObservabilityService } from '@/observability/ai-observability.service';
import { ProviderHealthService } from '@/observability/provider-health.service';
import { AiModelFactory } from '../models/ai-model.factory';
import {
  buildBatchUserContent,
  neutralizeDelimiters,
  PR_REVIEW_BATCH_INSTRUCTIONS,
  type BatchPromptContext,
} from './pr-review-batch.prompt';
import {
  buildContextBlocks,
  buildVerificationContext,
  renderContextBlocks,
  renderSection,
  type CodeSection,
  type FileContentProvider,
} from './pr-review-context';
import { matchEvidenceAll, type DiffLine } from './diff-hunks';
import {
  classifyTestCode,
  detectMemoryEcho,
  fullTextOfAddedFile,
  memoryRulesFromBlock,
} from './pr-review-candidates';
import { findCallers, needsCallers, type CallerStatus } from './pr-review-callers';
import { DependencyCache, resolveDependencies, type DependencyResult } from './pr-review-deps';
import { looksLikeTestPath } from './pr-review-files';
import { executionPathRanks } from './pr-review-site';
import {
  applyVerification,
  batchOutputSchema,
  groupSameRootCause,
  isOptionalCheck,
  mergeFindings,
  RUNTIME_CATEGORIES,
  selectEvidenceMatch,
  validateBatchFindings,
  verificationOrder,
  type BatchOutput,
  type RejectionReason,
  type ValidatedFinding,
} from './pr-review-findings';
import {
  assessVerdict,
  buildVerificationContent,
  PR_REVIEW_VERIFY_INSTRUCTIONS,
  SECURITY_CATEGORIES,
  VERIFY_REQUEST_OVERHEAD_CHARS,
  verificationSchema,
  type VerdictAudit,
  type VerificationOutput,
} from './pr-review-verify';
import {
  estimateTokens,
  sanitizeLimits,
  type PlannedBatch,
  type PrReviewLimits,
  type PrReviewPlan,
} from './pr-review-plan';

/**
 * Structured-output spec built once. The explicit type argument avoids TypeScript's deep
 * zod inference; the result is re-validated with the same zod schema after every call.
 */
let batchOutputSpec: ReturnType<typeof Output.object<BatchOutput>> | undefined;
function batchOutput() {
  batchOutputSpec ??= Output.object<BatchOutput>({
    schema: zodSchema(batchOutputSchema as never) as never,
    name: 'pr_review_batch',
  });
  return batchOutputSpec;
}

/** Everything a verification request sends: instructions, user message, schema + framing. */
function requestChars(content: string): number {
  return content.length + PR_REVIEW_VERIFY_INSTRUCTIONS.length + VERIFY_REQUEST_OVERHEAD_CHARS;
}

type DependencySummary = {
  resolved: number;
  partial: number;
  maxDepth: number;
  unresolved: number;
  /** Unresolved dependencies by reason (depth_limit, context_budget, file_budget, …). */
  failures: Record<string, number>;
  /** Shown dependencies by execution-path rank (focus statement, its path, function, other). */
  byPath: { focus: number; path: number; function: number; other: number };
  /** Path-relevant helpers (rank ≤ 1) left out for a budget or limit. */
  relevantNotShown: number;
};

type VerifyTrace = {
  startedAt: number;
  /** Optional LOW check (spare capacity): unconfirmed outcomes stay reported, UNVERIFIED. */
  lowCheck?: boolean;
  /** Path-relevant dependencies (failure statement / its path) removed by the ceiling. */
  relevantTrimmed?: number;
  callers?: CallerStatus;
  callersIncluded?: number;
  callersTrimmed?: number;
  contextMs?: number;
  modelMs?: number;
  promptTokensEstimate?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  dependencies?: DependencySummary;
  droppedForCeiling?: number;
  unprovenConfirmation?: boolean;
  errorCode?: string;
  /** What the verifier answered, and the deterministic rule that decided the outcome. */
  verifierVerdict?: VerificationOutput['verdict'];
  dependsOnCodeNotShown?: boolean;
  audit?: VerdictAudit;
};

function summarizeDependencies(deps: DependencyResult): DependencySummary {
  const failures: Record<string, number> = {};
  for (const u of deps.unresolved) failures[u.reason] = (failures[u.reason] ?? 0) + 1;
  return {
    resolved: deps.resolved.length,
    partial: deps.resolved.filter((d) => d.partial).length,
    maxDepth: deps.resolved.reduce((m, d) => Math.max(m, d.depth), 0),
    unresolved: deps.unresolved.length,
    failures,
    byPath: {
      focus: deps.resolved.filter((d) => d.pathRank === 0).length,
      path: deps.resolved.filter((d) => d.pathRank === 1).length,
      function: deps.resolved.filter((d) => d.pathRank === 2).length,
      other: deps.resolved.filter((d) => d.pathRank >= 3).length,
    },
    relevantNotShown: deps.unresolved.filter(
      (u) =>
        u.pathRank <= 1 &&
        (u.reason === 'context_budget' ||
          u.reason === 'function_limit' ||
          u.reason === 'file_budget'),
    ).length,
  };
}

let verificationOutputSpec: ReturnType<typeof Output.object<VerificationOutput>> | undefined;
function verificationOutput() {
  verificationOutputSpec ??= Output.object<VerificationOutput>({
    schema: zodSchema(verificationSchema as never) as never,
    name: 'pr_review_verification',
  });
  return verificationOutputSpec;
}

/** Spare batch room below this is not worth a context fetch. */
const MIN_BATCH_CONTEXT_CHARS = 1_500;
/** Files per batch that receive read-only context (fetched in parallel). */
const MAX_CONTEXT_FILES_PER_BATCH = 4;

/** At most one retry per batch, and only for transient failures. */
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 750;

export type PrReviewRunResult = {
  outcomes: PRReviewBatchOutcome[];
  /** All validated findings with their disposition (reported / needs_investigation / dismissed). */
  findings: ValidatedFinding[];
  findingStats: PRReviewCoverage['findings'];
  /** True when the client cancelled (as opposed to a deadline or provider failure). */
  cancelled: boolean;
  /** Batch + verification totals (provider usage where reported, reservations otherwise). */
  tokens: { input: number; output: number; calls: number };
  verificationTokens: { input: number; output: number; calls: number };
};

type AttemptFailure = {
  code:
    | 'provider_error'
    | 'rate_limited'
    | 'timeout'
    | 'invalid_output'
    | 'output_limit'
    | 'cancelled'
    | 'deadline_exceeded'
    | 'budget_exhausted';
  transient: boolean;
};

class BatchAttemptError extends Error {
  constructor(readonly failure: AttemptFailure) {
    super(failure.code);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Runs a planned PR review as bounded, parallel, schema-validated model calls.
 *
 * Bounds (all server-side, none controllable by the client):
 * - at most `plan.batches.length` batches (planner already capped them), each with at most
 *   one retry, so at most 2 × maxBatches model calls;
 * - at most `concurrency` calls in flight;
 * - input/output tokens are reserved before every call (estimates), replaced by provider
 *   usage afterwards; a call (or retry) that would exceed the per-review ceilings is not made;
 * - a whole-review deadline and client cancellation abort in-flight calls.
 */
@Injectable()
export class PrReviewOrchestrator {
  private readonly logger = new Logger(PrReviewOrchestrator.name);
  /** Dependency caches keyed by the run input object: one per review, released with it. */
  private readonly dependencyCaches = new WeakMap<object, DependencyCache>();

  constructor(
    private readonly modelFactory: AiModelFactory,
    private readonly aiObservability: AiObservabilityService,
    private readonly providerHealth: ProviderHealthService,
  ) {}

  async run(input: {
    plan: PrReviewPlan;
    context: BatchPromptContext;
    memoryBlock?: string;
    limits: PrReviewLimits;
    abortSignal?: AbortSignal;
    /** Read-only file loader at the PR head (workspace-scoped); absent for the page fallback. */
    fileProvider?: FileContentProvider;
    /**
     * Separate loader (same repository, head SHA and credentials) for cross-file dependency
     * resolution during verification, with its own per-review file budget.
     */
    dependencyProvider?: FileContentProvider;
  }): Promise<PrReviewRunResult> {
    const limits = sanitizeLimits(input.limits);
    const { plan } = input;
    const batches = plan.batches;
    const deadline = AbortSignal.timeout(limits.reviewTimeoutMs);
    const signal = input.abortSignal ? AbortSignal.any([input.abortSignal, deadline]) : deadline;

    // Prompt text sent with every batch besides the diff (instructions, memory, file list).
    const overheadTokens = estimateTokens(
      buildBatchUserContent(
        input.context,
        { id: 'x', units: [], diffChars: 0 },
        0,
        input.memoryBlock,
      ).length + PR_REVIEW_BATCH_INSTRUCTIONS.length,
    );
    // Review-scoped dependency cache (separate budget from batch context).
    if (input.dependencyProvider) {
      this.dependencyCaches.set(input, new DependencyCache(input.dependencyProvider));
    }
    const outcomes = new Map<string, PRReviewBatchOutcome>();
    const outputs = new Map<string, BatchOutput>();
    const budget = {
      input: 0,
      output: 0,
      calls: 0,
      reserve(batch: PlannedBatch, extraChars = 0): boolean {
        const inTokens = estimateTokens(batch.diffChars + extraChars) + overheadTokens;
        if (
          this.input + inTokens > limits.maxInputTokens ||
          this.output + limits.maxOutputTokensPerBatch > limits.maxTotalOutputTokens
        ) {
          return false;
        }
        this.input += inTokens;
        this.output += limits.maxOutputTokensPerBatch;
        this.calls += 1;
        return true;
      },
      settle(batch: PlannedBatch, used: { input?: number; output?: number }, extraChars = 0) {
        // Replace the reservation with real usage when the provider reported it.
        if (used.input != null)
          this.input +=
            used.input - (estimateTokens(batch.diffChars + extraChars) + overheadTokens);
        if (used.output != null) this.output += used.output - limits.maxOutputTokensPerBatch;
      },
    };

    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const index = next;
        next += 1;
        const batch = batches[index]!;
        outcomes.set(
          batch.id,
          await this.runBatch(batch, index, input, limits, signal, budget, outputs),
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(limits.concurrency, batches.length) }, () => worker()),
    );

    const cancelled = input.abortSignal?.aborted === true;
    const orderedOutcomes = batches.map((b) => outcomes.get(b.id)!);

    // Validate findings of succeeded batches against their own diff, then merge.
    const validated: ValidatedFinding[] = [];
    const rejectedByReason: Partial<Record<RejectionReason, number>> = {};
    let linesCorrected = 0;
    let changeTypeCorrections = 0;
    let rangesNarrowed = 0;
    let rawCandidates = 0;
    for (const batch of batches) {
      const out = outputs.get(batch.id);
      if (!out || outcomes.get(batch.id)?.status !== 'succeeded') continue;
      rawCandidates += out.findings.length;
      const result = validateBatchFindings(out, batch, neutralizeDelimiters);
      validated.push(...result.findings);
      linesCorrected += result.linesCorrected;
      changeTypeCorrections += result.changeTypeCorrections;
      rangesNarrowed += result.rangesNarrowed;
      for (const [reason, n] of Object.entries(result.rejectedByReason)) {
        rejectedByReason[reason as RejectionReason] =
          (rejectedByReason[reason as RejectionReason] ?? 0) + n;
      }
    }
    const priorityByPath = new Map(plan.files.map((f) => [f.path, f.priority]));
    const merged = mergeFindings(
      validated,
      priorityByPath,
      batches.map((b) => b.id),
    );
    // Candidate-quality gates (test entry files, Project Memory echo) before verification.
    const gated = await this.applyCandidateGates(merged.findings, plan, input, signal);
    for (const [reason, n] of Object.entries(gated.rejectedByReason)) {
      rejectedByReason[reason as RejectionReason] =
        (rejectedByReason[reason as RejectionReason] ?? 0) + n;
    }
    const rejected = Object.values(rejectedByReason).reduce((a, b) => a + (b ?? 0), 0);
    this.logger.log({
      msg: 'pr_review.candidates',
      raw: rawCandidates,
      validated: validated.length,
      duplicates: merged.duplicates,
      rejected,
      rejectedByReason,
      afterFiltering: gated.findings.length,
      toVerification: gated.findings.filter(
        (f) => f.verification.status === 'pending' && !isOptionalCheck(f),
      ).length,
      lowChecks: gated.findings.filter(isOptionalCheck).length,
      changeTypeCorrections,
      rangesNarrowed,
      linesCorrected,
      memoryEcho: gated.memoryEcho,
      testReachabilityUnknown: gated.testReachabilityUnknown,
    });

    // Independent verification: MEDIUM/HIGH first, then LOW checks with spare capacity
    // (bounded, same deadline/cancel).
    const verified = await this.verifyCandidates(
      gated.findings,
      plan,
      input,
      limits,
      signal,
      priorityByPath,
    );
    // Cross-file grouping only after verification, among identical outcomes.
    const grouped = groupSameRootCause(verified.findings, priorityByPath);
    const findings = grouped.findings;
    const count = (d: ValidatedFinding['disposition']) =>
      findings.filter((f) => f.disposition === d).length;

    return {
      outcomes: orderedOutcomes,
      findings,
      findingStats: {
        accepted: count('reported'),
        duplicates: merged.duplicates,
        rejected,
        rejectedByReason: rejectedByReason as Record<string, number>,
        linesCorrected,
        changeTypeCorrections,
        rangesNarrowed,
        memoryEcho: gated.memoryEcho,
        needsInvestigation: count('needs_investigation'),
        dismissed: count('dismissed'),
        crossFileMerged: grouped.crossFileMerged,
        severityAdjusted: findings.filter((f) => f.severity !== f.requestedSeverity).length,
        verification: verified.stats,
      },
      cancelled: input.abortSignal?.aborted === true || cancelled,
      tokens: {
        input: budget.input + verified.tokens.input,
        output: budget.output + verified.tokens.output,
        calls: budget.calls + verified.tokens.calls,
      },
      verificationTokens: verified.tokens,
    };
  }

  /**
   * Candidate-quality gates between validation and verification (deterministic, recorded):
   * - runtime claims whose evidence is only in a test entry file (runs tests, exports
   *   nothing) are rejected; test-looking code that may be imported, or that cannot be read,
   *   stays a candidate (flagged, verified as usual);
   * - claims that repeat an applied Project Memory rule in wording the changed code lacks are
   *   flagged `memory_echo` (never rejected); a flagged LOW cannot skip verification.
   */
  private async applyCandidateGates(
    findings: ValidatedFinding[],
    plan: PrReviewPlan,
    input: Parameters<PrReviewOrchestrator['run']>[0],
    signal: AbortSignal,
  ): Promise<{
    findings: ValidatedFinding[];
    rejectedByReason: Partial<Record<RejectionReason, number>>;
    memoryEcho: number;
    testReachabilityUnknown: number;
  }> {
    const rules = memoryRulesFromBlock(input.memoryBlock);
    const linesByPath = new Map<string, DiffLine[]>();
    const codeByBatch = new Map<string, string>();
    for (const batch of plan.batches) {
      const text: string[] = [];
      for (const unit of batch.units) {
        const list = linesByPath.get(unit.path) ?? [];
        list.push(...unit.chunk.lines);
        linesByPath.set(unit.path, list);
        text.push(...unit.chunk.lines.filter((l) => l.kind !== '-').map((l) => l.text));
      }
      codeByBatch.set(batch.id, text.join('\n'));
    }
    const rejectedByReason: Partial<Record<RejectionReason, number>> = {};
    let memoryEcho = 0;
    let testReachabilityUnknown = 0;
    const kept: ValidatedFinding[] = [];
    for (const f of findings) {
      let finding = f;
      // Gate C first, so an echo is recorded even when Gate B rejects the candidate.
      const claim = [
        f.title,
        f.explanation,
        f.trigger,
        f.failurePath,
        f.violatedInvariant,
        f.impact,
      ].join('\n');
      const echo = detectMemoryEcho(claim, rules, codeByBatch.get(f.batchId) ?? '');
      if (echo) {
        memoryEcho += 1;
        finding = { ...finding, gateNotes: [...finding.gateNotes, 'memory_echo'] };
      }
      if (RUNTIME_CATEGORIES.has(f.category)) {
        const lines = linesByPath.get(f.path) ?? [];
        const frameworkImport = lines.some((l) =>
          /\bfrom\s+['"](?:vitest|jest|@jest\/globals|mocha|node:test|bun:test|@playwright\/test)['"]/.test(
            l.text,
          ),
        );
        if (looksLikeTestPath(f.path) || frameworkImport) {
          let text = fullTextOfAddedFile(lines);
          if (text == null && input.fileProvider && !signal.aborted) {
            text = await input.fileProvider(f.path, signal).catch(() => null);
          }
          // Unreadable or importable (exports) test code: reachability unknown → kept.
          const status = text != null ? classifyTestCode(f.path, text) : 'test_support';
          if (status === 'test_entry') {
            rejectedByReason.runtime_claim_on_test_code =
              (rejectedByReason.runtime_claim_on_test_code ?? 0) + 1;
            continue;
          }
          if (status === 'test_support') {
            testReachabilityUnknown += 1;
            finding = {
              ...finding,
              gateNotes: [...finding.gateNotes, 'test_reachability_unknown'],
            };
          }
        }
      }
      // A flagged LOW may not skip verification: check it with spare capacity, and label it
      // UNVERIFIED if it cannot be confirmed.
      if (echo && finding.verification.status === 'not_required') {
        finding = { ...finding, verification: { status: 'pending' } };
      }
      kept.push(finding);
    }
    return { findings: kept, rejectedByReason, memoryEcho, testReachabilityUnknown };
  }

  /**
   * Verify MEDIUM/HIGH candidates, highest severity and file priority first, up to
   * `maxVerifications` calls (no retries, so verification cost is strictly bounded). Every
   * candidate ends confirmed (reported), refuted (dismissed, counted) or unresolved (Needs
   * Investigation) — nothing is dropped silently.
   */
  private async verifyCandidates(
    findings: ValidatedFinding[],
    plan: PrReviewPlan,
    input: Parameters<PrReviewOrchestrator['run']>[0],
    limits: PrReviewLimits,
    signal: AbortSignal,
    priorityByPath: Map<string, number>,
  ): Promise<{
    findings: ValidatedFinding[];
    stats: NonNullable<PRReviewCoverage['findings']['verification']>;
    tokens: { input: number; output: number; calls: number };
  }> {
    const tokens = { input: 0, output: 0, calls: 0 };
    const stats = {
      attempted: 0,
      confirmed: 0,
      refuted: 0,
      insufficientContext: 0,
      unavailable: 0,
      withDiffWindow: 0,
      withHeadContext: 0,
      withHelpers: 0,
      unprovenConfirmations: 0,
      withDependencies: 0,
      unresolvedDependencies: 0,
      dependencyFiles: 0,
      lowChecks: 0,
      lowConfirmed: 0,
      lowDismissed: 0,
      lowUnverified: 0,
    };
    const pending = verificationOrder(
      findings.filter((f) => f.verification.status === 'pending'),
      priorityByPath,
    );
    const selected = new Set(pending.slice(0, limits.maxVerifications).map((f) => f.stableId));

    const chunksByPath = new Map<
      string,
      { text: string; lines: PlannedBatch['units'][number]['chunk']['lines'] }[]
    >();
    for (const batch of plan.batches) {
      for (const unit of batch.units) {
        const list = chunksByPath.get(unit.path) ?? [];
        list.push({ text: unit.chunk.text, lines: unit.chunk.lines });
        chunksByPath.set(unit.path, list);
      }
    }
    const diffLinesByPath = new Map(
      [...chunksByPath].map(([path, chunks]) => [path, chunks.flatMap((c) => c.lines)]),
    );

    const results = new Map<string, ValidatedFinding>();
    const queue = pending.filter((f) => selected.has(f.stableId));
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const finding = queue[next]!;
        next += 1;
        results.set(
          finding.stableId,
          await this.verifyOne(finding, diffLinesByPath, input, limits, signal, tokens, stats),
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(limits.concurrency, queue.length) }, () => worker()),
    );

    const out = findings.map((f) => {
      if (f.verification.status !== 'pending') return f;
      const optional = isOptionalCheck(f);
      const done = results.get(f.stableId);
      const final =
        done ??
        applyVerification(f, {
          verdict: 'unavailable',
          reason: optional
            ? 'Not verified: verification capacity was used by higher-severity candidates.'
            : 'Not verified: per-review verification limit reached.',
        });
      if (!done && !optional) stats.unavailable += 1;
      if (!done) {
        // Every candidate leaves a per-finding record, including the ones over the cap.
        this.logger.log({
          msg: 'pr_review.verification',
          path: final.path,
          line: final.lineStart,
          category: final.category,
          claimedSeverity: final.severity,
          verificationStatus: final.verification.status,
          outcome: 'not_verified',
          decision: optional ? 'over_cap_optional' : 'over_cap',
        });
      }
      if (optional) {
        stats.lowChecks += 1;
        if (final.verification.status === 'confirmed') stats.lowConfirmed += 1;
        else if (final.verification.status === 'refuted') stats.lowDismissed += 1;
        else stats.lowUnverified += 1;
      }
      return final;
    });
    const cache = this.dependencyCaches.get(input);
    stats.dependencyFiles = cache?.sourceFiles ?? 0;
    if (cache) {
      this.logger.log({
        msg: 'pr_review.dependencies',
        sourceFiles: cache.sourceFiles,
        sourceFileBudget: cache.maxFiles,
        configReads: cache.configReads,
        configReadCap: cache.caps.config,
        missingProbes: cache.probes,
        missingProbeCap: cache.caps.probes,
        requests: cache.requests,
        requestCap: cache.caps.requests,
        cacheHits: cache.hits,
        readsRefused: cache.refused,
        verificationsWithDependencies: stats.withDependencies,
        unresolvedDependencies: stats.unresolvedDependencies,
      });
    }
    return { findings: out, stats, tokens };
  }

  /** One verification, logged once (`pr_review.verification`) whatever the outcome. */
  private async verifyOne(
    finding: ValidatedFinding,
    diffLinesByPath: Map<string, PlannedBatch['units'][number]['chunk']['lines']>,
    input: Parameters<PrReviewOrchestrator['run']>[0],
    limits: PrReviewLimits,
    signal: AbortSignal,
    tokens: { input: number; output: number; calls: number },
    stats: Required<NonNullable<PRReviewCoverage['findings']['verification']>>,
  ): Promise<ValidatedFinding> {
    const trace: VerifyTrace = { startedAt: Date.now(), lowCheck: isOptionalCheck(finding) };
    const result = await this.verifyOneInner(
      finding,
      diffLinesByPath,
      input,
      limits,
      signal,
      tokens,
      stats,
      trace,
    );
    this.logVerification(result, trace);
    return result;
  }

  private async verifyOneInner(
    finding: ValidatedFinding,
    diffLinesByPath: Map<string, PlannedBatch['units'][number]['chunk']['lines']>,
    input: Parameters<PrReviewOrchestrator['run']>[0],
    limits: PrReviewLimits,
    signal: AbortSignal,
    tokens: { input: number; output: number; calls: number },
    stats: Required<NonNullable<PRReviewCoverage['findings']['verification']>>,
    trace: VerifyTrace,
  ): Promise<ValidatedFinding> {
    const unavailable = (reason: string) => {
      stats.unavailable += 1;
      return applyVerification(finding, { verdict: 'unavailable', reason });
    };
    if (signal.aborted) {
      return unavailable(
        input.abortSignal?.aborted
          ? 'Not verified: review cancelled.'
          : 'Not verified: review deadline reached.',
      );
    }

    const maxChars = Math.max(
      2_000,
      limits.verifyInputTokens * 3 -
        PR_REVIEW_VERIFY_INSTRUCTIONS.length -
        VERIFY_REQUEST_OVERHEAD_CHARS,
    );
    // Finding-centred context: diff window, head window + enclosing function, guards and
    // callees (same file or other changed files). Trimmed around the finding, never dropped.
    const diffLines = diffLinesByPath.get(finding.path) ?? [];
    // Centre on the same copy validation anchored to (a moved line has two copies).
    const matched = selectEvidenceMatch(
      matchEvidenceAll(
        diffLines.map((l) => ({ ...l, text: neutralizeDelimiters(l.text) })),
        finding.evidence,
      ),
      finding.changeType,
      finding.lineStart,
    ).match;
    const evidenceIndex = matched
      ? diffLines.findIndex(
          (l) => l.newLine === matched[0]!.line.newLine && l.oldLine === matched[0]!.line.oldLine,
        )
      : null;
    // Code budget for this verification (unchanged ceiling): with cross-file resolution the
    // finding window gets at most 50% and dependencies get everything the window left unused;
    // without it the window keeps it all.
    // Room for the claim and framing is measured, not a fixed reserve: the window stays capped
    // at 50% with dependencies, so even with every dependency dropped (and listed as not
    // shown) the request stays under the ceiling; the hard-ceiling loop below enforces it.
    const shellChars = buildVerificationContent({ finding, sections: [] }).content.length;
    const codeBudget = Math.max(2_000, maxChars - shellChars - 200);
    const depCache = this.dependencyCaches.get(input);
    const windowBudget = depCache ? Math.floor(codeBudget * 0.5) : codeBudget;
    let context: Awaited<ReturnType<typeof buildVerificationContext>> = {
      sections: [],
      stats: { diffWindow: false, headContext: false, helpers: 0 },
      headText: null,
    };
    try {
      context = await buildVerificationContext({
        path: finding.path,
        diffLinesByPath,
        lineStart: finding.lineStart,
        lineEnd: finding.lineEnd,
        headLine: finding.headLine,
        evidenceIndex,
        ...(input.fileProvider ? { provider: input.fileProvider } : {}),
        maxChars: windowBudget,
        // The import-aware resolver replaces the name-based helper lookup when available.
        ...(depCache ? { maxHelpers: 0 } : {}),
        signal,
      });
    } catch {
      // Context is best effort; the verdict rules below still apply.
    }
    // Direct callers for return-value / fallback / error-propagation claims (changed files,
    // existing authorized provider, own slice of the dependency budget, trimmed last).
    const focusLine = finding.headLine ?? finding.lineStart;
    const claimText = [finding.title, finding.explanation, finding.trigger, finding.failurePath]
      .filter(Boolean)
      .join('\n');
    const windowUsed = context.sections.reduce((n, sec) => n + renderSection(sec).length + 2, 0);
    let callers: CodeSection[] = [];
    const notes: string[] = [];
    trace.callers = 'not_applicable';
    if (needsCallers(finding.evidence, claimText) && !signal.aborted) {
      const ranks =
        context.headText != null && focusLine != null
          ? executionPathRanks(finding.path, context.headText, focusLine)
          : null;
      try {
        const found = await findCallers({
          name: ranks?.functionName ?? null,
          definitionPath: finding.path,
          definitionRange: ranks?.functionRange ?? null,
          diffLinesByPath,
          ...(input.fileProvider ? { provider: input.fileProvider } : {}),
          signal,
          maxChars: Math.min(1_800, Math.floor(Math.max(0, codeBudget - windowUsed) * 0.4)),
        });
        callers = found.sections;
        trace.callers = found.status;
        if (found.status === 'none_in_changed_files') {
          notes.push(
            `## Callers\nNo call of ${ranks!.functionName}() was found in this PR's changed files; other callers are not shown, so how its result is used is unknown.`,
          );
        } else if (found.status === 'unavailable') {
          notes.push(
            '## Callers\nThe callers of the code at the finding could not be identified; how its result is used is unknown.',
          );
        }
      } catch {
        trace.callers = 'unavailable';
      }
    }
    trace.callersIncluded = callers.length;
    const callersUsed = callers.reduce((n, sec) => n + renderSection(sec).length + 2, 0);
    let dependencies: DependencyResult = { sections: [], resolved: [], unresolved: [] };
    if (depCache && !signal.aborted) {
      try {
        dependencies = await resolveDependencies({
          originPath: finding.path,
          originText: context.headText,
          // Executable window lines only: deleted code is never followed.
          windowLines: context.sections
            .filter((sec) => sec.path === finding.path)
            .flatMap((sec) => sec.lines)
            .filter((l) => l.tag !== 'DEL')
            .map((l) => ({ n: l.n, text: l.text })),
          focusLine: finding.headLine ?? finding.lineStart,
          cache: depCache,
          maxChars: Math.max(0, codeBudget - windowUsed - callersUsed),
          signal,
          // Authorization chains of security findings may go one level deeper (depth 3).
          securityFinding: SECURITY_CATEGORIES.has(finding.category),
          claimText,
        });
      } catch {
        dependencies = { sections: [], resolved: [], unresolved: [] };
      }
    }
    if (context.stats.diffWindow) stats.withDiffWindow += 1;
    if (context.stats.headContext) stats.withHeadContext += 1;
    if (context.stats.helpers > 0 || dependencies.resolved.length > 0) stats.withHelpers += 1;
    if (dependencies.resolved.length > 0) stats.withDependencies += 1;
    trace.contextMs = Date.now() - trace.startedAt;
    let dropped = 0;
    // Full head text of the finding's file: structural checks only, never sent or logged.
    const fileTexts = new Map<string, string>(
      context.headText != null ? [[finding.path, context.headText]] : [],
    );
    let { content, provided } = buildVerificationContent({
      finding,
      sections: context.sections,
      dependencies,
      fileTexts,
      callers,
      notes,
    });
    // Hard ceiling: if the prompt would exceed the verification input limit, drop the
    // lowest-priority dependencies (resolved last) and report them as not shown.
    while (
      (dependencies.resolved.length > 0 || callers.length > 0) &&
      estimateTokens(requestChars(content)) > limits.verifyInputTokens
    ) {
      if (dependencies.resolved.length === 0) {
        callers = callers.slice(0, -1);
        trace.callersTrimmed = (trace.callersTrimmed ?? 0) + 1;
        ({ content, provided } = buildVerificationContent({
          finding,
          sections: context.sections,
          dependencies,
          fileTexts,
          callers,
          notes,
        }));
        continue;
      }
      dropped += 1;
      // Least path-relevant first, then deepest, then the latest resolved.
      let worst = dependencies.resolved.length - 1;
      dependencies.resolved.forEach((d, i) => {
        const w = dependencies.resolved[worst]!;
        if (d.pathRank > w.pathRank || (d.pathRank === w.pathRank && d.depth > w.depth)) {
          worst = i;
        }
      });
      const last = dependencies.resolved[worst]!;
      if (last.pathRank <= 1) trace.relevantTrimmed = (trace.relevantTrimmed ?? 0) + 1;
      dependencies = {
        resolved: dependencies.resolved.filter((_, i) => i !== worst),
        sections: dependencies.sections.filter((sec) => sec !== last.section),
        unresolved: [
          ...dependencies.unresolved,
          {
            name: last.name,
            reason: 'context_budget',
            calledFrom: `${last.callSite.path}:${last.callSite.line}`,
            depth: last.depth,
            securityRelevant: true,
            edge: last.edge,
            pathRank: last.pathRank,
            rootCallSite: last.rootCallSite,
            chain: last.chain.slice(0, -1),
          },
        ],
      };
      ({ content, provided } = buildVerificationContent({
        finding,
        sections: context.sections,
        dependencies,
        fileTexts,
        callers,
        notes,
      }));
    }
    stats.unresolvedDependencies += dependencies.unresolved.length;
    trace.droppedForCeiling = dropped;
    trace.dependencies = summarizeDependencies(dependencies);
    trace.promptTokensEstimate = estimateTokens(requestChars(content));
    // Cancelled or past the deadline while gathering context: never start the model call.
    if (signal.aborted) {
      return unavailable(
        input.abortSignal?.aborted
          ? 'Not verified: review cancelled.'
          : 'Not verified: review deadline reached.',
      );
    }

    stats.attempted += 1;
    tokens.calls += 1;
    tokens.input += estimateTokens(requestChars(content));
    tokens.output += limits.verifyOutputTokens;
    const reservedIn = estimateTokens(requestChars(content));
    try {
      const { result, observation } = await this.aiObservability.observeGenerate({
        provider: this.modelFactory.getProviderName(),
        model: this.modelFactory.getModelName(),
        capability: 'REVIEW_ENTIRE_PR_VERIFY',
        call: async () => {
          const response = await generateText({
            model: this.modelFactory.getDefaultModel(),
            instructions: PR_REVIEW_VERIFY_INSTRUCTIONS,
            messages: [{ role: 'user', content }],
            maxOutputTokens: limits.verifyOutputTokens,
            timeout: limits.batchTimeoutMs,
            abortSignal: signal,
            maxRetries: 0,
            output: verificationOutput(),
          });
          if (response.finishReason === 'length') {
            throw new BatchAttemptError({ code: 'output_limit', transient: false });
          }
          const parsed = verificationSchema.safeParse(response.output);
          if (!parsed.success) {
            throw new BatchAttemptError({ code: 'invalid_output', transient: false });
          }
          return {
            result: parsed.data,
            usageRaw: {
              inputTokens: response.usage?.inputTokens,
              outputTokens: response.usage?.outputTokens,
              totalTokens: response.usage?.totalTokens,
            },
          };
        },
      });
      trace.modelMs = observation.durationMs;
      trace.inputTokens = observation.usage.inputTokens;
      trace.outputTokens = observation.usage.outputTokens;
      trace.estimatedCostUsd = observation.cost.totalCostUsd;
      if (observation.usage.inputTokens != null)
        tokens.input += observation.usage.inputTokens - reservedIn;
      if (observation.usage.outputTokens != null) {
        tokens.output += observation.usage.outputTokens - limits.verifyOutputTokens;
      }

      const assessed = assessVerdict(result, finding, provided);
      trace.audit = assessed.audit;
      trace.dependsOnCodeNotShown = result.dependsOnCodeNotShown;
      trace.verifierVerdict = result.verdict;
      if (assessed.verdict === 'confirmed') {
        stats.confirmed += 1;
        return applyVerification(finding, assessed);
      }
      if (assessed.verdict === 'refuted') {
        stats.refuted += 1;
        return applyVerification(finding, assessed);
      }
      stats.insufficientContext += 1;
      if (assessed.unprovenConfirmation) stats.unprovenConfirmations += 1;
      trace.unprovenConfirmation = assessed.unprovenConfirmation;
      return applyVerification(finding, {
        verdict: 'insufficient_context',
        reason: assessed.reason,
      });
    } catch (error) {
      const code =
        error instanceof BatchAttemptError
          ? error.failure.code
          : signal.aborted
            ? this.abortFailure(input.abortSignal).code
            : this.classify(error).code;
      trace.errorCode = code;
      return unavailable(`Not verified: verification call failed (${code}).`);
    }
  }

  private async runBatch(
    batch: PlannedBatch,
    index: number,
    input: Parameters<PrReviewOrchestrator['run']>[0],
    limits: PrReviewLimits,
    signal: AbortSignal,
    budget: {
      reserve: (b: PlannedBatch, extraChars?: number) => boolean;
      settle: (
        b: PlannedBatch,
        used: { input?: number; output?: number },
        extraChars?: number,
      ) => void;
    },
    outputs: Map<string, BatchOutput>,
  ): Promise<PRReviewBatchOutcome> {
    const files = new Set(batch.units.map((u) => u.path)).size;
    const startedAt = Date.now();
    let attempts = 0;
    let lastFailure: AttemptFailure = { code: 'provider_error', transient: false };
    const contextText = await this.batchContext(batch, input, signal);

    while (attempts < MAX_ATTEMPTS) {
      if (signal.aborted) {
        lastFailure = this.abortFailure(input.abortSignal);
        break;
      }
      if (!budget.reserve(batch, contextText.length)) {
        lastFailure = { code: 'budget_exhausted', transient: false };
        break;
      }
      attempts += 1;
      try {
        const { output, usage } = await this.callModel(
          batch,
          index,
          input,
          limits,
          signal,
          contextText,
        );
        budget.settle(batch, usage, contextText.length);
        outputs.set(batch.id, output);
        this.providerHealth.recordSignal('ai', true);
        this.logBatch(batch, 'succeeded', attempts, files, startedAt);
        return { id: batch.id, status: 'succeeded', attempts, files };
      } catch (error) {
        lastFailure =
          error instanceof BatchAttemptError
            ? error.failure
            : signal.aborted
              ? this.abortFailure(input.abortSignal)
              : this.classify(error);
        if (lastFailure.code !== 'cancelled' && lastFailure.code !== 'deadline_exceeded') {
          this.providerHealth.recordSignal('ai', false);
        }
        if (!lastFailure.transient || attempts >= MAX_ATTEMPTS) break;
        await delay(RETRY_DELAY_MS, signal);
      }
    }

    const status = lastFailure.code === 'cancelled' ? 'cancelled' : 'failed';
    this.logBatch(batch, status, attempts, files, startedAt, lastFailure.code);
    return { id: batch.id, status, attempts, files, errorCode: lastFailure.code };
  }

  private async callModel(
    batch: PlannedBatch,
    index: number,
    input: Parameters<PrReviewOrchestrator['run']>[0],
    limits: PrReviewLimits,
    signal: AbortSignal,
    contextText: string,
  ): Promise<{ output: BatchOutput; usage: { input?: number; output?: number } }> {
    const content = buildBatchUserContent(
      input.context,
      batch,
      index,
      input.memoryBlock,
      contextText,
    );
    const { result, observation } = await this.aiObservability.observeGenerate({
      provider: this.modelFactory.getProviderName(),
      model: this.modelFactory.getModelName(),
      capability: 'REVIEW_ENTIRE_PR',
      call: async () => {
        const response = await generateText({
          model: this.modelFactory.getDefaultModel(),
          instructions: PR_REVIEW_BATCH_INSTRUCTIONS,
          messages: [{ role: 'user', content }],
          maxOutputTokens: limits.maxOutputTokensPerBatch,
          timeout: limits.batchTimeoutMs,
          abortSignal: signal,
          maxRetries: 0, // retries are ours: once, transient only, within budget
          output: batchOutput(),
        });
        if (response.finishReason === 'length') {
          throw new BatchAttemptError({ code: 'output_limit', transient: false });
        }
        const parsed = batchOutputSchema.safeParse(response.output);
        if (!parsed.success) {
          throw new BatchAttemptError({ code: 'invalid_output', transient: true });
        }
        return {
          result: parsed.data,
          usageRaw: {
            inputTokens: response.usage?.inputTokens,
            outputTokens: response.usage?.outputTokens,
            totalTokens: response.usage?.totalTokens,
            cachedInputTokens: response.usage?.inputTokenDetails?.cacheReadTokens,
          },
        };
      },
    });
    return {
      output: result,
      usage: {
        ...(observation.usage.inputTokens != null ? { input: observation.usage.inputTokens } : {}),
        ...(observation.usage.outputTokens != null
          ? { output: observation.usage.outputTokens }
          : {}),
      },
    };
  }

  /**
   * Read-only context for a batch, using only the room its diffs left unused (coverage is
   * never traded for context). Modified files only — an added file's diff is the whole file.
   */
  private async batchContext(
    batch: PlannedBatch,
    input: Parameters<PrReviewOrchestrator['run']>[0],
    signal: AbortSignal,
  ): Promise<string> {
    const provider = input.fileProvider;
    const spare = input.plan.batchDiffBudgetChars - batch.diffChars;
    if (!provider || spare < MIN_BATCH_CONTEXT_CHARS || signal.aborted) return '';
    const paths = [...new Set(batch.units.map((u) => u.path))]
      .filter((path) =>
        batch.units.some((u) => u.path === path && u.chunk.lines.some((l) => l.kind !== '+')),
      )
      .slice(0, MAX_CONTEXT_FILES_PER_BATCH);
    if (paths.length === 0) return '';
    const share = Math.floor(spare / paths.length);
    try {
      const perFile = await Promise.all(
        paths.map((path) =>
          buildContextBlocks({
            path,
            changedLines: batch.units.filter((u) => u.path === path).flatMap((u) => u.chunk.lines),
            provider,
            helperPaths: paths,
            maxChars: share,
          }),
        ),
      );
      const text = renderContextBlocks(perFile.flat());
      return text.length <= spare ? text : '';
    } catch {
      return '';
    }
  }

  private abortFailure(clientSignal?: AbortSignal): AttemptFailure {
    return clientSignal?.aborted
      ? { code: 'cancelled', transient: false }
      : { code: 'deadline_exceeded', transient: false };
  }

  private classify(error: unknown): AttemptFailure {
    if (NoObjectGeneratedError.isInstance(error)) {
      return error.finishReason === 'length'
        ? { code: 'output_limit', transient: false }
        : { code: 'invalid_output', transient: true };
    }
    if (APICallError.isInstance(error)) {
      if (error.statusCode === 429) return { code: 'rate_limited', transient: true };
      return { code: 'provider_error', transient: error.isRetryable };
    }
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError')
      return { code: 'timeout', transient: true };
    if (error instanceof TypeError) return { code: 'provider_error', transient: true }; // network
    return { code: 'provider_error', transient: false };
  }

  /** Metadata only: never source text, verifier reasoning or credentials. */
  private logVerification(result: ValidatedFinding, trace: VerifyTrace): void {
    const status = result.verification.status;
    this.logger.log({
      msg: 'pr_review.verification',
      path: result.path,
      // Same line the report shows; evidenceLine is where the quoted evidence matched.
      line: result.lineStart,
      evidenceLine: result.headLine,
      ...(result.claimedLines
        ? { lineMismatch: { claimed: result.claimedLines.start, anchored: result.lineStart } }
        : {}),
      category: result.category,
      claimedSeverity: result.severity,
      ...(trace.lowCheck ? { lowCheck: true } : {}),
      verificationStatus: result.verification.status,
      ...(result.gateNotes.includes('memory_echo') ? { memoryEcho: true } : {}),
      ...(result.gateNotes.includes('change_type_corrected') ? { changeTypeCorrected: true } : {}),
      ...(result.gateNotes.includes('line_range_narrowed') ? { lineRangeNarrowed: true } : {}),
      outcome:
        status === 'confirmed'
          ? 'confirmed'
          : status === 'refuted'
            ? 'dismissed'
            : status === 'insufficient_context'
              ? 'needs_investigation'
              : 'not_verified',
      ...(trace.verifierVerdict ? { verifierVerdict: trace.verifierVerdict } : {}),
      ...(trace.audit ? { decision: trace.audit.rule } : {}),
      ...(trace.audit?.siteLine != null ? { failureSiteLine: trace.audit.siteLine } : {}),
      ...(trace.audit?.siteKind ? { failureSiteKind: trace.audit.siteKind } : {}),
      ...(trace.audit?.guardCoverage ? { guardCoverage: trace.audit.guardCoverage } : {}),
      ...(trace.audit?.guardsFound != null ? { guardsFound: trace.audit.guardsFound } : {}),
      ...(trace.audit?.guardRelation ? { guardRelation: trace.audit.guardRelation } : {}),
      ...(trace.audit?.quoteLines?.length ? { quoteLines: trace.audit.quoteLines } : {}),
      ...(result.gateNotes.includes('defensive_evidence') ? { defensiveEvidence: true } : {}),
      ...(trace.callers ? { callers: trace.callers } : {}),
      ...(trace.callersIncluded ? { callersIncluded: trace.callersIncluded } : {}),
      ...(trace.callersTrimmed ? { callersTrimmed: trace.callersTrimmed } : {}),
      ...(trace.relevantTrimmed ? { relevantTrimmed: trace.relevantTrimmed } : {}),
      ...(trace.dependsOnCodeNotShown != null
        ? { dependsOnCodeNotShown: trace.dependsOnCodeNotShown }
        : {}),
      ...(trace.unprovenConfirmation ? { unprovenConfirmation: true } : {}),
      ...(trace.errorCode ? { errorCode: trace.errorCode } : {}),
      durationMs: Date.now() - trace.startedAt,
      ...(trace.contextMs != null ? { contextMs: trace.contextMs } : {}),
      ...(trace.modelMs != null ? { modelMs: trace.modelMs } : {}),
      ...(trace.promptTokensEstimate != null
        ? { promptTokensEstimate: trace.promptTokensEstimate }
        : {}),
      ...(trace.inputTokens != null ? { inputTokens: trace.inputTokens } : {}),
      ...(trace.outputTokens != null ? { outputTokens: trace.outputTokens } : {}),
      ...(trace.estimatedCostUsd != null ? { estimatedCostUsd: trace.estimatedCostUsd } : {}),
      ...(trace.dependencies ? { dependencies: trace.dependencies } : {}),
      ...(trace.droppedForCeiling ? { droppedForCeiling: trace.droppedForCeiling } : {}),
    });
  }

  private logBatch(
    batch: PlannedBatch,
    status: PRReviewBatchOutcome['status'],
    attempts: number,
    files: number,
    startedAt: number,
    errorCode?: string,
  ): void {
    const entry = {
      msg: 'pr_review.batch',
      batchId: batch.id,
      status,
      attempts,
      files,
      diffChars: batch.diffChars,
      durationMs: Date.now() - startedAt,
      ...(errorCode ? { errorCode } : {}),
    };
    if (status === 'succeeded') this.logger.log(entry);
    else this.logger.warn(entry);
  }
}
