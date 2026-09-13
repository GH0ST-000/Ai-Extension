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
  /**
   * AES key material for encrypting per-user secrets (e.g. GitHub PAT).
   * Falls back to JWT_SECRET when omitted (dev only — set explicitly in production).
   */
  TOKEN_ENCRYPTION_KEY: z.string().min(16).optional(),
  /** Public app URL for invite links — never trust request Host. */
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  /** Paddle Merchant of Record — optional in development/test. */
  PADDLE_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  PADDLE_API_KEY: z.string().optional().default(''),
  PADDLE_WEBHOOK_SECRET: z.string().optional().default(''),
  PADDLE_CLIENT_TOKEN: z.string().optional().default(''),
  PADDLE_PRICE_PRO_MONTHLY: z.string().optional().default(''),
  PADDLE_PRICE_PRO_YEARLY: z.string().optional().default(''),
  PADDLE_PRICE_TEAM_MONTHLY: z.string().optional().default(''),
  PADDLE_PRICE_TEAM_YEARLY: z.string().optional().default(''),
  /** Day 26 — stable release id (git SHA or deploy version). Empty → resolved in configuration. */
  APP_RELEASE: z.string().max(128).optional().default(''),
  /** Service name for telemetry. */
  APP_SERVICE: z.string().min(1).max(64).optional().default('api'),
  SENTRY_DSN: z.string().optional().default(''),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional().default(0.1),
  OBSERVABILITY_TRACE_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional().default(0.2),
  /** Protects GET /api/metrics — required in production when set. */
  METRICS_SCRAPE_TOKEN: z.string().optional().default(''),
  /** Protects internal observability endpoints outside development. */
  INTERNAL_OBSERVABILITY_TOKEN: z.string().optional().default(''),
  SLOW_HTTP_MS: z.coerce.number().int().positive().optional().default(5_000),
  SLOW_AI_MS: z.coerce.number().int().positive().optional().default(30_000),
  SLOW_PROVIDER_MS: z.coerce.number().int().positive().optional().default(8_000),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const dashboardEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:3001'),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional().default(''),
  NEXT_PUBLIC_APP_RELEASE: z.string().optional().default(''),
  SENTRY_DSN: z.string().optional().default(''),
  SENTRY_AUTH_TOKEN: z.string().optional().default(''),
  SENTRY_ORG: z.string().optional().default(''),
  SENTRY_PROJECT: z.string().optional().default(''),
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
