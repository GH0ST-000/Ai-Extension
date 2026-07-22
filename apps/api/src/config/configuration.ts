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
  };
};
