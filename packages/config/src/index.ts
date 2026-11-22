import { createPrivateKey } from 'node:crypto';
import { isIP } from 'node:net';

import { z } from 'zod';

import {
  applyDatabaseSslFlag,
  databaseUrlUsesTls,
  databaseUrlVerifiesCertificate,
  isLocalDatabaseHost,
  isLocalRedisHost,
  postgresHostFromDatabaseUrl,
} from './database-url';

export {
  applyDatabaseSslFlag,
  databaseUrlUsesTls,
  databaseUrlVerifiesCertificate,
  isLocalDatabaseHost,
  isLocalRedisHost,
  postgresHostFromDatabaseUrl,
} from './database-url';

export const nodeEnvSchema = z.enum(['development', 'test', 'production']);

export type NodeEnv = z.infer<typeof nodeEnvSchema>;

/** The only environments allowed to use development conveniences (fallback secrets, open CORS). */
export function isLocalNodeEnv(nodeEnv: string | undefined): nodeEnv is 'development' | 'test' {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

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
  /**
   * Required, never defaulted: an unset NODE_ENV used to mean "development", which silently
   * enabled the development JWT secret, encryption-key fallback and open CORS. A deployment
   * that forgets NODE_ENV now fails at startup instead.
   */
  NODE_ENV: z.enum(['development', 'test', 'production'], {
    errorMap: () => ({
      message: 'NODE_ENV must be set explicitly to "development", "test" or "production".',
    }),
  }),
  /**
   * Bind address. Unset → `resolveApiHost`: loopback (127.0.0.1) for development and test,
   * all interfaces (0.0.0.0) for production (container platforms route to it). Setting it
   * explicitly (e.g. API_HOST=0.0.0.0 for Docker/LAN development) is the opt-in.
   */
  API_HOST: z.string().optional(),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),
  /** Enable TLS when connecting to Redis (managed cloud Redis). */
  REDIS_TLS: envBoolean(false),
  /**
   * When true, the database connection is made to require TLS: `sslmode=require` is added to
   * (or replaces a weaker mode in) the URL the API connects with.
   */
  DATABASE_SSL: envBoolean(false),
  /**
   * Deployment stage of a NODE_ENV=production server. `staging` keeps EVERY production
   * security requirement (secrets, origins, secure cookies, TLS, mail, webhook verification)
   * and differs in exactly one thing: billing must be the Paddle SANDBOX — sandbox is allowed
   * and live Paddle is refused, so a staging server can never charge real money. Ignored
   * outside NODE_ENV=production.
   */
  APP_STAGE: z.enum(['production', 'staging']).default('production'),
  /**
   * F-26: number of trusted reverse-proxy hops in front of the API (Express `trust proxy`).
   * The client address used for rate limiting is taken that many hops from the right of
   * X-Forwarded-For. 0 = no proxy (the header is ignored); 1 = one load balancer / platform
   * router; 2 = CDN + load balancer. Wrong values either let clients spoof their address
   * (too high) or put every client behind the proxy's address (too low). Unset: 1 in
   * production (the previous behaviour), 0 otherwise.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).optional(),
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

  // Decision D: a malformed private key must fail at startup, not at the first App call.
  const rawKey = env.GITHUB_APP_PRIVATE_KEY.trim();
  if (rawKey) {
    try {
      createPrivateKey(rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey);
    } catch {
      issues.push({
        code: 'GITHUB_APP_PRIVATE_KEY_INVALID',
        message: 'GITHUB_APP_PRIVATE_KEY is not a valid PEM private key.',
      });
    }
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
  // N-6: `test` is no blanket bypass — like `development`, a test-mode server whose public URL
  // is not local must not run on the known development secrets.
  if (env.NODE_ENV === 'test' || env.NODE_ENV === 'development') {
    return collectDevelopmentExposureIssues(env);
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

  if (env.APP_STAGE === 'staging') {
    // Staging: production hardening, sandbox billing only (never real charges).
    if (env.PADDLE_ENVIRONMENT !== 'sandbox') {
      issues.push({
        code: 'PADDLE_PRODUCTION_IN_STAGING',
        message:
          'APP_STAGE=staging must use PADDLE_ENVIRONMENT=sandbox: a staging server must never bill real customers.',
      });
    }
    if (/^pdl_live_/i.test(env.PADDLE_API_KEY ?? '')) {
      issues.push({
        code: 'PADDLE_LIVE_KEY_IN_STAGING',
        message: 'PADDLE_API_KEY is a live key; APP_STAGE=staging requires a sandbox key.',
      });
    }
    if (!env.PADDLE_PRICE_PRO_MONTHLY || !env.PADDLE_PRICE_TEAM_MONTHLY) {
      issues.push({
        code: 'PADDLE_STAGING_PRICES',
        message: 'Sandbox Paddle price IDs must be configured for Pro and Team plans in staging.',
      });
    }
  } else if (env.PADDLE_ENVIRONMENT === 'sandbox') {
    issues.push({
      code: 'PADDLE_SANDBOX_IN_PRODUCTION',
      message:
        'PADDLE_ENVIRONMENT=sandbox is forbidden when NODE_ENV=production (a staging deployment sets APP_STAGE=staging).',
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
        'Remote Postgres in production must REQUIRE TLS: set DATABASE_SSL=true, or sslmode=require in DATABASE_URL (prefer, allow and disable permit plaintext; verify-ca / verify-full are not Prisma values — use sslmode=require with sslaccept=strict to verify the certificate).',
    });
  }

  issues.push(...collectGitHubAppConfigIssues(env));
  issues.push(...collectMailConfigIssues(env));
  issues.push(...collectProductionMailIssues(env));

  return issues;
}

/**
 * `NODE_ENV=development` is for local machines. If it is served from a public address
 * (APP_BASE_URL not localhost), the development fallbacks must not be in use: a known JWT
 * secret would let anyone forge sessions, and the encryption key would fall back to it.
 * Messages name the keys, never their values.
 */
/**
 * N-6: non-fatal deployment warnings for development/test configurations that look reachable
 * from other machines (the API binds a non-loopback address) while still using the known
 * development JWT secret. Not fatal because local Docker setups bind 0.0.0.0 by design; a
 * public deployment must use NODE_ENV=production (which fails closed on these values).
 */
export function collectDeploymentWarnings(env: ApiEnv): ProductionSecurityIssue[] {
  if (env.NODE_ENV === 'production') {
    // The extension authenticates from chrome-extension://<id>; without that exact origin in
    // AI_CORS_ORIGINS its sign-in and refresh are refused (fail closed, but a broken release).
    const origins = parseOriginList(env.AI_CORS_ORIGINS);
    const warnings: ProductionSecurityIssue[] = [];
    if (!origins.some((o) => o.startsWith('chrome-extension://'))) {
      warnings.push({
        code: 'EXTENSION_ORIGIN_NOT_CONFIGURED',
        message:
          'AI_CORS_ORIGINS has no chrome-extension://<id> entry: browser-extension sign-in will be refused. Add the published extension id.',
      });
    }
    const dbHost = postgresHostFromDatabaseUrl(env.DATABASE_URL);
    if (
      !isLocalDatabaseHost(dbHost) &&
      !databaseUrlVerifiesCertificate(applyDatabaseSslFlag(env.DATABASE_URL, env.DATABASE_SSL))
    ) {
      warnings.push({
        code: 'DATABASE_TLS_CERTIFICATE_NOT_VERIFIED',
        message:
          'The database connection is encrypted but the server certificate is not verified (sslmode=require alone). Add sslaccept=strict (with sslcert=<CA file> for a private CA) to DATABASE_URL to protect against an active attacker on the path.',
      });
    }
    if (env.TRUST_PROXY_HOPS === undefined) {
      warnings.push({
        code: 'TRUST_PROXY_HOPS_NOT_SET',
        message:
          'TRUST_PROXY_HOPS is not set; assuming exactly 1 reverse proxy in front of the API. Set it to the real number of trusted proxies (0 = none) so per-IP rate limits use the right client address.',
      });
    }
    return warnings;
  }
  const host = resolveApiHost(env);
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (loopback || !INSECURE_JWT_DEFAULTS.has(env.JWT_SECRET)) return [];
  return [
    {
      code: 'INSECURE_DEFAULTS_ON_NETWORK_BIND',
      message: `NODE_ENV=${env.NODE_ENV} with the default JWT_SECRET while API_HOST=${host} accepts connections from other machines. Never expose this server publicly; deploy with NODE_ENV=production.`,
    },
  ];
}

/**
 * Decision 3: the address the API binds to. An explicit API_HOST always wins (that is the
 * opt-in for Docker / LAN development). Otherwise development and test stay on loopback and
 * production binds all interfaces — production never inherits the local default.
 */
/**
 * F-26: trusted reverse-proxy hops (Express `trust proxy`). Explicit TRUST_PROXY_HOPS wins;
 * otherwise 1 in production (one platform router / load balancer) and 0 elsewhere. Always a
 * number — never `true`, which would trust any X-Forwarded-For a client sends.
 */
export function resolveTrustProxyHops(env: Pick<ApiEnv, 'TRUST_PROXY_HOPS' | 'NODE_ENV'>): number {
  if (env.TRUST_PROXY_HOPS !== undefined) return env.TRUST_PROXY_HOPS;
  return env.NODE_ENV === 'production' ? 1 : 0;
}

/** `staging` only for a NODE_ENV=production server that set APP_STAGE=staging. */
export function resolveDeploymentStage(
  env: Pick<ApiEnv, 'APP_STAGE' | 'NODE_ENV'>,
): 'production' | 'staging' | 'local' {
  if (env.NODE_ENV !== 'production') return 'local';
  return env.APP_STAGE === 'staging' ? 'staging' : 'production';
}

export function resolveApiHost(env: Pick<ApiEnv, 'API_HOST' | 'NODE_ENV'>): string {
  const explicit = env.API_HOST?.trim();
  if (explicit) return explicit;
  return env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
}

/**
 * Decision D: an API_HOST that is a public IP literal or a fully qualified host name binds the
 * server to a public interface on purpose. `0.0.0.0` / `::` (Docker), loopback and private
 * network addresses are not treated as explicit public exposure (they get a warning instead).
 */
export function isExplicitPublicBind(hostRaw: string): boolean {
  const host = hostRaw
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (!host || host === 'localhost' || host === '0.0.0.0' || host === '::') return false;
  // IPv4-mapped IPv6 (::ffff:203.0.113.1) is judged by its IPv4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped) return isExplicitPublicBind(mapped[1]!);
  const family = isIP(host);
  if (family === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number];
    const privateRange =
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
    return !privateRange;
  }
  if (family === 6) {
    return !(host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host));
  }
  return host.includes('.'); // FQDN; bare names (Docker service names) are local
}

function collectDevelopmentExposureIssues(env: ApiEnv): ProductionSecurityIssue[] {
  if (isLocalAppBaseUrl(env.APP_BASE_URL) && !isExplicitPublicBind(resolveApiHost(env))) return [];
  const issues: ProductionSecurityIssue[] = [];
  if (INSECURE_JWT_DEFAULTS.has(env.JWT_SECRET) || env.JWT_SECRET.length < 32) {
    issues.push({
      code: 'JWT_SECRET_INSECURE',
      message:
        'JWT_SECRET must be a unique secret of at least 32 characters when APP_BASE_URL is not local.',
    });
  }
  const encryptionKey = env.TOKEN_ENCRYPTION_KEY?.trim() ?? '';
  if (!encryptionKey || INSECURE_ENCRYPTION_DEFAULTS.has(encryptionKey)) {
    issues.push({
      code: 'TOKEN_ENCRYPTION_KEY_REQUIRED',
      message: 'TOKEN_ENCRYPTION_KEY must be set when APP_BASE_URL is not local.',
    });
  }
  return issues;
}

function isLocalAppBaseUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

/** Whole words that mark a template host name (matched per token, never as a substring). */
const PLACEHOLDER_HOST_TOKENS = new Set([
  'your',
  'yourdomain',
  'changeme',
  'placeholder',
  'example',
]);

/** Additional whole words that mark a template secret (`re_your_key_here`, `re_fake_…`). */
const PLACEHOLDER_SECRET_TOKENS = new Set([
  ...PLACEHOLDER_HOST_TOKENS,
  'yourkey',
  'replace',
  'replaceme',
  'dummy',
  'fake',
  'sample',
  'todo',
  'tbd',
  'here',
]);

/**
 * Obvious template values (`re_your_key_here`, `change-me`, `<key>`, `xxxx`, `re_fake_…`),
 * case-insensitive. Token-based: `todoist.com`, `yourbank.com`, `counterexample.org` or
 * `change.org` are not placeholders (adversarial review N5). `kind: 'host'` uses the narrower
 * list so real domains containing common words are not rejected.
 */
export function looksLikePlaceholder(value: string, kind: 'secret' | 'host' = 'secret'): boolean {
  const lower = value.trim().toLowerCase();
  if (lower.length === 0 || lower.includes('<') || lower.includes('>')) return true;
  const tokens = kind === 'host' ? PLACEHOLDER_HOST_TOKENS : PLACEHOLDER_SECRET_TOKENS;
  return lower
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some((token) => tokens.has(token) || /^x{3,}$/.test(token));
}

/** A Resend key whose secret part is too uniform to be real (`re_0000…`, `re_aaaa…`). */
function isLowEntropyKey(key: string): boolean {
  const body = key.replace(/^re_/, '').replace(/_/g, '');
  return new Set(body).size < 8;
}

/**
 * Names that can never receive mail or serve the app publicly: RFC 2606 / 6761 reserved names,
 * `.local`, private-use names (`.internal`, `.home.arpa`, `.lan`, `.corp`, `.home`) and
 * single-label hosts. A production sender or base URL on one of them is a template value.
 */
export function isReservedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (
    ['example.com', 'example.net', 'example.org', 'home.arpa'].some(
      (d) => host === d || host.endsWith(`.${d}`),
    )
  ) {
    return true;
  }
  const tld = host.split('.').pop() ?? '';
  return (
    [
      'example',
      'test',
      'invalid',
      'localhost',
      'local',
      'internal',
      'lan',
      'corp',
      'home',
      'intranet',
    ].includes(tld) || !host.includes('.')
  );
}

/**
 * Resend's shared sandbox sender (`onboarding@resend.dev`) delivers only to the Resend account
 * owner: production would start and every verification email would be rejected (review N3).
 */
const SANDBOX_SENDER_DOMAINS = new Set(['resend.dev']);

/** True for loopback, private, link-local and unspecified IP literals. */
function isNonPublicIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) === 0) return false;
  // Carrier-grade NAT (100.64.0.0/10) is not publicly routable either.
  const cgnat = /^100\.(\d+)\./.exec(host);
  if (cgnat && Number(cgnat[1]) >= 64 && Number(cgnat[1]) <= 127) return true;
  return !isExplicitPublicBind(host);
}

/**
 * Decision 2: production must not start with email verification enabled (it always is) but no
 * usable delivery configuration — otherwise no account can ever be verified and no invitation
 * accepted. Configuration only: deliverability is NOT checked here (no send at startup); see
 * docs/email-delivery-staging.md for the live staging procedure.
 * Messages never include the key's value.
 */
export function collectProductionMailIssues(env: ApiEnv): ProductionSecurityIssue[] {
  const issues: ProductionSecurityIssue[] = [];
  const key = env.RESEND_API_KEY.trim();
  const from = env.MAIL_FROM.trim();

  if (!key) {
    issues.push({
      code: 'MAIL_API_KEY_REQUIRED',
      message: 'RESEND_API_KEY is required in production (email verification and invitations).',
    });
  } else if (
    looksLikePlaceholder(key) ||
    !/^re_[A-Za-z0-9_]{16,}$/.test(key) ||
    isLowEntropyKey(key)
  ) {
    issues.push({
      code: 'MAIL_API_KEY_INVALID',
      message:
        'RESEND_API_KEY is not a Resend API key (expected "re_…"; template values are rejected).',
    });
  }

  if (!from) {
    issues.push({
      code: 'MAIL_FROM_REQUIRED',
      message: 'MAIL_FROM is required in production (a sender on your verified sending domain).',
    });
  } else if (isValidMailFrom(from)) {
    const address = from.endsWith('>') ? from.slice(from.lastIndexOf('<') + 1, -1) : from;
    const domain = address.slice(address.lastIndexOf('@') + 1);
    const lowerDomain = domain.toLowerCase();
    const sandbox = [...SANDBOX_SENDER_DOMAINS].some(
      (d) => lowerDomain === d || lowerDomain.endsWith(`.${d}`),
    );
    if (sandbox) {
      issues.push({
        code: 'MAIL_FROM_SANDBOX',
        message:
          "MAIL_FROM uses Resend's sandbox sender, which only delivers to the Resend account owner; use your verified sending domain.",
      });
    } else if (isReservedHostname(domain) || looksLikePlaceholder(domain, 'host')) {
      issues.push({
        code: 'MAIL_FROM_PLACEHOLDER',
        message: 'MAIL_FROM uses a reserved or template domain; use your verified sending domain.',
      });
    }
  }

  let base: URL | null = null;
  try {
    base = new URL(env.APP_BASE_URL);
  } catch {
    base = null;
  }
  if (
    !base ||
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    isLocalAppBaseUrl(env.APP_BASE_URL) ||
    isNonPublicIpLiteral(base.hostname) ||
    isReservedHostname(base.hostname) ||
    looksLikePlaceholder(base.hostname, 'host')
  ) {
    issues.push({
      code: 'APP_BASE_URL_NOT_PUBLIC_HTTPS',
      message:
        'APP_BASE_URL must be the public https:// dashboard origin (no credentials, query or fragment); verification and invitation links are built from it.',
    });
  }
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
