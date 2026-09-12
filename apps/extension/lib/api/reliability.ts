import type {
  AppendAuditEventRequest,
  CompleteExecutionRequest,
  ContextDriftSummary,
  CreateCheckpointRequest,
  ExecutionCheckpoint,
  ExecutionContextVersion,
  ListWorkflowExecutionsResponse,
  RecordArtifactLineageRequest,
  RecordFailureRequest,
  ReliabilityErrorBody,
  ReliabilityErrorCode,
  ReplayPreviewResponse,
  ResumeExecutionResponse,
  StartWorkflowExecutionRequest,
  WorkflowExecution,
  WorkflowExecutionDetail,
} from '@project-x/types';

import { USER_FACING_AUTH_ERROR } from '../selection/constants';
import { clearSession, getAccessToken } from '../services/auth-storage';

export class ReliabilityApiError extends Error {
  readonly statusCode: number;
  readonly unauthorized: boolean;
  readonly code: ReliabilityErrorCode | null;

  constructor(message: string, statusCode: number, code: ReliabilityErrorCode | null = null) {
    super(message);
    this.name = 'ReliabilityApiError';
    this.statusCode = statusCode;
    this.unauthorized = statusCode === 401;
    this.code = code;
  }
}

function getApiBaseUrl(): string {
  const configured = process.env.PLASMO_PUBLIC_API_URL?.trim();
  return (configured && configured.length > 0 ? configured : 'http://localhost:3001').replace(
    /\/$/,
    '',
  );
}

function reliabilityPath(suffix = ''): string {
  return `/reliability${suffix}`;
}

async function reliabilityFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  if (!token) {
    throw new ReliabilityApiError(USER_FACING_AUTH_ERROR, 401);
  }

  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });

  if (response.status === 401) {
    await clearSession();
    throw new ReliabilityApiError(USER_FACING_AUTH_ERROR, 401);
  }

  if (!response.ok) {
    let message = 'Reliability request failed.';
    let code: ReliabilityErrorCode | null = null;
    try {
      const body = (await response.json()) as ReliabilityErrorBody & { message?: string };
      message = body.message ?? message;
      code = body.code ?? null;
    } catch {
      // ignore
    }
    throw new ReliabilityApiError(message, response.status, code);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export async function startWorkflowExecution(
  body: StartWorkflowExecutionRequest,
): Promise<WorkflowExecution> {
  return reliabilityFetch<WorkflowExecution>(reliabilityPath('/executions'), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function appendWorkflowAuditEvent(
  executionId: string,
  body: AppendAuditEventRequest,
): Promise<WorkflowExecutionDetail> {
  return reliabilityFetch<WorkflowExecutionDetail>(
    reliabilityPath(`/executions/${encodeURIComponent(executionId)}/events`),
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export async function createWorkflowCheckpoint(
  executionId: string,
  body: CreateCheckpointRequest,
): Promise<ExecutionCheckpoint> {
  return reliabilityFetch<ExecutionCheckpoint>(
    reliabilityPath(`/executions/${encodeURIComponent(executionId)}/checkpoints`),
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export async function recordWorkflowFailure(executionId: string, body: RecordFailureRequest) {
  return reliabilityFetch(
    reliabilityPath(`/executions/${encodeURIComponent(executionId)}/failures`),
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

export async function recordWorkflowLineage(
  executionId: string,
  body: RecordArtifactLineageRequest,
): Promise<WorkflowExecutionDetail> {
  return reliabilityFetch<WorkflowExecutionDetail>(
    reliabilityPath(`/executions/${encodeURIComponent(executionId)}/lineage`),
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export async function completeWorkflowExecution(
  executionId: string,
  body: CompleteExecutionRequest,
): Promise<WorkflowExecution> {
  return reliabilityFetch<WorkflowExecution>(
    reliabilityPath(`/executions/${encodeURIComponent(executionId)}/complete`),
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export async function listReliabilityExecutions(): Promise<WorkflowExecution[]> {
  const response = await reliabilityFetch<ListWorkflowExecutionsResponse>(
    reliabilityPath('/executions'),
  );
  return response.executions;
}

export async function resumeReliabilityExecution(
  executionId: string,
): Promise<ResumeExecutionResponse> {
  return reliabilityFetch<ResumeExecutionResponse>(
    reliabilityPath(`/executions/${encodeURIComponent(executionId)}/resume`),
    { method: 'POST' },
  );
}

export type ReplayExecutionResult = {
  execution: WorkflowExecution;
  drift: ContextDriftSummary;
  requiresWriteConfirmation: boolean;
};

export async function previewReliabilityReplay(
  executionId: string,
  currentContext?: ExecutionContextVersion,
): Promise<ReplayPreviewResponse> {
  return reliabilityFetch<ReplayPreviewResponse>(
    reliabilityPath(`/executions/${encodeURIComponent(executionId)}/replay/preview`),
    {
      method: 'POST',
      body: JSON.stringify({ ...(currentContext ? { currentContext } : {}) }),
    },
  );
}

export async function replayReliabilityExecution(
  executionId: string,
  currentContext?: ExecutionContextVersion,
): Promise<ReplayExecutionResult> {
  const preview = await previewReliabilityReplay(executionId, currentContext);
  const execution = await reliabilityFetch<WorkflowExecution>(
    reliabilityPath(`/executions/${encodeURIComponent(executionId)}/replay`),
    {
      method: 'POST',
      body: JSON.stringify({ ...(currentContext ? { currentContext } : {}) }),
    },
  );
  return {
    execution,
    drift: preview.drift,
    requiresWriteConfirmation: preview.requiresWriteConfirmation,
  };
}

export function contextVersionFromBinding(binding: {
  github?: { repository?: string; prNumber?: number; pullRequestNumber?: number; headSha?: string };
  jira?: { issueKey?: string; updatedAt?: string };
  api?: { documentHash?: string; operationKey?: string };
}): ExecutionContextVersion {
  const prNumber = binding.github?.prNumber ?? binding.github?.pullRequestNumber;
  return {
    ...(binding.github?.repository ? { repository: binding.github.repository } : {}),
    ...(prNumber != null ? { prNumber } : {}),
    ...(binding.github?.headSha ? { prSha: binding.github.headSha } : {}),
    ...(binding.jira?.issueKey ? { jiraIssueKey: binding.jira.issueKey } : {}),
    ...(binding.jira?.updatedAt ? { jiraUpdatedAt: binding.jira.updatedAt } : {}),
    ...(binding.api?.documentHash ? { openapiHash: binding.api.documentHash } : {}),
    ...(binding.api?.operationKey ? { openapiDocId: binding.api.operationKey } : {}),
    plannerVersion: 'day21-planning-engine',
  };
}
