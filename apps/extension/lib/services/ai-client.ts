import type {
  AIAction,
  ErrorIntelligenceContext,
  ExecuteAiActionRequest,
  PageContext,
  AppliedProjectMemoryRule,
  PRReviewScope,
  ProjectMemoryPromptMetadata,
  ProjectMemorySkipReason,
  WorkspaceErrorBody,
  WorkspaceErrorCode,
} from '@project-x/types';
import {
  PR_DIFF_UNAVAILABLE_CODE,
  PR_REVIEW_SCOPE_HEADER,
  PROJECT_MEMORY_METADATA_HEADER,
} from '@project-x/types';

/** AI error codes the client understands: workspace/entitlement codes plus PR review codes. */
export type AiErrorCode = WorkspaceErrorCode | typeof PR_DIFF_UNAVAILABLE_CODE;

import { extensionApiStream } from '../api/background-http';
import { USER_FACING_AI_ERROR, USER_FACING_AUTH_ERROR } from '../selection/constants';
import { entitlementFailureMessage, isEntitlementFailureCode } from '../workspace/entitlement';
import { clearSessionStorageOnly, hasAuthSession } from './auth-storage';

export class AiClientError extends Error {
  readonly aborted: boolean;
  readonly unauthorized: boolean;
  readonly code: AiErrorCode | null;
  readonly requestId: string | null;

  constructor(
    message: string,
    options?: {
      aborted?: boolean;
      unauthorized?: boolean;
      code?: AiErrorCode | null;
      requestId?: string | null;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'AiClientError';
    this.aborted = options?.aborted ?? false;
    this.unauthorized = options?.unauthorized ?? false;
    this.code = options?.code ?? null;
    this.requestId = options?.requestId ?? null;
  }
}

export type StreamAiActionHandlers = {
  onChunk: (chunk: string) => void;
  signal?: AbortSignal;
  /** REVIEW_ENTIRE_PR: the diff scope the API actually sent to the model. */
  onReviewScope?: (scope: PRReviewScope) => void;
  /** Project memory rules applied to the prompt, or why none were. */
  onProjectMemory?: (metadata: ProjectMemoryPromptMetadata) => void;
};

const MEMORY_SKIP_REASONS: ReadonlySet<string> = new Set<ProjectMemorySkipReason>([
  'no_repository',
  'invalid_repository',
  'memory_service_unavailable',
  'workspace_permission_denied',
  'feature_not_available',
  'github_not_connected',
  'github_token_rejected',
  'repository_access_denied',
  'github_unavailable',
  'retrieval_failed',
  'no_active_rules',
  'all_rules_blocked_by_safety_policy',
  'no_relevant_rules',
]);

const MAX_MEMORY_RULES_IN_METADATA = 50;

function decodeBase64UrlUtf8(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * Parse the `X-Project-Memory` header (base64url JSON). Strict: anything malformed is
 * dropped, and only known fields are kept, so the UI never renders unexpected data.
 */
export function parseProjectMemoryHeader(value: string | null): ProjectMemoryPromptMetadata | null {
  if (!value || value.length > 32_000) return null;
  try {
    const raw = JSON.parse(decodeBase64UrlUtf8(value)) as Record<string, unknown>;
    if (raw.status === 'skipped') {
      return typeof raw.reason === 'string' && MEMORY_SKIP_REASONS.has(raw.reason)
        ? { status: 'skipped', reason: raw.reason as ProjectMemorySkipReason }
        : null;
    }
    if (raw.status !== 'applied' || typeof raw.version !== 'string' || !Array.isArray(raw.rules)) {
      return null;
    }
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);
    const rules: AppliedProjectMemoryRule[] = [];
    for (const item of raw.rules.slice(0, MAX_MEMORY_RULES_IN_METADATA)) {
      const r = (item ?? {}) as Record<string, unknown>;
      const id = str(r.id, 64);
      const key = str(r.key, 200);
      const category = str(r.category, 64);
      const title = str(r.title, 200);
      const confidence = r.confidence;
      if (!id || !key || !category || title === null) continue;
      if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') continue;
      rules.push({
        id,
        key,
        category: category as AppliedProjectMemoryRule['category'],
        title,
        confidence,
        visibility: r.visibility === 'user' ? 'user' : 'workspace',
      });
    }
    return { status: 'applied', version: raw.version.slice(0, 128), rules };
  } catch {
    return null;
  }
}

/** Parse the `X-PR-Review-Scope` header; returns null for anything malformed. */
export function parseReviewScopeHeader(value: string | null): PRReviewScope | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value) as Partial<PRReviewScope>;
    const count = (n: unknown) =>
      typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
    const analyzed = count(raw.analyzedFiles);
    const skipped = count(raw.skippedFiles);
    if (
      (raw.source !== 'github_api' && raw.source !== 'page') ||
      analyzed === null ||
      skipped === null
    ) {
      return null;
    }
    return {
      source: raw.source,
      totalFiles: count(raw.totalFiles),
      analyzedFiles: analyzed,
      skippedFiles: skipped,
      truncated: raw.truncated === true,
    };
  } catch {
    return null;
  }
}

async function parseAiError(response: Response): Promise<{
  message: string;
  code: AiErrorCode | null;
}> {
  try {
    const body = (await response.json()) as {
      message?: string | string[] | WorkspaceErrorBody;
      code?: AiErrorCode;
    };

    if (typeof body.code === 'string' && typeof body.message === 'string') {
      return { message: body.message, code: body.code };
    }

    if (body && typeof body.message === 'object' && !Array.isArray(body.message) && body.message) {
      const nested = body.message as WorkspaceErrorBody;
      if (typeof nested.message === 'string') {
        return { message: nested.message, code: nested.code ?? null };
      }
    }

    if (Array.isArray(body.message)) {
      return { message: body.message.join(', '), code: null };
    }
    if (typeof body.message === 'string' && body.message.trim()) {
      return { message: body.message, code: null };
    }
  } catch {
    // ignore non-JSON bodies
  }
  return { message: USER_FACING_AI_ERROR, code: null };
}

export async function streamAiAction(
  request: ExecuteAiActionRequest,
  handlers: StreamAiActionHandlers,
): Promise<string> {
  const { onChunk, signal, onReviewScope, onProjectMemory } = handlers;
  if (!(await hasAuthSession())) {
    throw new AiClientError(USER_FACING_AUTH_ERROR, { unauthorized: true });
  }

  let response: Response;
  let fullText = '';
  try {
    response = await extensionApiStream(
      '/ai/actions/stream',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/plain',
        },
        body: JSON.stringify(request),
      },
      (chunk) => {
        fullText += chunk;
        onChunk(chunk);
      },
      signal,
    );
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw new AiClientError('Request cancelled', { aborted: true, cause: error });
    }
    throw new AiClientError(USER_FACING_AI_ERROR, { cause: error });
  }

  if (response.status === 401) {
    await clearSessionStorageOnly();
    throw new AiClientError(USER_FACING_AUTH_ERROR, { unauthorized: true });
  }

  if (!response.ok) {
    const requestId = response.headers.get('x-request-id');
    const parsed = await parseAiError(response);
    if (parsed.code === PR_DIFF_UNAVAILABLE_CODE) {
      // Actionable (connect GitHub / open a PR); the AI was not called.
      throw new AiClientError(parsed.message, { code: parsed.code, requestId });
    }
    if (isEntitlementFailureCode(parsed.code)) {
      throw new AiClientError(entitlementFailureMessage(parsed.code, parsed.message), {
        code: parsed.code,
        requestId,
      });
    }
    void import('../observability/report-error').then(({ reportExtensionError }) =>
      reportExtensionError({
        component: 'ai_client',
        event: 'api_request_failed',
        errorCode: parsed.code ?? `HTTP_${response.status}`,
        normalizedMessage: 'AI request failed',
        ...(requestId ? { requestId } : {}),
      }),
    );
    throw new AiClientError(USER_FACING_AI_ERROR, { code: parsed.code, requestId });
  }

  const scope = parseReviewScopeHeader(response.headers.get(PR_REVIEW_SCOPE_HEADER));
  if (scope) {
    onReviewScope?.(scope);
  }
  const memory = parseProjectMemoryHeader(response.headers.get(PROJECT_MEMORY_METADATA_HEADER));
  if (memory) {
    onProjectMemory?.(memory);
  }

  // When streaming via proxy, chunks were already delivered; bodyText is the full payload.
  if (!fullText) {
    fullText = await response.text();
  }

  const trimmed = fullText.trim();
  if (!trimmed) {
    throw new AiClientError(USER_FACING_AI_ERROR);
  }

  return trimmed;
}

export function buildAiRequest(input: {
  action: AIAction;
  text: string;
  customPrompt?: string | null;
  targetLanguage?: string | null;
  context?: PageContext | null;
  errorIntelligence?: ErrorIntelligenceContext | null;
  executionId?: string | null;
  memoryRepository?: string | null;
}): ExecuteAiActionRequest {
  return {
    action: input.action,
    text: input.text,
    customPrompt: input.customPrompt ?? null,
    targetLanguage: input.targetLanguage ?? null,
    context: input.context ?? null,
    errorIntelligence: input.errorIntelligence ?? null,
    ...(input.executionId ? { executionId: input.executionId } : {}),
    ...(input.memoryRepository ? { memoryRepository: input.memoryRepository } : {}),
  };
}
