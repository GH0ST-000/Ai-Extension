import { describe, expect, it } from 'vitest';

import { apiEnvSchema } from './index';

const base = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/projectx?schema=public',
  OPENAI_API_KEY: 'sk-test-not-real',
};

describe('PR review output budget env', () => {
  it('defaults to 4096 tokens and 120s, leaving the global AI settings unchanged', () => {
    const env = apiEnvSchema.parse(base);
    expect(env.AI_PR_REVIEW_MAX_OUTPUT_TOKENS).toBe(4096);
    expect(env.AI_PR_REVIEW_TIMEOUT_MS).toBe(120_000);
    expect(env.AI_MAX_OUTPUT_TOKENS).toBe(600);
    expect(env.AI_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('accepts overrides within bounds', () => {
    const env = apiEnvSchema.parse({
      ...base,
      AI_PR_REVIEW_MAX_OUTPUT_TOKENS: '8000',
      AI_PR_REVIEW_TIMEOUT_MS: '90000',
    });
    expect(env.AI_PR_REVIEW_MAX_OUTPUT_TOKENS).toBe(8000);
    expect(env.AI_PR_REVIEW_TIMEOUT_MS).toBe(90_000);
  });

  it.each([
    ['AI_PR_REVIEW_MAX_OUTPUT_TOKENS', '100'],
    ['AI_PR_REVIEW_MAX_OUTPUT_TOKENS', '50000'],
    ['AI_PR_REVIEW_TIMEOUT_MS', '1000'],
    ['AI_PR_REVIEW_TIMEOUT_MS', '900000'],
  ])('rejects %s=%s', (key, value) => {
    expect(apiEnvSchema.safeParse({ ...base, [key]: value }).success).toBe(false);
  });
});
