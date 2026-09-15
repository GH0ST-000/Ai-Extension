import type {
  AIAction,
  ErrorIntelligenceContext,
  ExecuteAiActionRequest,
  PageContext,
  WorkspaceErrorBody,
  WorkspaceErrorCode,
} from '@project-x/types';

import { extensionApiStream } from '../api/background-http';
import { USER_FACING_AI_ERROR, USER_FACING_AUTH_ERROR } from '../selection/constants';
import { entitlementFailureMessage, isEntitlementFailureCode } from '../workspace/entitlement';
import { clearSession, getAccessToken } from './auth-storage';

export class AiClientError extends Error {
  readonly aborted: boolean;
  readonly unauthorized: boolean;
  readonly code: WorkspaceErrorCode | null;
  readonly requestId: string | null;

  constructor(
    message: string,
    options?: {
      aborted?: boolean;
      unauthorized?: boolean;
      code?: WorkspaceErrorCode | null;
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
};

async function parseAiError(response: Response): Promise<{
  message: string;
  code: WorkspaceErrorCode | null;
}> {
  try {
    const body = (await response.json()) as {
      message?: string | string[] | WorkspaceErrorBody;
      code?: WorkspaceErrorCode;
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
  const { onChunk, signal } = handlers;
  const accessToken = await getAccessToken();

  if (!accessToken) {
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
    await clearSession();
    throw new AiClientError(USER_FACING_AUTH_ERROR, { unauthorized: true });
  }

  if (!response.ok) {
    const requestId = response.headers.get('x-request-id');
    const parsed = await parseAiError(response);
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
}): ExecuteAiActionRequest {
  return {
    action: input.action,
    text: input.text,
    customPrompt: input.customPrompt ?? null,
    targetLanguage: input.targetLanguage ?? null,
    context: input.context ?? null,
    errorIntelligence: input.errorIntelligence ?? null,
    ...(input.executionId ? { executionId: input.executionId } : {}),
  };
}
