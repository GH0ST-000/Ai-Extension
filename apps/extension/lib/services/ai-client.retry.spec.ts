/**
 * Lost-response retries: the client remembers the server operation id of a stream that was
 * cut off and sends it as `retryOperationId` when the same request is retried, so the server
 * can replay a completed result without a new AI call or charge.
 */
import { AIAction, type ExecuteAiActionRequest } from '@project-x/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const streamMock = vi.fn();
vi.mock('../api/background-http', () => ({
  extensionApiStream: (...args: unknown[]) => streamMock(...args),
}));
vi.mock('./auth-storage', () => ({
  hasAuthSession: async () => true,
  clearSessionStorageOnly: async () => undefined,
}));

import {
  AiClientError,
  OPERATION_RETRY_WINDOW_MS,
  pendingRetryOperationId,
  resetUnfinishedOperations,
  streamAiAction,
} from './ai-client';

const OP = '6f1c1b2e-6d2b-4c4f-9f55-0a1b2c3d4e5f';
const request: ExecuteAiActionRequest = { action: AIAction.EXPLAIN, text: 'Explain this' };
const sentBody = (call: number) =>
  JSON.parse((streamMock.mock.calls[call]![1] as { body: string }).body) as Record<string, unknown>;

/** A stream that announces `operationId`, emits `chunks`, then completes or fails. */
function stream(opts: {
  operationId?: string;
  chunks?: string[];
  fail?: boolean;
  status?: number;
}) {
  streamMock.mockImplementationOnce(
    async (
      _path: string,
      _init: unknown,
      onChunk: (c: string) => void,
      _signal: unknown,
      onHeaders?: (h: Headers) => void,
    ) => {
      const status = opts.status ?? 200;
      if (status === 200) {
        onHeaders?.(new Headers(opts.operationId ? { 'x-ai-operation-id': opts.operationId } : {}));
      }
      for (const c of opts.chunks ?? []) onChunk(c);
      if (opts.fail) throw new TypeError('network error');
      if (status !== 200) {
        return new Response(JSON.stringify({ code: 'AI_OPERATION_IN_PROGRESS', message: 'x' }), {
          status,
        });
      }
      return new Response((opts.chunks ?? []).join(''), { status: 200 });
    },
  );
}

const handlers = { onChunk: () => undefined };

describe('AI client lost-response retries', () => {
  beforeEach(() => {
    streamMock.mockReset();
    resetUnfinishedOperations();
  });

  it('a completed request leaves nothing to retry (the next request is a new operation)', async () => {
    stream({ operationId: OP, chunks: ['done'] });
    expect(await streamAiAction(request, handlers)).toBe('done');
    expect(pendingRetryOperationId(request)).toBeUndefined();
    stream({ operationId: 'b' + OP.slice(1), chunks: ['again'] });
    await streamAiAction(request, handlers);
    expect(sentBody(1).retryOperationId).toBeUndefined();
  });

  it('a stream cut off after it started is retried with its operation id', async () => {
    stream({ operationId: OP, chunks: ['partial'], fail: true });
    await expect(streamAiAction(request, handlers)).rejects.toBeInstanceOf(AiClientError);
    expect(pendingRetryOperationId(request)).toBe(OP);

    stream({ operationId: OP, chunks: ['the full answer'] }); // replayed by the server
    expect(await streamAiAction(request, handlers)).toBe('the full answer');
    expect(sentBody(1).retryOperationId).toBe(OP);
    expect(pendingRetryOperationId(request)).toBeUndefined();
  });

  it('only the identical request carries the id, and never after the retry window', async () => {
    stream({ operationId: OP, fail: true });
    await expect(streamAiAction(request, handlers)).rejects.toBeTruthy();
    expect(pendingRetryOperationId({ ...request, text: 'Something else' })).toBeUndefined();
    expect(pendingRetryOperationId(request, Date.now() + OPERATION_RETRY_WINDOW_MS + 1)).toBe(
      undefined,
    );
  });

  it('a request that failed before the server answered has no operation to recover', async () => {
    streamMock.mockRejectedValueOnce(new TypeError('offline'));
    await expect(streamAiAction(request, handlers)).rejects.toBeTruthy();
    expect(pendingRetryOperationId(request)).toBeUndefined();
  });

  it('AI_OPERATION_IN_PROGRESS keeps the id for a later retry and explains the wait', async () => {
    stream({ operationId: OP, fail: true });
    await expect(streamAiAction(request, handlers)).rejects.toBeTruthy();
    stream({ status: 409 });
    const error = await streamAiAction(request, handlers).catch((e: AiClientError) => e);
    expect(error).toMatchObject({ code: 'AI_OPERATION_IN_PROGRESS' });
    expect((error as Error).message).toMatch(/still running/);
    expect(pendingRetryOperationId(request)).toBe(OP);
  });

  it('reports the server operation id to the caller (used to confirm the saved history)', async () => {
    const seen: string[] = [];
    stream({ operationId: OP, chunks: ['done'] });
    await streamAiAction(request, {
      onChunk: () => undefined,
      onOperationId: (id) => seen.push(id),
    });
    expect(seen).toEqual([OP]);
    stream({ chunks: ['no id'] });
    await streamAiAction(request, {
      onChunk: () => undefined,
      onOperationId: (id) => seen.push(id),
    });
    expect(seen).toEqual([OP]);
  });
});
