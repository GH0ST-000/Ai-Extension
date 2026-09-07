import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';

import type { ApiConfig } from '../config/configuration';
import { AiModelFactory } from './models/ai-model.factory';

const createOpenAIMock = vi.fn();

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: (...args: unknown[]) => createOpenAIMock(...args),
}));

describe('AiModelFactory', () => {
  beforeEach(() => {
    createOpenAIMock.mockReset();
    createOpenAIMock.mockReturnValue((model: string) => ({ modelId: model }));
  });

  it('creates an OpenAI model from configuration', () => {
    const config = {
      get: vi.fn(() => ({
        provider: 'openai',
        model: 'gpt-4o-mini',
        openaiApiKey: 'sk-test',
        maxOutputTokens: 1000,
        requestTimeoutMs: 30_000,
        maxInputCharacters: 20_000,
        corsOrigins: [],
      })),
    } as unknown as ConfigService<ApiConfig, true>;

    const factory = new AiModelFactory(config);
    expect(factory.getProviderName()).toBe('openai');
    expect(factory.getModelName()).toBe('gpt-4o-mini');
    expect(factory.getDefaultModel()).toEqual({ modelId: 'gpt-4o-mini' });
    expect(createOpenAIMock).toHaveBeenCalledWith({ apiKey: 'sk-test' });
  });

  it('rejects unsupported providers', () => {
    const config = {
      get: vi.fn(() => ({
        provider: 'anthropic',
        model: 'claude',
        openaiApiKey: 'sk-test',
        maxOutputTokens: 1000,
        requestTimeoutMs: 30_000,
        maxInputCharacters: 20_000,
        corsOrigins: [],
      })),
    } as unknown as ConfigService<ApiConfig, true>;

    expect(() => new AiModelFactory(config)).toThrow(ServiceUnavailableException);
  });
});
