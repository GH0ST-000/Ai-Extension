import { apiEnvSchema, type ApiEnv } from '@project-x/config';

export interface ApiConfig {
  nodeEnv: ApiEnv['NODE_ENV'];
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: ApiEnv['LOG_LEVEL'];
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

export default (): ApiConfig => {
  const env = apiEnvSchema.parse(process.env);

  return {
    nodeEnv: env.NODE_ENV,
    host: env.API_HOST,
    port: env.API_PORT,
    databaseUrl: env.DATABASE_URL,
    logLevel: env.LOG_LEVEL,
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
  };
};
