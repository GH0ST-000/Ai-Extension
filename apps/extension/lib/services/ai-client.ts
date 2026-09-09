import type { AIAction, ExecuteAiActionRequest, PageContext } from '@project-x/types';

import { USER_FACING_AI_ERROR, USER_FACING_AUTH_ERROR } from '../selection/constants';
import { clearSession, getAccessToken } from './auth-storage';

export class AiClientError extends Error {
  readonly aborted: boolean;
  readonly unauthorized: boolean;

  constructor(
    message: string,
    options?: { aborted?: boolean; unauthorized?: boolean; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'AiClientError';
    this.aborted = options?.aborted ?? false;
    this.unauthorized = options?.unauthorized ?? false;
  }
}

export type StreamAiActionHandlers = {
  onChunk: (chunk: string) => void;
  signal?: AbortSignal;
};

function getApiBaseUrl(): string {
  const configured = process.env.PLASMO_PUBLIC_API_URL?.trim();
  return (configured && configured.length > 0 ? configured : 'http://localhost:3001').replace(
    /\/$/,
    '',
  );
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
  try {
    response = await fetch(`${getApiBaseUrl()}/api/ai/actions/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/plain',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(request),
      signal,
    });
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
    throw new AiClientError(USER_FACING_AI_ERROR);
  }

  if (!response.body) {
    throw new AiClientError(USER_FACING_AI_ERROR);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      if (!chunk) {
        continue;
      }

      fullText += chunk;
      onChunk(chunk);
    }

    fullText += decoder.decode();
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw new AiClientError('Request cancelled', { aborted: true, cause: error });
    }
    throw new AiClientError(USER_FACING_AI_ERROR, { cause: error });
  } finally {
    reader.releaseLock();
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
}): ExecuteAiActionRequest {
  return {
    action: input.action,
    text: input.text,
    customPrompt: input.customPrompt ?? null,
    targetLanguage: input.targetLanguage ?? null,
    context: input.context ?? null,
  };
}
