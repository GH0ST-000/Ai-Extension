import type {
  WorkflowArtifactKind,
  WorkflowArtifactRef,
  WorkflowCapabilityPrecondition,
  WorkflowContextBinding,
  WorkflowContextRequirement,
  WorkflowStepType,
} from '@project-x/types';

import { getCapability } from './capabilities';
import { consumeWorkflowArtifact } from './provenance';

export type PreconditionRuntime = {
  binding: WorkflowContextBinding;
  artifacts: Record<string, WorkflowArtifactRef>;
  providersConnected: { github: boolean; jira: boolean };
  writePermissionAvailable: { github: boolean };
  userSelectedTarget: boolean;
  /** True only when the user has already confirmed the write in Day 12/13/14 UX. */
  explicitConfirmationGranted: boolean;
};

export type PreconditionEvalResult =
  | { ok: true }
  | {
      ok: false;
      code: 'AGENT_PRECONDITION_FAILED';
      message: string;
      precondition: WorkflowCapabilityPrecondition;
    };

function hasContext(binding: WorkflowContextBinding, context: WorkflowContextRequirement): boolean {
  switch (context) {
    case 'jira':
      return Boolean(binding.jira?.issueKey);
    case 'github':
      return Boolean(binding.github?.repository && binding.github.prNumber);
    case 'api':
      return Boolean(binding.api?.documentHash);
    case 'ci':
      return Boolean(binding.ci?.headSha);
    default: {
      const _exhaustive: never = context;
      return _exhaustive;
    }
  }
}

export function evaluatePrecondition(
  precondition: WorkflowCapabilityPrecondition,
  runtime: PreconditionRuntime,
): PreconditionEvalResult {
  switch (precondition.type) {
    case 'HAS_CONTEXT': {
      const ctx = precondition.context;
      if (!ctx || !hasContext(runtime.binding, ctx)) {
        return {
          ok: false,
          code: 'AGENT_PRECONDITION_FAILED',
          message: `Required context "${ctx ?? 'unknown'}" is not available.`,
          precondition,
        };
      }
      return { ok: true };
    }
    case 'HAS_ARTIFACT':
    case 'ARTIFACT_CURRENT': {
      const kind = precondition.artifactKind as WorkflowArtifactKind | undefined;
      if (!kind) {
        return {
          ok: false,
          code: 'AGENT_PRECONDITION_FAILED',
          message: 'Artifact precondition is missing kind.',
          precondition,
        };
      }
      const consumed = consumeWorkflowArtifact(runtime.artifacts, {
        kind,
        currentBinding: runtime.binding,
      });
      if (!consumed.ok) {
        return {
          ok: false,
          code: 'AGENT_PRECONDITION_FAILED',
          message: consumed.message,
          precondition,
        };
      }
      return { ok: true };
    }
    case 'USER_SELECTED_TARGET':
      if (!runtime.userSelectedTarget) {
        return {
          ok: false,
          code: 'AGENT_PRECONDITION_FAILED',
          message: 'User target selection is required.',
          precondition,
        };
      }
      return { ok: true };
    case 'PROVIDER_CONNECTED': {
      const provider = precondition.provider;
      if (provider === 'github' && !runtime.providersConnected.github) {
        return {
          ok: false,
          code: 'AGENT_PRECONDITION_FAILED',
          message: 'GitHub is not connected.',
          precondition,
        };
      }
      if (provider === 'jira' && !runtime.providersConnected.jira) {
        return {
          ok: false,
          code: 'AGENT_PRECONDITION_FAILED',
          message: 'Jira is not connected.',
          precondition,
        };
      }
      return { ok: true };
    }
    case 'WRITE_PERMISSION_AVAILABLE':
      if (precondition.provider === 'github' && !runtime.writePermissionAvailable.github) {
        return {
          ok: false,
          code: 'AGENT_PRECONDITION_FAILED',
          message: 'GitHub write permission is not available.',
          precondition,
        };
      }
      return { ok: true };
    case 'EXPLICIT_CONFIRMATION':
      // Confirmation is gated by the execution engine / Day 12–14 UX.
      // Precondition passes as a marker; engine still pauses for confirmation.
      return { ok: true };
    default: {
      const _exhaustive: never = precondition.type;
      return _exhaustive;
    }
  }
}

export function evaluateCapabilityPreconditions(
  type: WorkflowStepType,
  runtime: PreconditionRuntime,
): PreconditionEvalResult {
  const preconditions = getCapability(type).preconditions;
  for (const precondition of preconditions) {
    // USER_SELECTED_TARGET is satisfied by the user-decision step itself at pause time.
    if (precondition.type === 'USER_SELECTED_TARGET') {
      continue;
    }
    // EXPLICIT_CONFIRMATION is enforced by pausing — do not block entering the write step.
    if (precondition.type === 'EXPLICIT_CONFIRMATION') {
      continue;
    }
    const result = evaluatePrecondition(precondition, runtime);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}
