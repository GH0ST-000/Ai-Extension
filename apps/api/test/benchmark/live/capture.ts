/**
 * Captured live benchmark: recording real model answers and replaying them deterministically.
 *
 * A capture stores, per model call, only what replay and cost/latency analysis need:
 *   stage, candidate identity, sha256 of the exact prompt (instructions + user content) and of
 *   the generation parameters, the raw structured output, finish reason, provider usage,
 *   latency, the provider-reported model id and the estimated cost.
 * It never stores prompt text, request headers, the model object, provider options, API keys
 * or tokens; `assertNoSecrets` refuses to write a capture that contains anything secret-shaped.
 *
 * Replay is strict: a capture is rejected when its pins (prompts, schemas, review limits,
 * dependency caps, verification overhead, case sources, ground truth) differ from the current
 * code, and a case-run is rejected when the pipeline issues any request whose prompt or
 * generation-parameter hash was not captured (or leaves captured answers unused).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { estimateAiCost } from '@project-x/shared';
import { zodSchema } from 'ai';

import { PR_REVIEW_BATCH_INSTRUCTIONS } from '../../../src/ai/pr-review/pr-review-batch.prompt';
import {
  DEP_MAX_CONFIG_READS,
  DEP_MAX_FILES_PER_REVIEW,
  DEP_MAX_MISSING_PROBES,
  DEP_MAX_REQUESTS_PER_REVIEW,
} from '../../../src/ai/pr-review/pr-review-deps';
import { batchOutputSchema } from '../../../src/ai/pr-review/pr-review-findings';
import { DEFAULT_PR_REVIEW_LIMITS } from '../../../src/ai/pr-review/pr-review-plan';
import {
  PR_REVIEW_VERIFY_INSTRUCTIONS,
  VERIFY_REQUEST_OVERHEAD_CHARS,
  verificationSchema,
} from '../../../src/ai/pr-review/pr-review-verify';
import {
  BENCH_DIR,
  BENCH_MODEL,
  loadCorpus,
  type BenchCase,
  type ModelCall,
  type ModelReply,
  type Responder,
} from '../harness';

export const CAPTURES_DIR = join(BENCH_DIR, 'captures');
/** v2 pins case model inputs (`sources`) apart from labels; v1 pinned the whole case folder. */
export const CAPTURE_SCHEMA_VERSION = 2;
const READABLE_SCHEMA_VERSIONS = [1, 2];

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

// ── pins ───────────────────────────────────────────────────────────────────

function hashDir(dir: string, include: (rel: string) => boolean = () => true): string {
  const files: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  return sha256(
    files
      .filter((f) => include(relative(dir, f)))
      .sort()
      .map((f) => `${relative(dir, f)}\n${sha256(readFileSync(f, 'utf8'))}`)
      .join('\n'),
  );
}

/** Everything a recorded answer depends on besides the model itself. */
export async function currentPins(corpus: BenchCase[] = loadCorpus()) {
  const schema = async (s: unknown) =>
    sha256(JSON.stringify(await zodSchema(s as never).jsonSchema));
  return {
    corpus: Object.fromEntries(
      corpus.map((c) => [
        c.id,
        {
          files: hashDir(join(BENCH_DIR, 'corpus', c.id)),
          // What the model can be shown: head/base sources, the diff and Project Memory.
          // Labels, witnesses and reference fixes are excluded: they score answers, never
          // shape them.
          sources: sha256(
            [
              hashDir(join(BENCH_DIR, 'corpus', c.id), (rel) =>
                /^(?:head|base)\/|^diff\.patch$/.test(rel),
              ),
              c.projectMemory ?? '',
            ].join('\n'),
          ),
          ...(c.fixtures
            ? { fixtures: hashDir(join(BENCH_DIR, '..', 'fixtures', c.fixtures)) }
            : {}),
          groundTruth: c.groundTruth.map((t) => t.id),
          responses: { provenance: c.responses.provenance, model: c.responses.model },
        },
      ]),
    ),
    prompts: {
      batchInstructions: sha256(PR_REVIEW_BATCH_INSTRUCTIONS),
      verifyInstructions: sha256(PR_REVIEW_VERIFY_INSTRUCTIONS),
      batchSchema: await schema(batchOutputSchema),
      verifySchema: await schema(verificationSchema),
    },
    review: {
      limits: DEFAULT_PR_REVIEW_LIMITS,
      verifyRequestOverheadChars: VERIFY_REQUEST_OVERHEAD_CHARS,
    },
    dependencies: {
      sourceFiles: DEP_MAX_FILES_PER_REVIEW,
      configReads: DEP_MAX_CONFIG_READS,
      missingProbes: DEP_MAX_MISSING_PROBES,
      requests: DEP_MAX_REQUESTS_PER_REVIEW,
    },
    model: { mode: 'replay', costModel: BENCH_MODEL },
  };
}

export type Pins = Awaited<ReturnType<typeof currentPins>>;

/** Pins relevant to a capture: global settings plus the sources of the captured cases. */
export type CapturePins = Omit<Pins, 'corpus' | 'model'> & {
  corpus: Record<
    string,
    // v2: sources; v1 captures carry `files` (whole case folder, labels included).
    { sources?: string; files?: string; fixtures?: string; groundTruth: string[] }
  >;
};

export function capturePins(pins: Pins, caseIds: string[]): CapturePins {
  const { corpus, model: _model, ...rest } = pins;
  return {
    ...rest,
    corpus: Object.fromEntries(
      caseIds.map((id) => {
        const { sources, fixtures, groundTruth } = corpus[id]!;
        return [id, { sources, ...(fixtures ? { fixtures } : {}), groundTruth }];
      }),
    ),
  };
}

/** Differences between a capture's pins and the current code (dotted paths). Empty = valid. */
export function pinMismatches(captured: unknown, current: unknown, path = ''): string[] {
  if (
    typeof captured !== 'object' ||
    captured === null ||
    typeof current !== 'object' ||
    current === null
  ) {
    return JSON.stringify(captured) === JSON.stringify(current) ? [] : [path || '(root)'];
  }
  if (Array.isArray(captured) || Array.isArray(current)) {
    return JSON.stringify(captured) === JSON.stringify(current) ? [] : [path];
  }
  const a = captured as Record<string, unknown>;
  const b = current as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.flatMap((k) => pinMismatches(a[k], b[k], path ? `${path}.${k}` : k));
}

// ── capture format ─────────────────────────────────────────────────────────

/** Generation parameters the pipeline sets on a call (scalars only; never the model object). */
const GENERATION_KEYS = [
  'temperature',
  'topP',
  'topK',
  'presencePenalty',
  'frequencyPenalty',
  'seed',
  'maxOutputTokens',
  'maxRetries',
  'timeout',
  'stopSequences',
] as const;

export type GenerationParams = Partial<Record<(typeof GENERATION_KEYS)[number], unknown>>;

export function generationParams(args: unknown): GenerationParams {
  const a = (args ?? {}) as Record<string, unknown>;
  const out: GenerationParams = {};
  for (const k of GENERATION_KEYS) {
    const v = a[k];
    if (v == null) continue;
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v;
  }
  return out;
}

/** Hash of the exact request text the model saw. */
export const promptHash = (call: Pick<ModelCall, 'instructions' | 'content'>) =>
  sha256(`${call.instructions}\n\u0000\n${call.content}`);

export type CapturedCall = {
  seq: number;
  stage: 'batch' | 'verify';
  /** Candidate identity: verification → candidate title; batch → files under review. */
  identity: { title?: string; files?: string[] };
  promptHash: string;
  promptChars: number;
  generation: GenerationParams;
  generationHash: string;
  /** The raw structured output (null when the call failed). */
  output: unknown;
  finishReason: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  latencyMs: number;
  /** Model id reported by the provider response (exact version), when available. */
  responseModelId: string | null;
  costUsd: { estimated: number | null; provider: number | null; pricingVersion: string | null };
  /** A failed call: error class and a short, secret-scrubbed message. */
  error: { name: string; message: string } | null;
};

export type CaseCapture = {
  schemaVersion: number;
  captureId: string;
  caseId: string;
  runIndex: number;
  provenance: 'captured';
  model: { provider: string; id: string };
  /** Wall-clock of the whole review (batches run concurrently). */
  reviewLatencyMs: number;
  /** The review failed as a whole (scrubbed error), e.g. every batch errored. */
  reviewFailure: string | null;
  calls: CapturedCall[];
};

export type CaptureSession = {
  schemaVersion: number;
  captureId: string;
  provenance: 'captured';
  createdAt: string;
  model: { provider: string; id: string };
  /**
   * Generation parameters set by the pipeline per stage; `temperature: null` means the provider
   * default (the pipeline does not set one).
   */
  generation: Record<'batch' | 'verify', GenerationParams & { temperature: unknown }>;
  pins: CapturePins;
  selection: { cases: string[]; group: string | null; runs: number };
  budget: { maxUsd: number; plannedMaxUsd: number; spentEstimatedUsd: number };
  /** Case-runs captured (`<caseId>.run<N>.json`) and the ones skipped (budget, errors). */
  completed: string[];
  skipped: { caseId: string; runIndex: number; reason: string }[];
};

// ── secrets ────────────────────────────────────────────────────────────────

const SECRET_PATTERNS: [string, RegExp][] = [
  ['openai-key', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['auth-header', /"(?:authorization|x-api-key|api-key|apiKey|openaiApiKey)"\s*:/i],
];

/** Removes secret-shaped substrings (used for error messages). */
export function scrub(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets.filter((x) => x && x.length >= 8)) out = out.split(s).join('[redacted]');
  for (const [, re] of SECRET_PATTERNS) out = out.replace(new RegExp(re, 'g'), '[redacted]');
  return out;
}

/** Throws when serialized capture JSON contains a known secret value or a secret-shaped string. */
export function assertNoSecrets(json: string, secrets: string[] = []): void {
  for (const s of secrets.filter((x) => x && x.length >= 8)) {
    if (json.includes(s))
      throw new Error('capture contains a configured secret value; not written');
  }
  for (const [name, re] of SECRET_PATTERNS) {
    if (re.test(json)) throw new Error(`capture contains a ${name}-shaped value; not written`);
  }
}

/** Values of environment variables that look like credentials (never written to a capture). */
export function secretValues(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(
      ([k, v]) =>
        /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL/i.test(k) && v && v.length >= 8,
    )
    .map(([, v]) => v!);
}

/** Writes JSON only after checking it holds no secret value or secret-shaped string. */
export function writeJsonSafely(path: string, value: unknown, secrets: string[]): void {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  assertNoSecrets(json, secrets);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json);
}

// ── recording ──────────────────────────────────────────────────────────────

export type GenerateResult = {
  output?: unknown;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  response?: { modelId?: string };
};

/**
 * Wraps the real `generateText`: answers the pipeline with the provider's actual result and
 * appends a capture record. `onUsage` lets the caller enforce the spending cap.
 */
export function recordingResponder(opts: {
  generate: (args: unknown) => Promise<GenerateResult>;
  model: { provider: string; id: string };
  calls: CapturedCall[];
  secrets: string[];
  now?: () => number;
}): Responder {
  const now = opts.now ?? (() => performance.now());
  // Calls run concurrently: number them when they start, not when they finish.
  let seq = opts.calls.length;
  return async (call: ModelCall): Promise<ModelReply> => {
    const generation = generationParams(call.args);
    const base = {
      seq: seq++,
      stage: call.stage,
      identity: call.identity,
      promptHash: promptHash(call),
      promptChars: call.instructions.length + call.content.length,
      generation,
      generationHash: sha256(JSON.stringify(generation)),
    };
    const started = now();
    try {
      const result = await opts.generate(call.args);
      const latencyMs = Math.round(now() - started);
      const usage = {
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        totalTokens: result.usage?.totalTokens ?? null,
      };
      const cost = estimateAiCost({
        provider: opts.model.provider,
        model: opts.model.id,
        usage: {
          ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
          ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
          providerReported: result.usage != null,
        },
      });
      opts.calls.push({
        ...base,
        output: result.output ?? null,
        finishReason: result.finishReason ?? null,
        usage,
        latencyMs,
        responseModelId: result.response?.modelId ?? null,
        costUsd: {
          estimated: cost.totalCostUsd ?? null,
          // The OpenAI API does not return a billed amount per request.
          provider: null,
          pricingVersion: cost.pricingVersion ?? null,
        },
        error: null,
      });
      return {
        // The pipeline reads exactly these fields from the provider result.
        output: result.output,
        finishReason: result.finishReason ?? 'stop',
        usage: result.usage ?? {},
        latencyMs,
      };
    } catch (error) {
      const e = error as { name?: string; message?: string };
      opts.calls.push({
        ...base,
        output: null,
        finishReason: null,
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
        latencyMs: Math.round(now() - started),
        responseModelId: null,
        costUsd: { estimated: null, provider: null, pricingVersion: null },
        error: {
          name: e.name ?? 'Error',
          message: scrub(String(e.message ?? ''), opts.secrets).slice(0, 300),
        },
      });
      throw error;
    }
  };
}

// ── replay ─────────────────────────────────────────────────────────────────

export class CapturedCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapturedCallError';
  }
}

/**
 * Answers each request with the captured answer for the same prompt hash and generation
 * parameters (in recorded order when a prompt repeats, e.g. a retry). Any request without a
 * captured answer is recorded in `mismatches`; the caller rejects the case-run.
 */
export function capturedResponder(capture: CaseCapture): {
  responder: Responder;
  mismatches: string[];
  unused: () => CapturedCall[];
} {
  const pending = new Map<string, CapturedCall[]>();
  for (const c of [...capture.calls].sort((a, b) => a.seq - b.seq)) {
    const key = `${c.promptHash}:${c.generationHash}`;
    pending.set(key, [...(pending.get(key) ?? []), c]);
  }
  const mismatches: string[] = [];
  const responder: Responder = async (call) => {
    const generation = generationParams(call.args);
    const key = `${promptHash(call)}:${sha256(JSON.stringify(generation))}`;
    const hit = pending.get(key)?.shift();
    if (!hit) {
      const samePrompt = [...pending.values()]
        .flat()
        .some((c) => c.promptHash === promptHash(call));
      mismatches.push(
        `${call.stage} ${call.identity.title ?? (call.identity.files ?? []).join(',')}: ${
          samePrompt ? 'generation parameters differ' : 'prompt hash not captured'
        }`,
      );
      throw new CapturedCallError('no captured answer for this request');
    }
    if (hit.error) {
      const err = new Error(hit.error.message);
      err.name = hit.error.name;
      throw err;
    }
    return {
      output: hit.output,
      finishReason: hit.finishReason ?? 'stop',
      usage: {
        ...(hit.usage.inputTokens != null ? { inputTokens: hit.usage.inputTokens } : {}),
        ...(hit.usage.outputTokens != null ? { outputTokens: hit.usage.outputTokens } : {}),
        ...(hit.usage.totalTokens != null ? { totalTokens: hit.usage.totalTokens } : {}),
      },
      latencyMs: hit.latencyMs,
    };
  };
  return { responder, mismatches, unused: () => [...pending.values()].flat() };
}

// ── storage ────────────────────────────────────────────────────────────────

export const caseCaptureFile = (caseId: string, runIndex: number) =>
  `${caseId}.run${runIndex}.json`;

export type LoadedCapture = { dir: string; session: CaptureSession; cases: CaseCapture[] };

/** Every capture session under `captures/` (none in a fresh checkout: the folder is ignored). */
export function loadCaptures(root: string = CAPTURES_DIR): LoadedCapture[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter(
      (d) => statSync(join(root, d)).isDirectory() && existsSync(join(root, d, 'capture.json')),
    )
    .sort()
    .map((d) => {
      const dir = join(root, d);
      const session = JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8')) as CaptureSession;
      const cases = session.completed.map(
        (f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as CaseCapture,
      );
      return { dir, session, cases };
    });
}

export type SessionCheck = {
  /** Reasons the session cannot be replayed (any → rejected). */
  problems: string[];
  /** Differences that do not affect the recorded answers (reported with the results). */
  notices: string[];
};

/**
 * Whether a capture session can be replayed against the current code. Prompts, schemas,
 * limits, dependency caps and every case's model inputs must be unchanged. Ground-truth label
 * changes only re-score the answers and are reported as notices. Independently, replay
 * rejects any case-run whose requests do not match the captured prompt hashes exactly.
 */
export function validateSession(session: CaptureSession, pins: Pins): SessionCheck {
  const problems: string[] = [];
  const notices: string[] = [];
  if (!READABLE_SCHEMA_VERSIONS.includes(session.schemaVersion)) {
    problems.push(`schemaVersion ${session.schemaVersion} is not readable`);
  }
  if (session.provenance !== 'captured') problems.push('provenance is not "captured"');
  const ids = Object.keys(session.pins.corpus);
  for (const id of ids.filter((x) => !pins.corpus[x])) problems.push(`case ${id} no longer exists`);
  const current = capturePins(
    pins,
    ids.filter((id) => pins.corpus[id]),
  );
  const { corpus: capturedCorpus, ...capturedGlobal } = session.pins;
  const { corpus: currentCorpus, ...currentGlobal } = current;
  problems.push(...pinMismatches(capturedGlobal, currentGlobal).map((p) => `pin changed: ${p}`));
  for (const [id, was] of Object.entries(capturedCorpus)) {
    const now = currentCorpus[id];
    if (!now) continue;
    if (was.sources != null) {
      if (was.sources !== now.sources) problems.push(`pin changed: corpus.${id}.sources`);
    } else if (was.files !== pins.corpus[id]!.files) {
      notices.push(
        `${id}: v1 capture pinned the whole case folder, which changed since capture; model inputs are verified per request by prompt hash`,
      );
    }
    if ((was.fixtures ?? null) !== (now.fixtures ?? null)) {
      problems.push(`pin changed: corpus.${id}.fixtures`);
    }
    if (JSON.stringify(was.groundTruth) !== JSON.stringify(now.groundTruth)) {
      notices.push(`${id}: ground-truth ids changed since capture; scored with current labels`);
    }
  }
  return { problems, notices };
}
