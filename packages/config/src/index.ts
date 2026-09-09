import { z } from 'zod';

export const nodeEnvSchema = z.enum(['development', 'test', 'production']);

export const aiProviderSchema = z.enum(['openai']);

export const apiEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  AI_PROVIDER: aiProviderSchema.default('openai'),
  AI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_API_KEY: z.string().min(1),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(600),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  AI_MAX_INPUT_CHARACTERS: z.coerce.number().int().positive().default(12_000),
  AI_CORS_ORIGINS: z.string().optional().default(''),
  JWT_SECRET: z.string().min(16).default('project-x-dev-jwt-secret-change-me'),
  JWT_EXPIRES_IN: z.string().min(1).default('7d'),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const dashboardEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:3001'),
});

export type DashboardEnv = z.infer<typeof dashboardEnvSchema>;

/**
 * Parse and validate a record of environment variables.
 * Throws a readable Zod error when validation fails.
 */
export function parseEnv<T extends z.ZodTypeAny>(
  schema: T,
  env: Record<string, string | undefined>,
): z.infer<T> {
  return schema.parse(env);
}
