import { describe, expect, it } from 'vitest';

import {
  appendAuditEvent,
  appendCheckpoint,
  buildArtifactLineage,
  buildExecutionSnapshot,
  buildExecutionTimeline,
  classifyFailure,
  computeWorkflowHealthScore,
  createAuditEvent,
  createCheckpoint,
  createPromptSnapshot,
  createWorkflowExecutionId,
  decideRetry,
  detectContextDrift,
  emptyHealthSignals,
  hashPromptContent,
  isRetryableFailure,
  latestValidCheckpoint,
  nextExecutionNumber,
  preparePromptSnapshotBody,
  redactForReliability,
  resolveNextPromptVersion,
  resumeFromCheckpoint,
  sanitizeSafeMetadata,
} from './index';

describe('reliability identity', () => {
  it('creates opaque execution ids and increments numbers', () => {
    const a = createWorkflowExecutionId();
    const b = createWorkflowExecutionId();
    expect(a).toMatch(/^wex_/);
    expect(a).not.toEqual(b);
    expect(nextExecutionNumber(0)).toBe(1);
    expect(nextExecutionNumber(3)).toBe(4);
  });
});

describe('audit events + timeline', () => {
  it('creates structured events and ordered timeline', () => {
    const event = createAuditEvent({
      id: 'evt-1',
      type: 'WORKFLOW_STARTED',
      timestamp: '2026-09-12T20:00:00.000Z',
      executionId: 'wex_1',
      workflowId: 'wf_1',
      metadata: { token: 'secret', count: 2 },
    });
    expect(event.metadata?.token).toBe('[REDACTED]');
    expect(event.metadata?.count).toBe(2);

    const events = appendAuditEvent([], event);
    const timeline = buildExecutionTimeline(events);
    expect(timeline[0]?.label).toBe('Workflow Started');
  });
});

describe('checkpoints resume', () => {
  it('creates checkpoints and resumes from latest', () => {
    const cp = createCheckpoint({
      id: 'cp-1',
      kind: 'PLANNING_COMPLETE',
      label: 'Planning Complete',
      createdAt: '2026-09-12T20:00:00.000Z',
      state: { authorization: 'Bearer abc' },
    });
    expect(cp.state.authorization).toBe('[REDACTED]');
    const list = appendCheckpoint([], cp);
    expect(latestValidCheckpoint(list)?.id).toBe('cp-1');
    const resume = resumeFromCheckpoint(list);
    expect(resume.ok).toBe(true);
    if (resume.ok) {
      expect(resume.skipCompletedThrough).toBe('PLANNING_COMPLETE');
    }
  });
});

describe('failure classification + retry', () => {
  it('classifies timeouts as retryable and blocks write auto-retry', () => {
    const failure = classifyFailure({
      code: 'AI_TIMEOUT',
      message: 'request timed out',
    });
    expect(failure.category).toBe('TIMEOUT');
    expect(isRetryableFailure(failure)).toBe(true);

    const aiRetry = decideRetry({
      stage: 'AI_FETCH',
      category: 'TIMEOUT',
      attempt: 0,
    });
    expect(aiRetry.allowed).toBe(true);

    const writeRetry = decideRetry({
      stage: 'GITHUB_WRITE',
      category: 'NETWORK',
      attempt: 0,
      writeConfirmed: true,
    });
    expect(writeRetry.allowed).toBe(false);
    expect(writeRetry.requiresConfirmation).toBe(true);
  });
});

describe('health scoring', () => {
  it('scores deterministically', () => {
    const healthy = computeWorkflowHealthScore({
      ...emptyHealthSignals(),
      completedStages: 4,
    });
    expect(healthy.band).toBe('Excellent');

    const poor = computeWorkflowHealthScore({
      ...emptyHealthSignals(),
      failedStages: 3,
      timeouts: 2,
      staleArtifacts: 2,
    });
    expect(poor.score).toBeLessThan(55);
    expect(['Poor', 'Critical']).toContain(poor.band);
  });
});

describe('artifact lineage', () => {
  it('links parent refs without a graph DB', () => {
    const graph = buildArtifactLineage({
      artifacts: [
        { id: 'a1', kind: 'pr-review', summary: 'review' },
        { id: 'a2', kind: 'finding', parentArtifactId: 'a1' },
        { id: 'a3', kind: 'generated-patch', parentArtifactId: 'a2' },
      ],
    });
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toEqual([
      { fromArtifactId: 'a1', toArtifactId: 'a2', relation: 'derived_from' },
      { fromArtifactId: 'a2', toArtifactId: 'a3', relation: 'derived_from' },
    ]);
  });
});

describe('context drift', () => {
  it('detects PR SHA and memory drift', () => {
    const drift = detectContextDrift(
      { prSha: 'aaa', memoryVersion: 'v1', repository: 'acme/api' },
      { prSha: 'bbb', memoryVersion: 'v1', repository: 'acme/api' },
    );
    expect(drift.hasDrift).toBe(true);
    expect(drift.fields.some((f) => f.key === 'prSha')).toBe(true);
  });
});

describe('prompt versioning + redaction', () => {
  it('hashes redacted prompts and versions by hash', () => {
    const body = 'Explain code with Bearer eyJhbGciOiJIUzI1NiJ9.aaa.bbb';
    const snap = createPromptSnapshot({
      id: 'ps-1',
      name: 'explain',
      version: 1,
      rawBody: body,
      createdAt: '2026-09-12T20:00:00.000Z',
    });
    expect(snap.body).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(snap.redacted).toBe(true);
    expect(hashPromptContent(body)).toBe(snap.hash);

    const next = resolveNextPromptVersion([{ hash: snap.hash, version: 1 }], snap.hash);
    expect(next).toEqual({ version: 1, isNew: false });
    const newer = resolveNextPromptVersion([{ hash: snap.hash, version: 1 }], 'other');
    expect(newer).toEqual({ version: 2, isNew: true });
  });

  it('never leaves secrets in metadata or snapshot prep', () => {
    const meta = sanitizeSafeMetadata({
      apiKey: 'sk-abc',
      safe: 'ok',
    });
    expect(meta?.apiKey).toBe('[REDACTED]');
    expect(meta?.safe).toBe('ok');
    expect(redactForReliability('ghp_abcdefghijklmnopqrstuvwxyz12')).toContain('[REDACTED]');
    expect(preparePromptSnapshotBody('x'.repeat(10_000)).truncated).toBe(true);
  });
});

describe('execution snapshot', () => {
  it('stores lightweight goal and artifact refs only', () => {
    const snap = buildExecutionSnapshot({
      goal: 'Fix CI',
      artifactRefs: [
        {
          id: 'art-1',
          kind: 'ci-analysis',
          createdAt: '2026-09-12T20:00:00.000Z',
          summary: 'failing job',
        },
      ],
      checkpointIds: ['cp-1'],
    });
    expect(snap.goal).toBe('Fix CI');
    expect(snap.artifactRefs[0]?.id).toBe('art-1');
  });
});
