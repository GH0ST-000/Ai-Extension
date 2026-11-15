/**
 * Review-quality benchmark harness (Phase 1): replays recorded model responses through the
 * REAL review pipeline (AiService → planner → batches → validation → quality gates →
 * dependency resolution → verification → report) and traces every candidate and every
 * ground-truth bug through each stage. No network, no paid calls.
 *
 * Replay measures the deterministic pipeline given these responses. It is not evidence of
 * live model recall: with `provenance: "scripted"` responses, generation quality is assumed.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { AIAction } from '@project-x/types';
import { vi, type Mock } from 'vitest';

import { AiService } from '../../src/ai/ai.service';
import { PromptRegistry } from '../../src/ai/prompts/prompt.registry';
import { chunkPatch, locateEvidence, parsePatch } from '../../src/ai/pr-review/diff-hunks';
import { neutralizeDelimiters } from '../../src/ai/pr-review/pr-review-batch.prompt';
import {
  validateBatchFindings,
  type BatchFindingInput,
} from '../../src/ai/pr-review/pr-review-findings';
import { makeFile, usageStub } from '../../src/ai/pr-review/pr-review-fixtures';
import { PrReviewOrchestrator } from '../../src/ai/pr-review/pr-review-orchestrator.service';
import type { PlannedBatch } from '../../src/ai/pr-review/pr-review-plan';
import {
  PR_REVIEW_VERIFY_INSTRUCTIONS,
  type VerificationOutput,
} from '../../src/ai/pr-review/pr-review-verify';

export const BENCH_DIR = __dirname;
const CORPUS = join(BENCH_DIR, 'corpus');
const FIXTURES = join(BENCH_DIR, '..', 'fixtures');

// ── corpus ─────────────────────────────────────────────────────────────────

export type GroundTruth = {
  id: string;
  path: string;
  /** Head (new-file) lines of the defect. */
  lines: [number, number];
  /** Base (old-file) lines of removed code that is part of the defect (e.g. a removed lock). */
  removedLines?: [number, number];
  category: string;
  severity: 'high' | 'medium' | 'low';
  security: boolean;
  changeType: string;
  description: string;
  witness: string;
};

export type CaseFile = { path: string; physical: string | null; changed: boolean; status: string };

export type ResponseRun = {
  id: string;
  batch: { summary: string; findings: BatchFindingInput[] };
  verify: Record<string, VerificationOutput>;
};

export type BenchCase = {
  id: string;
  title: string;
  /** Selection groups: security, data, correctness, clean, regression. */
  groups: string[];
  clean: boolean;
  securityRegression: boolean;
  files: CaseFile[];
  groundTruth: GroundTruth[];
  groundTruthSource: string;
  projectMemory?: string;
  fixtures?: string;
  responses: {
    provenance: 'scripted' | 'captured';
    note: string;
    model: string | null;
    capturedAt: string | null;
    runs: ResponseRun[];
  };
};

export function loadCorpus(): BenchCase[] {
  return readdirSync(CORPUS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((id) => {
      const dir = join(CORPUS, id);
      const meta = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')) as Omit<
        BenchCase,
        'responses'
      >;
      const responses = JSON.parse(
        readFileSync(join(dir, 'responses.json'), 'utf8'),
      ) as BenchCase['responses'];
      return { ...meta, responses };
    });
}

/** Diff hunks (`@@ …` onward) and head text of every file of a case, by repository path. */
export function caseSources(c: BenchCase): {
  changed: { path: string; hunks: string }[];
  head(path: string): string | null;
} {
  if (c.fixtures) {
    const dir = join(FIXTURES, c.fixtures);
    const read = (p: string, ext: string) => {
      const file = join(dir, `${p.replace(/\//g, '_')}.${ext}`);
      return existsSync(file) ? readFileSync(file, 'utf8') : null;
    };
    return {
      changed: c.files.map((f) => {
        const patch = read(f.path, 'patch') ?? '';
        return { path: f.path, hunks: patch.slice(patch.indexOf('\n@@') + 1) };
      }),
      head: (p) => read(p, 'head'),
    };
  }
  const dir = join(CORPUS, c.id);
  const patch = readFileSync(join(dir, 'diff.patch'), 'utf8');
  const byPath = new Map<string, string>();
  for (const part of patch.split(/^diff --git /m).filter(Boolean)) {
    const path = /^\+\+\+ b\/(.+)$/m.exec(part)?.[1];
    if (path) byPath.set(path, part.slice(part.indexOf('\n@@') + 1));
  }
  const physical = new Map(c.files.map((f) => [f.path, f.physical ?? f.path.split('/').pop()!]));
  return {
    changed: c.files
      .filter((f) => f.changed)
      .map((f) => ({ path: f.path, hunks: byPath.get(f.path) ?? '' })),
    head: (p) => {
      const name = physical.get(p);
      const file = name ? join(dir, 'head', name) : null;
      return file && existsSync(file) ? readFileSync(file, 'utf8') : null;
    },
  };
}

// ── pipeline (real services, recorded responses) ──────────────────────────

const INPUT = {
  action: AIAction.REVIEW_ENTIRE_PR,
  text: 'Review this PR.',
  context: {
    type: 'github',
    url: 'https://github.com/benchmark/phase1/pull/1',
    title: 'Benchmark PR',
    github: { owner: 'benchmark', repository: 'phase1', pullRequestNumber: 1 },
  },
} as never;

/** Model id used for cost estimates of replayed usage (pricing catalog entry). */
export const BENCH_MODEL = 'gpt-4o-mini';

export type ModelFactoryLike = {
  getDefaultModel(): unknown;
  getProviderName(): string;
  getModelName(): string;
};

function buildService(opts: {
  diffService: unknown;
  projectMemory?: unknown;
  modelFactory?: ModelFactoryLike;
}) {
  const usage = {
    ...usageStub(),
    consume: vi.fn(async () => ({ allowed: true })),
    release: vi.fn(async () => true),
  };
  const observability = {
    createOperationId: () => 'op',
    observeGenerate: async ({
      call,
    }: {
      call: () => Promise<{
        result: unknown;
        usageRaw?: { inputTokens?: number; outputTokens?: number };
      }>;
    }) => {
      const r = await call();
      return {
        result: r.result,
        observation: {
          usage: { inputTokens: r.usageRaw?.inputTokens, outputTokens: r.usageRaw?.outputTokens },
          cost: {},
          durationMs: 0,
        },
      };
    },
    recordStreamSuccess: vi.fn(),
    recordStreamFailure: vi.fn(),
  };
  const modelFactory: ModelFactoryLike = opts.modelFactory ?? {
    getDefaultModel: () => 'replay',
    getProviderName: () => 'openai',
    getModelName: () => BENCH_MODEL,
  };
  const health = { recordSignal: vi.fn() };
  const service = new AiService(
    new PromptRegistry(),
    modelFactory as never,
    {
      get: () => ({
        requestTimeoutMs: 1_000,
        maxInputCharacters: 20_000,
        prReview: {},
      }),
    } as never,
    {
      getForUser: vi.fn(async () => ({
        maxOutputTokens: 600,
        responseStyle: 'CONCISE',
        includePageContext: true,
      })),
    } as never,
    {
      user: { findUnique: vi.fn(async () => null) },
      workspaceMembership: { findFirst: vi.fn(async () => null) },
    } as never,
    { require: vi.fn(async () => undefined) } as never,
    usage as never,
    observability as never,
    { get: () => ({}), patch: vi.fn() } as never,
    health as never,
    undefined,
    opts.projectMemory as never,
    opts.diffService as never,
    new PrReviewOrchestrator(modelFactory as never, observability as never, health as never),
  );
  return { service, usage };
}

export const isVerification = (args: unknown) =>
  (args as { instructions?: string }).instructions === PR_REVIEW_VERIFY_INSTRUCTIONS;
const estimate = (chars: number) => Math.ceil(chars / 4);

/** One model request made by the pipeline (what a responder must answer). */
export type ModelCall = {
  stage: 'batch' | 'verify';
  instructions: string;
  content: string;
  /** Verification: the candidate title in the claim; batch: the files under review. */
  identity: { title?: string; files?: string[] };
  /** The exact generateText arguments (model, schema, limits) — for live calls only. */
  args: unknown;
};

export type ModelReply = {
  output: unknown;
  finishReason: string;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** Wall-clock of the model call (captured / live only). */
  latencyMs?: number;
};

export type Responder = (call: ModelCall) => Promise<ModelReply>;

export function describeCall(args: unknown): ModelCall {
  const a = args as { instructions: string; messages: { content: string }[] };
  const content = a.messages[0]!.content;
  const verify = isVerification(args);
  return {
    stage: verify ? 'verify' : 'batch',
    instructions: a.instructions,
    content,
    identity: verify
      ? { title: /title: (.*)/.exec(content)?.[1] ?? '' }
      : {
          files: (content.split('reviewFiles:\n')[1]?.split('\notherChangedFiles:')[0] ?? '')
            .split('\n')
            .map((l) => l.replace(/^- /, '').trim())
            .filter(Boolean),
        },
    args,
  };
}

/** Answers from a case's scripted `responses.json` run (deterministic). */
export function scriptedResponder(run: ResponseRun): Responder {
  return async (call) => {
    let output: unknown;
    if (call.stage === 'verify') {
      output = run.verify[call.identity.title ?? ''] ?? {
        verdict: 'insufficient_context',
        severity: 'medium',
        reasoning: 'no recorded answer',
        decisiveCode: '',
        failureSite: '',
        dependsOnCodeNotShown: true,
        reachableTrigger: '',
        violatedInvariant: '',
        triggerSource: '',
        guardsOnPath: [],
      };
    } else {
      const files = call.identity.files ?? [];
      output = {
        summary: run.batch.summary,
        findings: run.batch.findings.filter((f) => files.includes(f.path)),
      };
    }
    return {
      output,
      finishReason: 'stop',
      usage: {
        inputTokens: estimate(call.instructions.length + call.content.length),
        outputTokens: estimate(JSON.stringify(output).length),
      },
    };
  };
}

// ── report parsing ─────────────────────────────────────────────────────────

export type ReportEntry = {
  section: 'risk' | 'investigation';
  severity: string;
  path: string;
  title: string;
  verification: string;
  lines: [number, number] | null;
};

export function parseReport(text: string): ReportEntry[] {
  const out: ReportEntry[] = [];
  const [risk = '', investigation = ''] = text.split('## Needs Investigation');
  for (const [section, body] of [
    ['risk', risk.split('## Risk Findings')[1] ?? ''],
    ['investigation', investigation],
  ] as const) {
    for (const block of body.split(/\n(?=\d+\. \*\*\[)/)) {
      const head = /^\d+\. \*\*\[(high|medium|low)\]\*\* `([^`]+)` — (.+)$/m.exec(block);
      if (!head) continue;
      const lines = /^ {3}Lines: L(\d+)(?:-L(\d+))?/m.exec(block);
      out.push({
        section,
        severity: head[1]!,
        path: head[2]!,
        title: head[3]!.trim(),
        verification: /^ {3}Verification: (.*)$/m.exec(block)?.[1] ?? '',
        lines: lines ? [Number(lines[1]), Number(lines[2] ?? lines[1])] : null,
      });
    }
  }
  return out;
}

// ── tracing ────────────────────────────────────────────────────────────────

export type FinalOutcome =
  | 'confirmed'
  | 'reported_unverified'
  | 'reported_unchecked_low'
  | 'needs_investigation'
  | 'dismissed'
  | 'rejected'
  | 'not_generated';

export const OUTCOME_RANK: Record<FinalOutcome, number> = {
  confirmed: 6,
  reported_unverified: 5,
  reported_unchecked_low: 4,
  needs_investigation: 3,
  dismissed: 2,
  rejected: 1,
  not_generated: 0,
};

export type CandidateTrace = {
  title: string;
  path: string;
  /** Ground-truth bug this candidate matches (path, lines ±3, compatible category), if any. */
  truth: string | null;
  validation: string;
  lines: [number, number] | null;
  gateNotes: string[];
  gate: string;
  dependencies: Record<string, unknown> | null;
  verification: Record<string, unknown> | null;
  final: FinalOutcome;
};

export type CaseRun = {
  caseId: string;
  runId: string;
  /** Where the model answers came from. */
  provenance: 'scripted' | 'captured' | 'live';
  clean: boolean;
  candidates: CandidateTrace[];
  truth: {
    id: string;
    severity: string;
    security: boolean;
    outcome: FinalOutcome;
    by: string | null;
  }[];
  report: {
    risk: number;
    confirmed: number;
    unverified: number;
    uncheckedLow: number;
    investigation: number;
  };
  coverage: { reviewed: number; total: number };
  tokens: { input: number; output: number; calls: number; verificationCalls: number };
  costUsd: number;
  usageUnits: number;
  /** Wall-clock of the replay (not deterministic; excluded from snapshots). */
  replayMs: number;
  /** Sum of model-call latencies (captured / live only; null for scripted). */
  modelLatencyMs: number | null;
};

const FAMILY: Record<string, string> = {
  security: 'auth',
  data_integrity: 'data',
  availability: 'runtime',
  correctness: 'runtime',
  robustness: 'runtime',
  test_gap: 'other',
  maintainability: 'other',
  observability: 'other',
};
/** Security and data-integrity overlap (e.g. a tenant leak); runtime categories overlap. */
function compatible(a: string, b: string): boolean {
  const fa = FAMILY[a] ?? 'other';
  const fb = FAMILY[b] ?? 'other';
  if (fa === fb) return true;
  return (
    (fa === 'auth' && fb === 'data') ||
    (fa === 'data' && fb === 'auth') ||
    (fa === 'data' && fb === 'runtime') ||
    (fa === 'runtime' && fb === 'data')
  );
}
const LINE_TOLERANCE = 3;

/**
 * A candidate matches a bug when it is in the same file, has a compatible category, and its
 * reported range or its head-line anchor is within ±3 lines of the bug. (Removed-safeguard
 * findings are reported at old-file lines; their head anchor is where the failure now runs.)
 * A removed-safeguard candidate's reported range also matches the bug's removed (old-file)
 * lines when the label has them.
 */
function matchTruth(
  truth: GroundTruth[],
  path: string,
  locations: ([number, number] | null)[],
  category: string,
  removed: [number, number] | null = null,
): string | null {
  const near = (r: [number, number], span: [number, number]) =>
    r[0] <= span[1] + LINE_TOLERANCE && r[1] >= span[0] - LINE_TOLERANCE;
  const hit = truth.find(
    (t) =>
      t.path === path &&
      compatible(t.category, category) &&
      (locations.some((r) => r != null && near(r, t.lines)) ||
        (removed != null && t.removedLines != null && near(removed, t.removedLines))),
  );
  return hit?.id ?? null;
}

function batchFor(changed: { path: string; hunks: string }[]): PlannedBatch {
  const units = changed.map((f) => ({
    path: f.path,
    chunkIndex: 0,
    chunkCount: 1,
    chunk: chunkPatch(f.hunks, 10_000_000)[0]!,
  }));
  return { id: 'bench', units, diffChars: changed.reduce((n, f) => n + f.hunks.length, 0) };
}

/** Replay one run of one case through the real pipeline and trace every stage. */
export async function runCase(
  c: BenchCase,
  runId: string,
  generateTextMock: Mock,
  options: {
    /** Defaults to the scripted run `runId` of the case. */
    responder?: Responder;
    provenance?: CaseRun['provenance'];
    modelFactory?: ModelFactoryLike;
  } = {},
): Promise<CaseRun | null> {
  const scripted = c.responses.runs.find((r) => r.id === runId);
  const responder = options.responder ?? (scripted ? scriptedResponder(scripted) : null);
  if (!responder) return null;
  const sources = caseSources(c);
  const provider = async (path: string) => sources.head(path);
  const diffService = {
    resolve: vi.fn(async () => ({
      source: 'github_api',
      files: sources.changed.map((f) => makeFile(f.path, f.hunks)),
      totalFiles: sources.changed.length,
      pullRequestTitle: c.title,
      headSha: 'bench0000',
    })),
    createFileProvider: vi.fn(() => provider),
  };
  const projectMemory = c.projectMemory
    ? {
        resolvePromptContext: vi.fn(async () => ({
          status: 'applied',
          block: [
            '<<PROJECT_MEMORY source="server" version="bench">>',
            'Rules saved by this workspace for this repository. Apply them as project context.',
            c.projectMemory,
            '<</PROJECT_MEMORY>>',
          ].join('\n'),
          version: 'bench',
          rules: [],
          diagnostics: {},
        })),
      }
    : undefined;

  // Every batch finding the model returned (the candidates traced below) and model latency.
  const generated: BatchFindingInput[] = [];
  let modelLatencyMs: number | null = null;
  generateTextMock.mockReset();
  generateTextMock.mockImplementation(async (args: unknown) => {
    const call = describeCall(args);
    const reply = await responder(call);
    if (reply.latencyMs != null) modelLatencyMs = (modelLatencyMs ?? 0) + reply.latencyMs;
    if (call.stage === 'batch') {
      const findings = (reply.output as { findings?: BatchFindingInput[] } | null)?.findings ?? [];
      for (const f of findings) {
        if (!generated.some((g) => g.title === f.title && g.path === f.path)) generated.push(f);
      }
    }
    return reply;
  });

  const logged: Record<string, unknown>[] = [];
  const capture = (entry: unknown) => {
    if (typeof entry === 'object' && entry !== null) logged.push(entry as Record<string, unknown>);
  };
  const spies = [
    vi.spyOn(Logger.prototype, 'log').mockImplementation(capture),
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(capture),
    vi.spyOn(Logger.prototype, 'error').mockImplementation(capture),
  ];
  const started = Date.now();
  let result;
  try {
    const { service } = buildService({
      diffService,
      projectMemory,
      ...(options.modelFactory ? { modelFactory: options.modelFactory } : {}),
    });
    result = await service.generateActionWithMetadata('bench-user', INPUT);
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
  const replayMs = Date.now() - started;

  const entries = parseReport(result.text);
  const verifications = logged.filter((e) => e.msg === 'pr_review.verification');
  const completed = logged.find((e) => e.msg === 'pr_review.completed') ?? {};
  const coverage = result.coverage!;
  const gateReasons = Object.keys(coverage.findings.rejectedByReason);
  const batch = batchFor(sources.changed);
  const used = new Set<Record<string, unknown>>();

  const candidates: CandidateTrace[] = generated.map((raw) => {
    const v = validateBatchFindings({ summary: '', findings: [raw] }, batch, neutralizeDelimiters);
    const validated = v.findings[0];
    const validation = validated
      ? 'passed'
      : `rejected:${Object.keys(v.rejectedByReason)[0] ?? 'unknown'}`;
    const lines: [number, number] | null = validated
      ? validated.lineStart != null
        ? [validated.lineStart, validated.lineEnd ?? validated.lineStart]
        : null
      : (() => {
          const loc = locateEvidence(
            parsePatch(sources.changed.find((f) => f.path === raw.path)?.hunks ?? '').flatMap(
              (h) => h.lines,
            ),
            raw.evidence,
          );
          return loc?.start != null ? [loc.start, loc.end ?? loc.start] : null;
        })();
    const entry = entries.find((e) => e.title === raw.title.trim()) ?? null;
    const log =
      validated &&
      verifications.find(
        (e) => !used.has(e) && e.path === validated.path && e.line === validated.lineStart,
      );
    if (log) used.add(log);
    let gate = 'not_reached';
    let final: FinalOutcome;
    if (!validated) {
      final = 'rejected';
    } else if (entry) {
      gate = 'passed';
      final =
        entry.section === 'investigation'
          ? 'needs_investigation'
          : entry.verification.startsWith('confirmed')
            ? 'confirmed'
            : entry.verification.startsWith('UNVERIFIED')
              ? 'reported_unverified'
              : 'reported_unchecked_low';
    } else if (log) {
      gate = 'passed';
      final = log.outcome === 'dismissed' ? 'dismissed' : 'rejected';
    } else {
      const reason = gateReasons.find(
        (r) =>
          ![
            'path_not_in_batch',
            'evidence_not_in_diff',
            'trivial_evidence',
            'context_only_low',
            'deleted_code_only',
            'invalid_fields',
            'over_limit',
          ].includes(r),
      );
      gate = reason ? `rejected:${reason}` : 'merged_or_removed';
      final = 'rejected';
    }
    return {
      title: raw.title,
      path: raw.path,
      truth: matchTruth(
        c.groundTruth,
        raw.path,
        [lines, validated?.headLine != null ? [validated.headLine, validated.headLine] : null],
        raw.category,
        raw.changeType === 'removed_safeguard' ? lines : null,
      ),
      validation,
      lines,
      gateNotes: validated ? [...validated.gateNotes].sort() : [],
      gate,
      dependencies: (log?.dependencies as Record<string, unknown> | undefined) ?? null,
      verification: log
        ? {
            verifierVerdict: log.verifierVerdict ?? null,
            decision: log.decision ?? null,
            outcome: log.outcome,
            guardRelation: log.guardRelation ?? null,
            guardCoverage: log.guardCoverage ?? null,
            callers: log.callers ?? null,
          }
        : null,
      final,
    };
  });

  const truth = c.groundTruth.map((t) => {
    const matched = candidates.filter((x) => x.truth === t.id);
    const best = matched.sort((a, b) => OUTCOME_RANK[b.final] - OUTCOME_RANK[a.final])[0];
    return {
      id: t.id,
      severity: t.severity,
      security: t.security,
      outcome: best?.final ?? ('not_generated' as const),
      by: best?.title ?? null,
    };
  });

  const risk = entries.filter((e) => e.section === 'risk');
  return {
    caseId: c.id,
    runId,
    provenance: options.provenance ?? 'scripted',
    clean: c.clean,
    candidates: candidates.sort((a, b) => a.title.localeCompare(b.title)),
    truth,
    report: {
      risk: risk.length,
      confirmed: risk.filter((e) => e.verification.startsWith('confirmed')).length,
      unverified: risk.filter((e) => e.verification.startsWith('UNVERIFIED')).length,
      uncheckedLow: risk.filter((e) => e.verification.startsWith('not required')).length,
      investigation: entries.filter((e) => e.section === 'investigation').length,
    },
    coverage: {
      reviewed: coverage.counts.reviewed_full + coverage.counts.reviewed_partial,
      total: coverage.files.length,
    },
    tokens: {
      input: Number(completed.inputTokens ?? 0),
      output: Number(completed.outputTokens ?? 0),
      calls: Number(completed.calls ?? 0),
      verificationCalls: Number(completed.verificationCalls ?? 0),
    },
    costUsd: Number(completed.estimatedCostUsd ?? 0),
    usageUnits: coverage.usageUnits,
    replayMs,
    modelLatencyMs,
  };
}
