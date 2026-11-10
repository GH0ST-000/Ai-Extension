import { UnprocessableEntityException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIAction } from '@project-x/types';

import { AiService } from '../ai.service';
import { PromptRegistry } from '../prompts/prompt.registry';

const generateTextMock = vi.fn();
const streamTextMock = vi.fn();

vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
  streamText: (...args: unknown[]) => streamTextMock(...args),
}));

const SCOPE = {
  source: 'github_api' as const,
  totalFiles: 3,
  analyzedFiles: 2,
  skippedFiles: 1,
  truncated: true,
};

function fakeResponse() {
  const headers: Record<string, string> = {};
  let body = '';
  const res = {
    statusCode: 0,
    writableEnded: false,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    write: (chunk: string) => {
      body += chunk;
      return true;
    },
    end: () => {
      res.writableEnded = true;
    },
  };
  return { res, headers, body: () => body };
}

async function* parts(list: unknown[]) {
  for (const part of list) yield part;
}

describe('REVIEW_ENTIRE_PR flow in AiService', () => {
  const usage = { consume: vi.fn() };
  const diff = { resolve: vi.fn() };
  let service: AiService;

  const input = {
    action: AIAction.REVIEW_ENTIRE_PR,
    text: 'Review this PR.',
    context: {
      type: 'github',
      url: 'https://github.com/acme/app/pull/48',
      title: 'PR',
      github: { owner: 'acme', repository: 'app', pullRequestNumber: 48 },
    },
  } as never;

  beforeEach(() => {
    generateTextMock.mockReset();
    streamTextMock.mockReset();
    usage.consume.mockReset().mockResolvedValue({ allowed: true });
    diff.resolve.mockReset().mockResolvedValue({
      changedFiles: [
        { path: 'src/memory.service.ts', patchExcerpt: '+if (!ws) return [];' },
        { path: 'src/archive.ts', patchExcerpt: '-status: "archived"' },
        { path: 'pnpm-lock.yaml' },
      ],
      scope: SCOPE,
      pullRequestTitle: 'Memory fixes',
    });
    service = build();
  });

  function build(
    aiConfig: Record<string, unknown> = { requestTimeoutMs: 1000, maxInputCharacters: 20_000 },
    projectMemory?: unknown,
  ): AiService {
    return new AiService(
      new PromptRegistry(),
      {
        getDefaultModel: vi.fn(),
        getProviderName: () => 'openai',
        getModelName: () => 'm',
      } as never,
      { get: () => aiConfig } as never,
      {
        getForUser: vi.fn(async () => ({
          maxOutputTokens: 600,
          responseStyle: 'CONCISE',
          includePageContext: true,
        })),
      } as never,
      {
        user: { findUnique: vi.fn().mockResolvedValue(null) },
        workspaceMembership: { findFirst: vi.fn().mockResolvedValue(null) },
      } as never,
      { require: vi.fn().mockResolvedValue(undefined) } as never,
      usage as never,
      {
        createOperationId: () => 'op',
        observeGenerate: async ({ call }: { call: () => Promise<{ result: string }> }) => ({
          result: (await call()).result,
          observation: { usage: {}, cost: { source: 'unavailable' }, durationMs: 1 },
        }),
        recordStreamSuccess: vi.fn(() => ({ usage: {}, cost: {}, durationMs: 1 })),
        recordStreamFailure: vi.fn(),
      } as never,
      { get: () => ({}), patch: vi.fn() } as never,
      { recordSignal: vi.fn() } as never,
      undefined,
      projectMemory as never,
      diff as never,
    );
  }

  const lastGenerateCall = () =>
    generateTextMock.mock.calls.at(-1)![0] as { maxOutputTokens: number; timeout: number };

  describe('output budget (fix 6)', () => {
    it('uses the PR review default budget and timeout, not the 600-token user setting', async () => {
      generateTextMock.mockResolvedValueOnce({ text: '## Summary\nok', finishReason: 'stop' });
      await service.generateAction('u1', input);
      expect(lastGenerateCall()).toMatchObject({ maxOutputTokens: 4096, timeout: 120_000 });
    });

    it('uses the configured PR review budget and never lowers the global timeout', async () => {
      service = build({
        requestTimeoutMs: 200_000,
        maxInputCharacters: 20_000,
        prReview: { maxOutputTokens: 8000, requestTimeoutMs: 90_000 },
      });
      generateTextMock.mockResolvedValueOnce({ text: '## Summary\nok', finishReason: 'stop' });
      await service.generateAction('u1', input);
      expect(lastGenerateCall()).toMatchObject({ maxOutputTokens: 8000, timeout: 200_000 });
    });

    it('leaves other actions on the user setting and the global timeout', async () => {
      service = build({
        requestTimeoutMs: 30_000,
        maxInputCharacters: 20_000,
        prReview: { maxOutputTokens: 8000, requestTimeoutMs: 90_000 },
      });
      generateTextMock.mockResolvedValueOnce({ text: 'explained', finishReason: 'stop' });
      await service.generateAction('u1', {
        action: AIAction.EXPLAIN_CODE,
        text: 'const a = 1;',
      } as never);
      expect(lastGenerateCall()).toMatchObject({ maxOutputTokens: 600, timeout: 30_000 });
      expect(diff.resolve).not.toHaveBeenCalled();
    });

    it('still consumes exactly one usage unit per PR review (quota unchanged)', async () => {
      generateTextMock.mockResolvedValueOnce({ text: '## Summary\nok', finishReason: 'stop' });
      await service.generateAction('u1', input);
      expect(usage.consume).toHaveBeenCalledTimes(1);
      expect(usage.consume.mock.calls[0]![0]).toMatchObject({ quantity: 1 });
    });
  });

  describe('memory metadata on the stream (fix 5)', () => {
    it('sends the applied rules in X-Project-Memory as base64url JSON', async () => {
      const rules = [
        {
          id: 'mem-1',
          key: 'rule.isolation',
          category: 'SECURITY_CONVENTION',
          title: 'Verify workspace isolation — სამუშაო სივრცე',
          confidence: 'high',
          visibility: 'workspace',
        },
      ];
      const projectMemory = {
        resolvePromptContext: vi.fn(async () => ({
          status: 'applied',
          block: '<<PROJECT_MEMORY source="server" version="v1">>\n- rule\n<</PROJECT_MEMORY>>',
          version: 'v1',
          rules,
          diagnostics: { activeRules: 1, safeRules: 1, selectedRules: 1 },
        })),
      };
      service = build(undefined, projectMemory);
      streamTextMock.mockReturnValueOnce({
        stream: parts([
          { type: 'text-delta', text: '## Summary\nfine' },
          { type: 'finish', finishReason: 'stop' },
        ]),
      });
      const { res, headers } = fakeResponse();
      await service.pipeActionStream('u1', input, res as never);

      const decoded = JSON.parse(
        Buffer.from(headers['x-project-memory']!, 'base64url').toString('utf8'),
      );
      expect(decoded).toEqual({ status: 'applied', version: 'v1', rules });
      expect(headers['x-project-memory']).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('sends the skip reason when no memory was applied', async () => {
      service = build(undefined, {
        resolvePromptContext: vi.fn(async () => ({
          status: 'skipped',
          reason: 'github_not_connected',
          diagnostics: { activeRules: 0, safeRules: 0, selectedRules: 0 },
        })),
      });
      streamTextMock.mockReturnValueOnce({
        stream: parts([
          { type: 'text-delta', text: '## Summary\nfine' },
          { type: 'finish', finishReason: 'stop' },
        ]),
      });
      const { res, headers } = fakeResponse();
      await service.pipeActionStream('u1', input, res as never);
      expect(
        JSON.parse(Buffer.from(headers['x-project-memory']!, 'base64url').toString('utf8')),
      ).toEqual({ status: 'skipped', reason: 'github_not_connected' });
    });
  });

  it('sends the GitHub API diff (not page files) to the model', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: '## Summary\nok',
      finishReason: 'stop',
      usage: {},
    });
    await service.generateAction('u1', input);

    expect(diff.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', repository: 'app', pullRequestNumber: 48 }),
    );
    const content = generateTextMock.mock.calls[0]![0].messages[0].content as string;
    expect(content).toContain('file1:src/memory.service.ts\n+if (!ws) return [];');
    expect(content).toContain('files:3');
    expect(content).toContain('filesTotal:3');
    expect(content).toContain('filesSource:github_api');
    expect(content).toContain('filesTruncated:1');
  });

  it('does not call the AI or consume usage when no diff is available', async () => {
    diff.resolve.mockRejectedValueOnce(
      new UnprocessableEntityException({ code: 'PR_DIFF_UNAVAILABLE', message: 'no diff' }),
    );
    await expect(service.generateAction('u1', input)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(usage.consume).not.toHaveBeenCalled();
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('marks a generate result cut off by the token limit as incomplete', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: '## Summary\nThis PR changes',
      finishReason: 'length',
      usage: {},
    });
    const out = await service.generateAction('u1', input);
    expect(out).toMatch(/\[\[px:review-incomplete reason=length\]\]$/);
  });

  it('streams with the scope header and no trailer when the model finishes', async () => {
    streamTextMock.mockReturnValueOnce({
      stream: parts([
        { type: 'text-delta', text: '## Summary\nfine' },
        { type: 'finish', finishReason: 'stop' },
      ]),
    });
    const { res, headers, body } = fakeResponse();
    await service.pipeActionStream('u1', input, res as never);

    expect(JSON.parse(headers['x-pr-review-scope']!)).toEqual(SCOPE);
    expect(body()).toBe('## Summary\nfine');
    expect(res.writableEnded).toBe(true);
  });

  it('appends the incomplete trailer when the stream hits the token limit or errors', async () => {
    streamTextMock.mockReturnValueOnce({
      stream: parts([
        { type: 'text-delta', text: '## Summary\nThis PR' },
        { type: 'finish', finishReason: 'length' },
      ]),
    });
    const a = fakeResponse();
    await service.pipeActionStream('u1', input, a.res as never);
    expect(a.body()).toMatch(/reason=length\]\]$/);

    streamTextMock.mockReturnValueOnce({
      stream: parts([
        { type: 'text-delta', text: '## Summary' },
        { type: 'error', error: new Error('x') },
      ]),
    });
    const b = fakeResponse();
    await service.pipeActionStream('u1', input, b.res as never);
    expect(b.body()).toMatch(/reason=error\]\]$/);
  });

  it('fails with 503 instead of an empty 200 when nothing was streamed', async () => {
    streamTextMock.mockReturnValueOnce({
      stream: parts([{ type: 'error', error: new Error('x') }]),
    });
    const { res } = fakeResponse();
    await expect(service.pipeActionStream('u1', input, res as never)).rejects.toThrow(
      'Unable to generate a response.',
    );
  });
});
