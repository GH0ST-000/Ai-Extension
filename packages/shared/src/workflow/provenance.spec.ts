import { describe, expect, it } from 'vitest';
import type { WorkflowArtifactRef, WorkflowContextBinding } from '@project-x/types';

import {
  consumeWorkflowArtifact,
  createArtifactProvenance,
  markArtifactsStaleForBindingChange,
} from './provenance';

const binding: WorkflowContextBinding = {
  github: {
    repository: 'acme/pay',
    prNumber: 42,
    headSha: 'abc1234',
  },
};

const staleBinding: WorkflowContextBinding = {
  github: {
    repository: 'acme/pay',
    prNumber: 42,
    headSha: 'def5678',
  },
};

function makeArtifact(overrides?: Partial<WorkflowArtifactRef>): WorkflowArtifactRef {
  return {
    id: 'art-1',
    kind: 'prepared-patch',
    createdAt: '2026-09-12T00:00:00.000Z',
    binding,
    provenanceStatus: 'CURRENT',
    ...overrides,
  };
}

describe('consumeWorkflowArtifact', () => {
  it('consumes a current artifact', () => {
    const artifacts = { 'art-1': makeArtifact() };
    const result = consumeWorkflowArtifact(artifacts, {
      kind: 'prepared-patch',
      currentBinding: binding,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.id).toBe('art-1');
  });

  it('rejects a stale provenance status', () => {
    const artifacts = {
      'art-1': makeArtifact({ provenanceStatus: 'STALE' }),
    };
    const result = consumeWorkflowArtifact(artifacts, {
      kind: 'prepared-patch',
      currentBinding: binding,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('WORKFLOW_ARTIFACT_STALE');
  });

  it('rejects when binding no longer matches', () => {
    const artifacts = { 'art-1': makeArtifact() };
    const result = consumeWorkflowArtifact(artifacts, {
      kind: 'prepared-patch',
      currentBinding: staleBinding,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('WORKFLOW_ARTIFACT_STALE');
  });

  it('rejects missing artifacts', () => {
    const result = consumeWorkflowArtifact(
      {},
      {
        kind: 'prepared-patch',
        currentBinding: binding,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('WORKFLOW_ARTIFACT_NOT_FOUND');
  });
});

describe('markArtifactsStaleForBindingChange', () => {
  it('marks artifacts stale when binding changes', () => {
    const artifacts = {
      a: makeArtifact({ id: 'a' }),
      b: makeArtifact({
        id: 'b',
        binding: {
          github: {
            repository: 'acme/other',
            prNumber: 1,
            headSha: 'zzz',
          },
        },
      }),
    };
    const next = markArtifactsStaleForBindingChange(artifacts, binding, staleBinding);
    expect(next.a?.provenanceStatus).toBe('STALE');
    expect(next.b?.provenanceStatus).toBe('STALE');
  });

  it('leaves artifacts unchanged when binding is fresh', () => {
    const artifacts = { a: makeArtifact({ id: 'a' }) };
    const next = markArtifactsStaleForBindingChange(artifacts, binding, { ...binding });
    expect(next.a?.provenanceStatus).toBe('CURRENT');
  });
});

describe('createArtifactProvenance', () => {
  it('copies artifact identity and defaults status to CURRENT', () => {
    const artifact = makeArtifact({ producedByStepId: 'prep' });
    const provenance = createArtifactProvenance({ artifact });
    expect(provenance.artifactId).toBe('art-1');
    expect(provenance.artifactType).toBe('prepared-patch');
    expect(provenance.producedByStepId).toBe('prep');
    expect(provenance.status).toBe('CURRENT');
  });
});
