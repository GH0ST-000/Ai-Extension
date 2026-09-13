import { apiEnvSchema, type ApiEnv } from '@project-x/config';

export interface ApiConfig {
  nodeEnv: ApiEnv['NODE_ENV'];
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: ApiEnv['LOG_LEVEL'];
  appBaseUrl: string;
  release: string;
  service: string;
  redis: {
    host: string;
    port: number;
    password: string;
  };
  ai: {
    provider: ApiEnv['AI_PROVIDER'];
    model: string;
    openaiApiKey: string;
    maxOutputTokens: number;
    requestTimeoutMs: number;
    maxInputCharacters: number;
    corsOrigins: string[];
  };
  jwt: {
    secret: string;
    expiresIn: string;
  };
  secrets: {
    /** Key material for AES-GCM encryption of per-user secrets. */
    encryptionKey: string;
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

  return {
    nodeEnv: env.NODE_ENV,
    host: env.API_HOST,
    port: env.API_PORT,
    databaseUrl: env.DATABASE_URL,
    logLevel: env.LOG_LEVEL,
    appBaseUrl: env.APP_BASE_URL,
    release: resolveRelease(env),
    service: env.APP_SERVICE || 'api',
    redis: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD ?? '',
    },
    ai: {
      provider: env.AI_PROVIDER,
      model: env.AI_MODEL,
      openaiApiKey: env.OPENAI_API_KEY,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      requestTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
      maxInputCharacters: env.AI_MAX_INPUT_CHARACTERS,
      corsOrigins: parseCorsOrigins(env.AI_CORS_ORIGINS),
    },
    jwt: {
      secret: env.JWT_SECRET,
      expiresIn: env.JWT_EXPIRES_IN,
    },
    secrets: {
      encryptionKey: env.TOKEN_ENCRYPTION_KEY?.trim() || env.JWT_SECRET,
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
      slowHttpMs: env.SLOW_HTTP_MS,
      slowAiMs: env.SLOW_AI_MS,
      slowProviderMs: env.SLOW_PROVIDER_MS,
    },
  };
};
