import type {
  WorkflowArtifactKind,
  WorkflowArtifactProvenance,
  WorkflowArtifactProvenanceStatus,
  WorkflowArtifactRef,
  WorkflowContextBinding,
} from '@project-x/types';

import { isWorkflowBindingStale } from './stale';

export function createArtifactProvenance(input: {
  artifact: WorkflowArtifactRef;
  producedByStepId?: string;
  bindings?: WorkflowContextBinding;
  status?: WorkflowArtifactProvenanceStatus;
}): WorkflowArtifactProvenance {
  return {
    artifactId: input.artifact.id,
    artifactType: input.artifact.kind,
    producedByStepId: input.producedByStepId ?? input.artifact.producedByStepId,
    bindings: input.bindings ?? input.artifact.binding ?? {},
    createdAt: input.artifact.createdAt,
    status: input.status ?? input.artifact.provenanceStatus ?? 'CURRENT',
  };
}

export function annotateArtifact(
  artifact: WorkflowArtifactRef,
  patch: Partial<Pick<WorkflowArtifactRef, 'producedByStepId' | 'provenanceStatus' | 'binding'>>,
): WorkflowArtifactRef {
  return { ...artifact, ...patch };
}

export function markArtifactsStaleForBindingChange(
  artifacts: Record<string, WorkflowArtifactRef>,
  planned: WorkflowContextBinding,
  current: WorkflowContextBinding,
): Record<string, WorkflowArtifactRef> {
  const stale = isWorkflowBindingStale(planned, current);
  if (!stale.stale) {
    return artifacts;
  }

  const next: Record<string, WorkflowArtifactRef> = {};
  for (const [id, artifact] of Object.entries(artifacts)) {
    const binding = artifact.binding ?? planned;
    const artifactStale = isWorkflowBindingStale(binding, current);
    next[id] = artifactStale.stale ? { ...artifact, provenanceStatus: 'STALE' } : artifact;
  }
  return next;
}

export type ConsumeArtifactResult =
  | { ok: true; artifact: WorkflowArtifactRef }
  | {
      ok: false;
      code: 'WORKFLOW_ARTIFACT_NOT_FOUND' | 'AGENT_ARTIFACT_STALE' | 'WORKFLOW_ARTIFACT_STALE';
      message: string;
    };

/**
 * Before consuming an artifact: verify type, binding freshness, and provenance status.
 */
export function consumeWorkflowArtifact(
  artifacts: Record<string, WorkflowArtifactRef>,
  opts: {
    kind: WorkflowArtifactKind;
    artifactId?: string;
    currentBinding: WorkflowContextBinding;
  },
): ConsumeArtifactResult {
  const candidates = Object.values(artifacts).filter((a) => a.kind === opts.kind);
  const artifact = opts.artifactId
    ? artifacts[opts.artifactId]
    : (candidates.find((a) => (a.provenanceStatus ?? 'CURRENT') === 'CURRENT') ?? candidates[0]);

  if (!artifact || artifact.kind !== opts.kind) {
    return {
      ok: false,
      code: 'WORKFLOW_ARTIFACT_NOT_FOUND',
      message: `Required ${opts.kind} artifact was not found.`,
    };
  }

  if (artifact.provenanceStatus === 'INVALID') {
    return {
      ok: false,
      code: 'AGENT_ARTIFACT_STALE',
      message: `Artifact ${artifact.id} is invalid and cannot be consumed.`,
    };
  }

  if (artifact.provenanceStatus === 'STALE') {
    return {
      ok: false,
      code: 'WORKFLOW_ARTIFACT_STALE',
      message: `Artifact ${artifact.id} is stale and cannot be consumed.`,
    };
  }

  if (artifact.binding) {
    const stale = isWorkflowBindingStale(artifact.binding, opts.currentBinding);
    if (stale.stale) {
      return {
        ok: false,
        code: 'WORKFLOW_ARTIFACT_STALE',
        message: `Artifact ${artifact.id} binding no longer matches current context.`,
      };
    }
  }

  return { ok: true, artifact };
}

export function findCurrentArtifact(
  artifacts: Record<string, WorkflowArtifactRef>,
  kind: WorkflowArtifactKind,
): WorkflowArtifactRef | undefined {
  return Object.values(artifacts).find(
    (a) => a.kind === kind && (a.provenanceStatus ?? 'CURRENT') === 'CURRENT',
  );
}
