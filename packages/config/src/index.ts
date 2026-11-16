import { z } from 'zod';

import {
  databaseUrlUsesTls,
  isLocalDatabaseHost,
  isLocalRedisHost,
  postgresHostFromDatabaseUrl,
} from './database-url';

export {
  applyDatabaseSslFlag,
  databaseUrlUsesTls,
  isLocalDatabaseHost,
  isLocalRedisHost,
  postgresHostFromDatabaseUrl,
} from './database-url';

export const nodeEnvSchema = z.enum(['development', 'test', 'production']);

export const aiProviderSchema = z.enum(['openai']);

/** Known insecure defaults — production must never accept these. */
export const INSECURE_JWT_DEFAULTS = new Set([
  'project-x-dev-jwt-secret-change-me',
  'changeme',
  'secret',
  'jwt-secret',
]);

export const INSECURE_ENCRYPTION_DEFAULTS = new Set([
  'project-x-dev-token-encryption-key',
  'changeme',
  'encryption-key',
]);

function envBoolean(defaultValue = false) {
  return z.preprocess((val) => {
    if (val === undefined || val === null || val === '') {
      return defaultValue;
    }
    if (typeof val === 'boolean') {
      return val;
    }
    const normalized = String(val).trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') {
      return true;
    }
    if (normalized === 'false' || normalized === '0') {
      return false;
    }
    return val;
  }, z.boolean());
}

export const apiEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),
  /** Enable TLS when connecting to Redis (managed cloud Redis). */
  REDIS_TLS: envBoolean(false),
  /** When true, append sslmode=require to DATABASE_URL if not already set. */
  DATABASE_SSL: envBoolean(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  AI_PROVIDER: aiProviderSchema.default('openai'),
  AI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_API_KEY: z.string().min(1),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(600),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * Output-token budget for REVIEW_ENTIRE_PR only (other actions keep the per-user setting,
   * 150–2000). A multi-file review with numbered findings does not fit in 600 tokens.
   * Upper bound is gpt-4o-mini's 16,384 max output; usage quotas are per action, unaffected.
   */
  AI_PR_REVIEW_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(500).max(16_384).default(4_096),
  /** Request timeout for REVIEW_ENTIRE_PR; the 30s default is too short for ~4k output tokens. */
  AI_PR_REVIEW_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(300_000).default(120_000),
  /**
   * Batched PR review cost ceilings (one review = one usage unit regardless of batches).
   * AI_PR_REVIEW_MAX_OUTPUT_TOKENS above is the per-batch output budget. Hard maxima here are
   * also enforced in code, so no configuration can make a review unbounded.
   */
  AI_PR_REVIEW_MAX_BATCHES: z.coerce.number().int().min(1).max(12).default(6),
  AI_PR_REVIEW_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(6).default(3),
  /** Estimated input tokens per batch (prompt + diffs). */
  AI_PR_REVIEW_BATCH_INPUT_TOKENS: z.coerce.number().int().min(2_000).max(60_000).default(16_000),
  /** Estimated input tokens per review, across all batches. */
  AI_PR_REVIEW_MAX_INPUT_TOKENS: z.coerce.number().int().min(2_000).max(400_000).default(96_000),
  /** Output tokens per review, across all batches. */
  AI_PR_REVIEW_MAX_TOTAL_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .min(500)
    .max(100_000)
    .default(24_576),
  /** Whole-review deadline; batches still running are cancelled. */
  AI_PR_REVIEW_TOTAL_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(240_000),
  /**
   * Independent verification of MEDIUM/HIGH finding candidates (bounded; no retries). Total
   * verification cost per review ≤ MAX_VERIFICATIONS × (VERIFY_INPUT + VERIFY_OUTPUT) tokens.
   */
  AI_PR_REVIEW_MAX_VERIFICATIONS: z.coerce.number().int().min(0).max(24).default(10),
  AI_PR_REVIEW_VERIFY_INPUT_TOKENS: z.coerce.number().int().min(2_000).max(20_000).default(6_000),
  AI_PR_REVIEW_VERIFY_OUTPUT_TOKENS: z.coerce.number().int().min(300).max(4_000).default(800),
  /** Files fetched at the PR head for read-only code context, per review. */
  AI_PR_REVIEW_MAX_CONTEXT_FILES: z.coerce.number().int().min(0).max(30).default(12),
  AI_MAX_INPUT_CHARACTERS: z.coerce.number().int().positive().default(12_000),
  /** Comma-separated exact origins (dashboard + chrome-extension://ID). */
  AI_CORS_ORIGINS: z.string().optional().default(''),
  /**
   * Exact page origins used by extension content scripts (e.g. https://github.com).
   * Content scripts inherit the host page Origin, not chrome-extension://.
   */
  AI_CORS_CONTENT_SCRIPT_ORIGINS: z.string().optional().default(''),
  JWT_SECRET: z.string().min(16).default('project-x-dev-jwt-secret-change-me'),
  /** Prefer short-lived access tokens (refresh tokens renew the session). */
  JWT_EXPIRES_IN: z.string().min(1).default('15m'),
  /** Opaque refresh token lifetime. */
  JWT_REFRESH_EXPIRES_IN: z.string().min(1).default('7d'),
  /**
   * AES key material for encrypting per-user secrets (e.g. GitHub PAT).
   * Required in production — must not fall back to JWT_SECRET.
   */
  TOKEN_ENCRYPTION_KEY: z.string().min(16).optional(),
  /** Public app URL for invite links — never trust request Host. */
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  /**
   * Transactional email (Resend). Both empty = email disabled: password reset requests are
   * accepted but no email is sent (logged as mail_not_configured). Never logged.
   */
  RESEND_API_KEY: z.string().optional().default(''),
  /** Verified sender, e.g. `Project X <no-reply@mail.example.com>`. */
  MAIL_FROM: z.string().max(320).optional().default(''),
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
  /** Protects GET /api/metrics — required in production. */
  METRICS_SCRAPE_TOKEN: z.string().optional().default(''),
  /** Protects internal observability endpoints — required in production. */
  INTERNAL_OBSERVABILITY_TOKEN: z.string().optional().default(''),
  /** Protects deep dependency health outside development — required in production. */
  HEALTH_DETAILS_TOKEN: z.string().optional().default(''),
  SLOW_HTTP_MS: z.coerce.number().int().positive().optional().default(5_000),
  SLOW_AI_MS: z.coerce.number().int().positive().optional().default(30_000),
  SLOW_PROVIDER_MS: z.coerce.number().int().positive().optional().default(8_000),
  /** JSON body size limit in bytes (default 1 MiB). */
  API_JSON_BODY_LIMIT_BYTES: z.coerce.number().int().positive().optional().default(1_048_576),
  /** Max pagination page size for list endpoints. */
  API_MAX_PAGE_SIZE: z.coerce.number().int().positive().max(200).optional().default(100),
  /** GitHub App (workspace installation) — optional in development; all-or-nothing in production when any is set. */
  GITHUB_APP_ID: z.string().optional().default(''),
  /** PEM private key; use literal newlines or \\n escapes in env. */
  GITHUB_APP_PRIVATE_KEY: z.string().optional().default(''),
  GITHUB_APP_WEBHOOK_SECRET: z.string().optional().default(''),
  GITHUB_APP_SLUG: z.string().optional().default(''),
  /** Optional — user-to-server OAuth (both required if either is set). */
  GITHUB_APP_CLIENT_ID: z.string().optional().default(''),
  GITHUB_APP_CLIENT_SECRET: z.string().optional().default(''),
  /** Enterprise SSO — optional; unused until SsoModule is implemented (see docs/security/sso-scim.md). */
  SSO_ENABLED: envBoolean(false),
  SAML_ENTRY_POINT: z.string().optional().default(''),
  SAML_ISSUER: z.string().optional().default(''),
  SAML_CALLBACK_URL: z.string().optional().default(''),
  /** IdP signing certificate (PEM). */
  SAML_IDP_CERT: z.string().optional().default(''),
  /** SCIM provisioning bearer token (future). */
  SCIM_BEARER_TOKEN: z.string().optional().default(''),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

const GITHUB_APP_REQUIRED_KEYS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_WEBHOOK_SECRET',
  'GITHUB_APP_SLUG',
] as const satisfies readonly (keyof ApiEnv)[];

function envFieldSet(env: ApiEnv, key: keyof ApiEnv): boolean {
  const raw = env[key];
  return typeof raw === 'string' && raw.trim().length > 0;
}

/** True when every required GitHub App env var is non-empty. */
export function isGitHubAppFullyConfigured(env: ApiEnv): boolean {
  return GITHUB_APP_REQUIRED_KEYS.every((key) => envFieldSet(env, key));
}

/** True when any GitHub App env var (required or optional OAuth pair) is non-empty. */
export function isGitHubAppPartiallyConfigured(env: ApiEnv): boolean {
  if (GITHUB_APP_REQUIRED_KEYS.some((key) => envFieldSet(env, key))) {
    return true;
  }
  return envFieldSet(env, 'GITHUB_APP_CLIENT_ID') || envFieldSet(env, 'GITHUB_APP_CLIENT_SECRET');
}

export function collectGitHubAppConfigIssues(env: ApiEnv): ProductionSecurityIssue[] {
  const issues: ProductionSecurityIssue[] = [];

  if (!isGitHubAppPartiallyConfigured(env)) {
    return issues;
  }

  for (const key of GITHUB_APP_REQUIRED_KEYS) {
    if (!envFieldSet(env, key)) {
      issues.push({
        code: 'GITHUB_APP_PARTIAL_CONFIG',
        message: `When GitHub App integration is enabled, ${key} must be set (all of GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_WEBHOOK_SECRET, GITHUB_APP_SLUG are required).`,
      });
    }
  }

  const hasClientId = envFieldSet(env, 'GITHUB_APP_CLIENT_ID');
  const hasClientSecret = envFieldSet(env, 'GITHUB_APP_CLIENT_SECRET');
  if (hasClientId !== hasClientSecret) {
    issues.push({
      code: 'GITHUB_APP_OAUTH_PAIR',
      message:
        'GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET must both be set or both omitted.',
    });
  }

  if (env.NODE_ENV === 'production' && isGitHubAppPartiallyConfigured(env)) {
    if (env.GITHUB_APP_WEBHOOK_SECRET === 'dev-github-app-webhook-secret') {
      issues.push({
        code: 'GITHUB_APP_WEBHOOK_SECRET_DEFAULT',
        message: 'GITHUB_APP_WEBHOOK_SECRET must not use the development default in production.',
      });
    }
    if (
      env.GITHUB_APP_WEBHOOK_SECRET.trim().length > 0 &&
      env.GITHUB_APP_WEBHOOK_SECRET.length < 16
    ) {
      issues.push({
        code: 'GITHUB_APP_WEBHOOK_SECRET_WEAK',
        message: 'GITHUB_APP_WEBHOOK_SECRET must be at least 16 characters in production.',
      });
    }
  }

  return issues;
}

export const dashboardEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:3001'),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional().default(''),
  NEXT_PUBLIC_APP_RELEASE: z.string().optional().default(''),
  NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: z.string().optional().default(''),
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

function parseOriginList(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export type ProductionSecurityIssue = {
  code: string;
  message: string;
};

/**
 * Fail-closed production configuration checks.
 * Call after Zod parse; throws aggregated Error on any issue.
 */
export function collectProductionSecurityIssues(env: ApiEnv): ProductionSecurityIssue[] {
  if (env.NODE_ENV !== 'production') {
    return [];
  }

  const issues: ProductionSecurityIssue[] = [];

  if (INSECURE_JWT_DEFAULTS.has(env.JWT_SECRET) || env.JWT_SECRET.length < 32) {
    issues.push({
      code: 'JWT_SECRET_INSECURE',
      message: 'JWT_SECRET must be a unique secret of at least 32 characters in production.',
    });
  }

  const encryptionKey = env.TOKEN_ENCRYPTION_KEY?.trim() ?? '';
  if (
    !encryptionKey ||
    encryptionKey.length < 32 ||
    INSECURE_ENCRYPTION_DEFAULTS.has(encryptionKey)
  ) {
    issues.push({
      code: 'TOKEN_ENCRYPTION_KEY_REQUIRED',
      message:
        'TOKEN_ENCRYPTION_KEY must be set to a unique secret (≥32 chars) in production and must not use the development default.',
    });
  }

  if (encryptionKey && encryptionKey === env.JWT_SECRET) {
    issues.push({
      code: 'TOKEN_ENCRYPTION_KEY_SAME_AS_JWT',
      message: 'TOKEN_ENCRYPTION_KEY must differ from JWT_SECRET in production.',
    });
  }

  const corsOrigins = parseOriginList(env.AI_CORS_ORIGINS);
  if (corsOrigins.length === 0) {
    issues.push({
      code: 'CORS_ORIGINS_REQUIRED',
      message: 'AI_CORS_ORIGINS must list exact allowed dashboard/extension origins in production.',
    });
  }
  for (const origin of corsOrigins) {
    if (origin === '*' || origin.includes('*')) {
      issues.push({
        code: 'CORS_WILDCARD_FORBIDDEN',
        message: `Wildcard CORS origin is forbidden in production: ${origin}`,
      });
    }
    if (origin === 'null') {
      issues.push({
        code: 'CORS_NULL_ORIGIN_FORBIDDEN',
        message: 'null Origin is forbidden in production CORS allowlists.',
      });
    }
  }

  for (const origin of parseOriginList(env.AI_CORS_CONTENT_SCRIPT_ORIGINS)) {
    if (origin === '*' || origin.includes('*')) {
      issues.push({
        code: 'CORS_CONTENT_SCRIPT_WILDCARD',
        message: `Wildcard content-script CORS origin is forbidden: ${origin}`,
      });
    }
  }

  if (!env.METRICS_SCRAPE_TOKEN || env.METRICS_SCRAPE_TOKEN.length < 16) {
    issues.push({
      code: 'METRICS_SCRAPE_TOKEN_REQUIRED',
      message: 'METRICS_SCRAPE_TOKEN is required in production (≥16 chars).',
    });
  }

  if (!env.INTERNAL_OBSERVABILITY_TOKEN || env.INTERNAL_OBSERVABILITY_TOKEN.length < 16) {
    issues.push({
      code: 'INTERNAL_OBSERVABILITY_TOKEN_REQUIRED',
      message: 'INTERNAL_OBSERVABILITY_TOKEN is required in production (≥16 chars).',
    });
  }

  if (!env.HEALTH_DETAILS_TOKEN || env.HEALTH_DETAILS_TOKEN.length < 16) {
    issues.push({
      code: 'HEALTH_DETAILS_TOKEN_REQUIRED',
      message: 'HEALTH_DETAILS_TOKEN is required in production (≥16 chars).',
    });
  }

  if (env.PADDLE_ENVIRONMENT === 'sandbox') {
    issues.push({
      code: 'PADDLE_SANDBOX_IN_PRODUCTION',
      message: 'PADDLE_ENVIRONMENT=sandbox is forbidden when NODE_ENV=production.',
    });
  }

  if (!env.PADDLE_API_KEY || !env.PADDLE_WEBHOOK_SECRET) {
    issues.push({
      code: 'PADDLE_PRODUCTION_SECRETS',
      message: 'PADDLE_API_KEY and PADDLE_WEBHOOK_SECRET are required in production.',
    });
  }

  if (env.PADDLE_ENVIRONMENT === 'production') {
    if (!env.PADDLE_PRICE_PRO_MONTHLY || !env.PADDLE_PRICE_TEAM_MONTHLY) {
      issues.push({
        code: 'PADDLE_PRODUCTION_PRICES',
        message: 'Production Paddle price IDs must be configured for Pro and Team plans.',
      });
    }
    if (env.APP_BASE_URL.includes('localhost') || env.APP_BASE_URL.includes('127.0.0.1')) {
      issues.push({
        code: 'APP_BASE_URL_LOCALHOST',
        message: 'APP_BASE_URL must not point at localhost in production.',
      });
    }
  }

  if (env.PADDLE_WEBHOOK_SECRET === 'dev-webhook-secret') {
    issues.push({
      code: 'PADDLE_WEBHOOK_SECRET_DEFAULT',
      message: 'PADDLE_WEBHOOK_SECRET must not use the development default.',
    });
  }

  if (!isLocalRedisHost(env.REDIS_HOST) && !env.REDIS_PASSWORD) {
    issues.push({
      code: 'REDIS_REMOTE_WITHOUT_PASSWORD',
      message: 'Remote Redis in production must set REDIS_PASSWORD (or equivalent auth).',
    });
  }

  if (!isLocalRedisHost(env.REDIS_HOST) && !env.REDIS_TLS) {
    issues.push({
      code: 'REDIS_REMOTE_WITHOUT_TLS',
      message: 'Remote Redis in production must set REDIS_TLS=true (TLS in transit).',
    });
  }

  const dbHost = postgresHostFromDatabaseUrl(env.DATABASE_URL);
  if (!isLocalDatabaseHost(dbHost) && !databaseUrlUsesTls(env.DATABASE_URL, env.DATABASE_SSL)) {
    issues.push({
      code: 'DATABASE_REMOTE_WITHOUT_SSL',
      message:
        'Remote Postgres in production must use TLS (DATABASE_SSL=true or sslmode=require / verify-* in DATABASE_URL).',
    });
  }

  issues.push(...collectGitHubAppConfigIssues(env));
  issues.push(...collectMailConfigIssues(env));

  return issues;
}

/** Mail must be fully configured or fully off; a half configuration fails at startup. */
export function collectMailConfigIssues(env: ApiEnv): ProductionSecurityIssue[] {
  const key = env.RESEND_API_KEY.trim();
  const from = env.MAIL_FROM.trim();
  if (!key && !from) return [];
  const issues: ProductionSecurityIssue[] = [];
  if (!key || !from) {
    issues.push({
      code: 'MAIL_CONFIG_PAIR',
      message: 'RESEND_API_KEY and MAIL_FROM must both be set or both omitted.',
    });
  }
  if (from && !isValidMailFrom(from)) {
    issues.push({
      code: 'MAIL_FROM_INVALID',
      message: 'MAIL_FROM must be an address or "Name <address>".',
    });
  }
  return issues;
}

/**
 * `address` or `Name <address>`. Plain string checks only (linear time, no backtracking):
 * one `@`, no whitespace or angle brackets in the address, and a dotted domain without empty
 * labels.
 */
export function isValidMailFrom(value: string): boolean {
  const from = value.trim();
  let address = from;
  if (from.endsWith('>')) {
    const open = from.lastIndexOf('<');
    if (open < 0) return false;
    const name = from.slice(0, open);
    if (name.includes('<') || name.includes('>')) return false;
    address = from.slice(open + 1, -1);
  }
  if (address.length === 0 || address.length > 254) return false;
  for (const char of address) {
    if (char === '<' || char === '>' || char.trim() === '') return false;
  }
  const at = address.indexOf('@');
  if (at <= 0 || at !== address.lastIndexOf('@')) return false;
  const domain = address.slice(at + 1);
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every((label) => label.length > 0);
}

export function assertProductionSecurity(env: ApiEnv): void {
  const issues = collectProductionSecurityIssues(env);
  if (issues.length === 0) {
    return;
  }
  const details = issues.map((issue) => `${issue.code}: ${issue.message}`).join('; ');
  throw new Error(`Insecure production configuration: ${details}`);
}
