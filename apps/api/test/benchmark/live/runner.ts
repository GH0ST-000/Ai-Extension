/**
 * Runs cases through the real pipeline with either live (recorded) or captured model answers.
 * The pipeline is the production code path; only the `generateText` boundary is swapped.
 */
import { join } from 'node:path';

import type { Mock } from 'vitest';

import { runCase, type BenchCase, type CaseRun, type ModelFactoryLike } from '../harness';
import type { RunSet } from '../metrics';
import {
  CAPTURE_SCHEMA_VERSION,
  caseCaptureFile,
  capturedResponder,
  recordingResponder,
  scrub,
  validateSession,
  writeJsonSafely,
  type CapturedCall,
  type CaptureSession,
  type CaseCapture,
  type GenerateResult,
  type LoadedCapture,
  type Pins,
} from './capture';

export function caseCaptureFiles(cases: CaseCapture[]): string[] {
  return cases.map((c) => caseCaptureFile(c.caseId, c.runIndex));
}

/** Writes a session and its case captures (secret-checked) under `dir`. */
export function saveCapture(
  dir: string,
  session: CaptureSession,
  cases: CaseCapture[],
  secrets: string[],
): void {
  for (const c of cases) {
    writeJsonSafely(join(dir, caseCaptureFile(c.caseId, c.runIndex)), c, secrets);
  }
  writeJsonSafely(join(dir, 'capture.json'), session, secrets);
}

/** Generation parameters per stage, from the first captured call of each stage. */
export function stageGeneration(cases: CaseCapture[]): CaptureSession['generation'] {
  const first = (stage: 'batch' | 'verify') =>
    cases.flatMap((c) => c.calls).find((x) => x.stage === stage)?.generation ?? {};
  // The pipeline sets no temperature: null records "provider default".
  return {
    batch: { temperature: null, ...first('batch') },
    verify: { temperature: null, ...first('verify') },
  };
}

/** Capture one review of one case against the real model (paid). */
export async function captureCase(opts: {
  c: BenchCase;
  runIndex: number;
  captureId: string;
  generateTextMock: Mock;
  generate: (args: unknown) => Promise<GenerateResult>;
  modelFactory: ModelFactoryLike;
  model: { provider: string; id: string };
  secrets: string[];
}): Promise<{ run: CaseRun | null; capture: CaseCapture; failure: string | null }> {
  const calls: CapturedCall[] = [];
  const responder = recordingResponder({
    generate: opts.generate,
    model: opts.model,
    calls,
    secrets: opts.secrets,
  });
  const started = performance.now();
  let run: CaseRun | null = null;
  let failure: string | null = null;
  try {
    run = await runCase(opts.c, `live-${opts.runIndex}`, opts.generateTextMock, {
      responder,
      provenance: 'live',
      modelFactory: opts.modelFactory,
    });
  } catch (error) {
    // The whole review failed (e.g. every batch errored): a real outcome, kept in the capture.
    failure = scrub(`${(error as Error).name}: ${(error as Error).message}`, opts.secrets);
  }
  const reviewLatencyMs = Math.round(performance.now() - started);
  return {
    run,
    failure,
    capture: {
      schemaVersion: CAPTURE_SCHEMA_VERSION,
      captureId: opts.captureId,
      caseId: opts.c.id,
      runIndex: opts.runIndex,
      provenance: 'captured',
      model: opts.model,
      reviewLatencyMs,
      reviewFailure: failure,
      calls,
    },
  };
}

export type ReplayOutcome = {
  captureId: string;
  /** Session-level reasons the whole capture was rejected (pins, schema version). */
  rejected: string[];
  /** Differences that do not invalidate the answers (e.g. relabelled ground truth). */
  notices: string[];
  /** Case-runs rejected because the pipeline's requests no longer match the capture. */
  rejectedRuns: { caseId: string; runIndex: number; reasons: string[] }[];
  /** Case-runs whose review failed as a whole, both at capture time and in replay. */
  failedRuns: { caseId: string; runIndex: number; failure: string }[];
  set: RunSet | null;
};

const replayFactory = (model: { provider: string; id: string }): ModelFactoryLike => ({
  getDefaultModel: () => 'captured-replay',
  getProviderName: () => model.provider,
  getModelName: () => model.id,
});

/** Replay a capture session through the current pipeline. Never contacts the model. */
export async function replayCapture(
  loaded: LoadedCapture,
  corpus: BenchCase[],
  pins: Pins,
  generateTextMock: Mock,
): Promise<ReplayOutcome> {
  const { session } = loaded;
  const { problems: rejected, notices } = validateSession(session, pins);
  if (rejected.length > 0) {
    return {
      captureId: session.captureId,
      rejected,
      notices,
      rejectedRuns: [],
      failedRuns: [],
      set: null,
    };
  }
  const byCase = new Map(corpus.map((c) => [c.id, c]));
  const passes: CaseRun[][] = [];
  const latencies: number[] = [];
  const rejectedRuns: ReplayOutcome['rejectedRuns'] = [];
  const failedRuns: ReplayOutcome['failedRuns'] = [];
  for (const cap of [...loaded.cases].sort(
    (a, b) => a.runIndex - b.runIndex || a.caseId.localeCompare(b.caseId),
  )) {
    const reasons: string[] = [];
    if (cap.captureId !== session.captureId) reasons.push('captureId differs from the session');
    if (JSON.stringify(cap.model) !== JSON.stringify(session.model)) {
      reasons.push('model differs from the session');
    }
    const c = byCase.get(cap.caseId);
    if (!c) reasons.push('case no longer exists');
    if (reasons.length > 0 || !c) {
      rejectedRuns.push({ caseId: cap.caseId, runIndex: cap.runIndex, reasons });
      continue;
    }
    const replay = capturedResponder(cap);
    let run: CaseRun | null = null;
    let failure: string | null = null;
    try {
      run = await runCase(c, `captured-${cap.runIndex}`, generateTextMock, {
        responder: replay.responder,
        provenance: 'captured',
        modelFactory: replayFactory(cap.model),
      });
    } catch (error) {
      failure = `${(error as Error).name}: ${(error as Error).message}`;
    }
    const unused = replay.unused();
    if (replay.mismatches.length > 0 || unused.length > 0) {
      rejectedRuns.push({
        caseId: cap.caseId,
        runIndex: cap.runIndex,
        reasons: [
          ...replay.mismatches,
          ...unused.map(
            (u) =>
              `captured ${u.stage} ${u.identity.title ?? (u.identity.files ?? []).join(',')} was never requested`,
          ),
        ],
      });
      continue;
    }
    if (!run) {
      // Faithful only when the captured review failed too; otherwise the pipeline diverged.
      if (cap.reviewFailure) {
        failedRuns.push({ caseId: cap.caseId, runIndex: cap.runIndex, failure: cap.reviewFailure });
      } else {
        rejectedRuns.push({
          caseId: cap.caseId,
          runIndex: cap.runIndex,
          reasons: [`review failed in replay only: ${failure ?? 'no result'}`],
        });
      }
      continue;
    }
    (passes[cap.runIndex] ??= []).push(run);
    latencies.push(cap.reviewLatencyMs);
  }
  return {
    captureId: session.captureId,
    rejected: [],
    notices,
    rejectedRuns,
    failedRuns,
    set: {
      label: `capture ${session.captureId}`,
      provenance: 'captured',
      passes: passes.filter(Boolean),
      reviewLatencyMs: latencies,
    },
  };
}
