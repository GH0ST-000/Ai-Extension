import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIAction } from '@project-x/types';
import { ConfigService } from '@nestjs/config';

import type { ApiConfig } from '../config/configuration';
import type { SettingsService } from '../settings/settings.service';
import { AiService } from './ai.service';
import { PromptRegistry } from './prompts/prompt.registry';
import type { AiModelFactory } from './models/ai-model.factory';

const generateTextMock = vi.fn();
const streamTextMock = vi.fn();

vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
  streamText: (...args: unknown[]) => streamTextMock(...args),
}));

describe('AiService', () => {
  const promptRegistry = new PromptRegistry();
  const modelFactory = {
    getDefaultModel: vi.fn(() => ({ provider: 'mock-model' })),
    getProviderName: vi.fn(() => 'openai'),
    getModelName: vi.fn(() => 'gpt-4o-mini'),
  } as unknown as AiModelFactory;

  const config = {
    get: vi.fn((key: string) => {
      if (key === 'ai') {
        return {
          provider: 'openai',
          model: 'gpt-4o-mini',
          openaiApiKey: 'test-key',
          maxOutputTokens: 1000,
          requestTimeoutMs: 30_000,
          maxInputCharacters: 20_000,
          corsOrigins: [],
        };
      }
      return undefined;
    }),
  } as unknown as ConfigService<ApiConfig, true>;

  const settingsService = {
    getForUser: vi.fn(async () => ({
      maxOutputTokens: 600,
      responseStyle: 'CONCISE' as const,
      includePageContext: true,
    })),
  } as unknown as SettingsService;

  let service: AiService;

  beforeEach(() => {
    generateTextMock.mockReset();
    streamTextMock.mockReset();
    vi.mocked(settingsService.getForUser).mockClear();
    service = new AiService(promptRegistry, modelFactory, config, settingsService);
  });

  it('delegates generateAction to model factory and prompt registry', async () => {
    generateTextMock.mockResolvedValue({ text: '  Explained text  ' });

    const result = await service.generateAction('user-1', {
      action: AIAction.EXPLAIN,
      text: 'Hello',
    });

    expect(result).toBe('Explained text');
    expect(settingsService.getForUser).toHaveBeenCalledWith('user-1');
    expect(modelFactory.getDefaultModel).toHaveBeenCalled();
    expect(generateTextMock).toHaveBeenCalledOnce();
    const call = generateTextMock.mock.calls[0]?.[0] as {
      messages: unknown[];
      instructions: string;
      model: unknown;
      maxOutputTokens: number;
    };
    expect(call.model).toEqual({ provider: 'mock-model' });
    expect(typeof call.instructions).toBe('string');
    expect(call.instructions).toContain('keep answers short');
    expect(call.maxOutputTokens).toBe(600);
    expect(Array.isArray(call.messages)).toBe(true);
  });

  it('strips page context when includePageContext is false', async () => {
    vi.mocked(settingsService.getForUser).mockResolvedValueOnce({
      maxOutputTokens: 400,
      responseStyle: 'BALANCED',
      includePageContext: false,
    });
    generateTextMock.mockResolvedValue({ text: 'ok' });

    await service.generateAction('user-1', {
      action: AIAction.EXPLAIN,
      text: 'Hello',
      context: {
        type: 'generic',
        url: 'https://example.com',
        title: 'Example',
      },
    });

    const call = generateTextMock.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
      maxOutputTokens: number;
    };
    expect(call.maxOutputTokens).toBe(400);
    expect(call.messages[0]?.content).not.toContain('<<CTX>>');
  });

  it('maps empty provider output to a safe error', async () => {
    generateTextMock.mockResolvedValue({ text: '   ' });

    await expect(
      service.generateAction('user-1', {
        action: AIAction.SUMMARIZE,
        text: 'Hello',
      }),
    ).rejects.toMatchObject({
      message: 'Unable to generate a response.',
    });
  });

  it('maps provider failures to a safe error', async () => {
    generateTextMock.mockRejectedValue(new Error('provider exploded'));

    await expect(
      service.generateAction('user-1', {
        action: AIAction.SUMMARIZE,
        text: 'Hello',
      }),
    ).rejects.toMatchObject({
      message: 'Unable to generate a response.',
    });
  });

  it('creates a stream handle via streamText', async () => {
    streamTextMock.mockReturnValue({
      pipeTextStreamToResponse: vi.fn(),
    });

    const handle = await service.streamAction('user-1', {
      action: AIAction.EXPLAIN,
      text: 'Hello',
    });

    expect(handle.pipeTextStreamToResponse).toBeTypeOf('function');
    expect(streamTextMock).toHaveBeenCalledOnce();
  });
});
