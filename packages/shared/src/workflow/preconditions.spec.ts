import { describe, expect, it } from 'vitest';
import type { WorkflowArtifactRef, WorkflowContextBinding } from '@project-x/types';
import { WorkflowStepType } from '@project-x/types';

import {
  evaluateCapabilityPreconditions,
  evaluatePrecondition,
  type PreconditionRuntime,
} from './preconditions';

const binding: WorkflowContextBinding = {
  github: {
    repository: 'acme/pay',
    prNumber: 42,
    headSha: 'abc1234',
  },
  jira: { issueKey: 'PAY-321' },
};

function runtime(overrides?: Partial<PreconditionRuntime>): PreconditionRuntime {
  return {
    binding,
    artifacts: {},
    providersConnected: { github: true, jira: true },
    writePermissionAvailable: { github: true },
    userSelectedTarget: true,
    explicitConfirmationGranted: false,
    ...overrides,
  };
}

function preparedPatch(): WorkflowArtifactRef {
  return {
    id: 'patch-1',
    kind: 'prepared-patch',
    createdAt: '2026-09-12T00:00:00.000Z',
    binding,
    provenanceStatus: 'CURRENT',
  };
}

describe('evaluatePrecondition', () => {
  it('passes PROVIDER_CONNECTED when github is connected', () => {
    expect(
      evaluatePrecondition({ type: 'PROVIDER_CONNECTED', provider: 'github' }, runtime()),
    ).toEqual({ ok: true });
  });

  it('fails PROVIDER_CONNECTED when github is disconnected', () => {
    const result = evaluatePrecondition(
      { type: 'PROVIDER_CONNECTED', provider: 'github' },
      runtime({ providersConnected: { github: false, jira: true } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('AGENT_PRECONDITION_FAILED');
    expect(result.message).toMatch(/GitHub is not connected/i);
  });

  it('fails PROVIDER_CONNECTED when jira is disconnected', () => {
    const result = evaluatePrecondition(
      { type: 'PROVIDER_CONNECTED', provider: 'jira' },
      runtime({ providersConnected: { github: true, jira: false } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/Jira is not connected/i);
  });

  it('passes ARTIFACT_CURRENT when a current artifact exists', () => {
    expect(
      evaluatePrecondition(
        { type: 'ARTIFACT_CURRENT', artifactKind: 'prepared-patch' },
        runtime({ artifacts: { 'patch-1': preparedPatch() } }),
      ),
    ).toEqual({ ok: true });
  });

  it('fails ARTIFACT_CURRENT when artifact is stale', () => {
    const result = evaluatePrecondition(
      { type: 'ARTIFACT_CURRENT', artifactKind: 'prepared-patch' },
      runtime({
        artifacts: {
          'patch-1': { ...preparedPatch(), provenanceStatus: 'STALE' },
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('fails WRITE_PERMISSION_AVAILABLE when github write is unavailable', () => {
    const result = evaluatePrecondition(
      { type: 'WRITE_PERMISSION_AVAILABLE', provider: 'github' },
      runtime({ writePermissionAvailable: { github: false } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/write permission/i);
  });
});

describe('evaluateCapabilityPreconditions', () => {
  it('requires connected github + write permission + current prepared-patch for APPLY_PATCH', () => {
    const ok = evaluateCapabilityPreconditions(
      WorkflowStepType.APPLY_PATCH,
      runtime({ artifacts: { 'patch-1': preparedPatch() } }),
    );
    expect(ok).toEqual({ ok: true });

    const disconnected = evaluateCapabilityPreconditions(
      WorkflowStepType.APPLY_PATCH,
      runtime({
        artifacts: { 'patch-1': preparedPatch() },
        providersConnected: { github: false, jira: true },
      }),
    );
    expect(disconnected.ok).toBe(false);

    const noWrite = evaluateCapabilityPreconditions(
      WorkflowStepType.APPLY_PATCH,
      runtime({
        artifacts: { 'patch-1': preparedPatch() },
        writePermissionAvailable: { github: false },
      }),
    );
    expect(noWrite.ok).toBe(false);
  });
});
