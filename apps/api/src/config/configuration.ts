import {
  apiEnvSchema,
  isLocalNodeEnv,
  applyDatabaseSslFlag,
  assertProductionSecurity,
  isGitHubAppFullyConfigured,
  type ApiEnv,
  resolveApiHost,
  resolveDeploymentStage,
  resolveTrustProxyHops,
} from '@project-x/config';

export interface ApiConfig {
  nodeEnv: ApiEnv['NODE_ENV'];
  /**
   * `staging`: NODE_ENV=production with APP_STAGE=staging — production hardening, Paddle
   * sandbox only. `local`: development / test.
   */
  deploymentStage: 'production' | 'staging' | 'local';
  host: string;
  port: number;
  /** F-26: trusted reverse-proxy hops (Express `trust proxy`); 0 = ignore X-Forwarded-For. */
  trustProxyHops: number;
  /**
   * The URL the database client connects with: DATABASE_URL with DATABASE_SSL applied (F-10).
   * PrismaService uses THIS, not the raw environment variable.
   */
  databaseUrl: string;
  logLevel: ApiEnv['LOG_LEVEL'];
  appBaseUrl: string;
  release: string;
  service: string;
  jsonBodyLimitBytes: number;
  maxPageSize: number;
  redis: {
    host: string;
    port: number;
    password: string;
    tls: boolean;
  };
  ai: {
    provider: ApiEnv['AI_PROVIDER'];
    model: string;
    openaiApiKey: string;
    maxOutputTokens: number;
    requestTimeoutMs: number;
    maxInputCharacters: number;
    /** REVIEW_ENTIRE_PR overrides (output budget + timeout); other actions are unaffected. */
    prReview: {
      /** Output tokens per batch call. */
      maxOutputTokens: number;
      /** Timeout per batch call. */
      requestTimeoutMs: number;
      maxBatches: number;
      concurrency: number;
      batchInputTokens: number;
      maxInputTokens: number;
      maxTotalOutputTokens: number;
      reviewTimeoutMs: number;
      maxVerifications: number;
      verifyInputTokens: number;
      verifyOutputTokens: number;
      maxContextFiles: number;
    };
    corsOrigins: string[];
    corsContentScriptOrigins: string[];
  };
  jwt: {
    secret: string;
    expiresIn: string;
    refreshExpiresIn: string;
  };
  secrets: {
    /** Key material for AES-GCM encryption of per-user secrets. */
    encryptionKey: string;
  };
  /** Transactional email via Resend; `enabled` only when both values are set. */
  mail: {
    resendApiKey: string;
    from: string;
    enabled: boolean;
  };
  githubApp: {
    appId: string;
    privateKeyPem: string;
    webhookSecret: string;
    slug: string;
    clientId: string;
    clientSecret: string;
    /** True when all required GitHub App env vars are present. */
    enabled: boolean;
  };
  paddle: {
    environment: 'sandbox' | 'production';
    apiKey: string;
    webhookSecret: string;
    clientToken: string;
    prices: {
      proMonthly: string;
      proYearly: string;
      teamMonthly: string;
      teamYearly: string;
    };
  };
  observability: {
    sentryDsn: string;
    sentryTracesSampleRate: number;
    traceSampleRate: number;
    metricsScrapeToken: string;
    internalToken: string;
    healthDetailsToken: string;
    slowHttpMs: number;
    slowAiMs: number;
    slowProviderMs: number;
  };
}

function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }

  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function normalizePemFromEnv(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.includes('\\n')) {
    return trimmed.replace(/\\n/g, '\n');
  }
  return trimmed;
}

function resolveRelease(env: ApiEnv): string {
  const explicit = env.APP_RELEASE?.trim();
  if (explicit) return explicit;
  const sha = process.env.GITHUB_SHA?.trim() || process.env.COMMIT_SHA?.trim();
  if (sha) return sha.slice(0, 40);
  if (env.NODE_ENV === 'production') {
    return process.env.npm_package_version ?? '0.0.0';
  }
  return `dev-${process.env.npm_package_version ?? '0.0.0'}`;
}

export default (): ApiConfig => {
  const env = apiEnvSchema.parse(process.env);
  assertProductionSecurity(env);

  // Only explicit local environments may fall back to JWT_SECRET (production requires a
  // distinct TOKEN_ENCRYPTION_KEY; development on a public APP_BASE_URL requires one too).
  const encryptionKey = isLocalNodeEnv(env.NODE_ENV)
    ? env.TOKEN_ENCRYPTION_KEY?.trim() || env.JWT_SECRET
    : (env.TOKEN_ENCRYPTION_KEY?.trim() as string);

  return {
    nodeEnv: env.NODE_ENV,
    deploymentStage: resolveDeploymentStage(env),
    host: resolveApiHost(env),
    port: env.API_PORT,
    trustProxyHops: resolveTrustProxyHops(env),
    databaseUrl: applyDatabaseSslFlag(env.DATABASE_URL, env.DATABASE_SSL),
    logLevel: env.LOG_LEVEL,
    appBaseUrl: env.APP_BASE_URL,
    release: resolveRelease(env),
    service: env.APP_SERVICE || 'api',
    jsonBodyLimitBytes: env.API_JSON_BODY_LIMIT_BYTES,
    maxPageSize: env.API_MAX_PAGE_SIZE,
    redis: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD ?? '',
      tls: env.REDIS_TLS,
    },
    ai: {
      provider: env.AI_PROVIDER,
      model: env.AI_MODEL,
      openaiApiKey: env.OPENAI_API_KEY,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      requestTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
      maxInputCharacters: env.AI_MAX_INPUT_CHARACTERS,
      prReview: validatePrReviewBudget({
        maxOutputTokens: env.AI_PR_REVIEW_MAX_OUTPUT_TOKENS,
        requestTimeoutMs: env.AI_PR_REVIEW_TIMEOUT_MS,
        maxBatches: env.AI_PR_REVIEW_MAX_BATCHES,
        concurrency: env.AI_PR_REVIEW_MAX_CONCURRENCY,
        batchInputTokens: env.AI_PR_REVIEW_BATCH_INPUT_TOKENS,
        maxInputTokens: env.AI_PR_REVIEW_MAX_INPUT_TOKENS,
        maxTotalOutputTokens: env.AI_PR_REVIEW_MAX_TOTAL_OUTPUT_TOKENS,
        reviewTimeoutMs: env.AI_PR_REVIEW_TOTAL_TIMEOUT_MS,
        maxVerifications: env.AI_PR_REVIEW_MAX_VERIFICATIONS,
        verifyInputTokens: env.AI_PR_REVIEW_VERIFY_INPUT_TOKENS,
        verifyOutputTokens: env.AI_PR_REVIEW_VERIFY_OUTPUT_TOKENS,
        maxContextFiles: env.AI_PR_REVIEW_MAX_CONTEXT_FILES,
      }),
      corsOrigins: parseCorsOrigins(env.AI_CORS_ORIGINS),
      corsContentScriptOrigins: parseCorsOrigins(env.AI_CORS_CONTENT_SCRIPT_ORIGINS),
    },
    jwt: {
      secret: env.JWT_SECRET,
      expiresIn: env.JWT_EXPIRES_IN,
      refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
    },
    secrets: {
      encryptionKey,
    },
    mail: {
      resendApiKey: env.RESEND_API_KEY.trim(),
      from: env.MAIL_FROM.trim(),
      enabled: env.RESEND_API_KEY.trim().length > 0 && env.MAIL_FROM.trim().length > 0,
    },
    githubApp: {
      appId: env.GITHUB_APP_ID?.trim() ?? '',
      privateKeyPem: normalizePemFromEnv(env.GITHUB_APP_PRIVATE_KEY ?? ''),
      webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET?.trim() ?? '',
      slug: env.GITHUB_APP_SLUG?.trim() ?? '',
      clientId: env.GITHUB_APP_CLIENT_ID?.trim() ?? '',
      clientSecret: env.GITHUB_APP_CLIENT_SECRET?.trim() ?? '',
      enabled: isGitHubAppFullyConfigured(env),
    },
    paddle: {
      environment: env.PADDLE_ENVIRONMENT,
      apiKey: env.PADDLE_API_KEY ?? '',
      webhookSecret: env.PADDLE_WEBHOOK_SECRET ?? '',
      clientToken: env.PADDLE_CLIENT_TOKEN ?? '',
      prices: {
        proMonthly: env.PADDLE_PRICE_PRO_MONTHLY ?? '',
        proYearly: env.PADDLE_PRICE_PRO_YEARLY ?? '',
        teamMonthly: env.PADDLE_PRICE_TEAM_MONTHLY ?? '',
        teamYearly: env.PADDLE_PRICE_TEAM_YEARLY ?? '',
      },
    },
    observability: {
      sentryDsn: env.SENTRY_DSN ?? '',
      sentryTracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
      traceSampleRate: env.OBSERVABILITY_TRACE_SAMPLE_RATE,
      metricsScrapeToken: env.METRICS_SCRAPE_TOKEN ?? '',
      internalToken: env.INTERNAL_OBSERVABILITY_TOKEN ?? '',
      healthDetailsToken: env.HEALTH_DETAILS_TOKEN ?? '',
      slowHttpMs: env.SLOW_HTTP_MS,
      slowAiMs: env.SLOW_AI_MS,
      slowProviderMs: env.SLOW_PROVIDER_MS,
    },
  };
};

/**
 * Cross-field checks for the batched PR review budget. A configuration that would allow zero
 * batches, or a per-batch value larger than its per-review ceiling, fails at startup instead of
 * silently reviewing nothing or exceeding the cost ceiling.
 */
export function validatePrReviewBudget(
  budget: ApiConfig['ai']['prReview'],
): ApiConfig['ai']['prReview'] {
  const problems: string[] = [];
  if (budget.batchInputTokens > budget.maxInputTokens) {
    problems.push('AI_PR_REVIEW_BATCH_INPUT_TOKENS must not exceed AI_PR_REVIEW_MAX_INPUT_TOKENS');
  }
  if (budget.maxOutputTokens > budget.maxTotalOutputTokens) {
    problems.push(
      'AI_PR_REVIEW_MAX_OUTPUT_TOKENS (per batch) must not exceed AI_PR_REVIEW_MAX_TOTAL_OUTPUT_TOKENS',
    );
  }
  if (budget.requestTimeoutMs > budget.reviewTimeoutMs) {
    problems.push('AI_PR_REVIEW_TIMEOUT_MS must not exceed AI_PR_REVIEW_TOTAL_TIMEOUT_MS');
  }
  if (problems.length > 0) {
    throw new Error(`Invalid PR review budget: ${problems.join('; ')}`);
  }
  return budget;
}
