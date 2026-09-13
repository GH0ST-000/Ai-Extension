import { apiEnvSchema, assertProductionSecurity } from '@project-x/config';

/**
 * Nest ConfigModule validate hook.
 * Ensures the process fails fast when required env is missing/invalid
 * or when production security invariants are violated.
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const parsed = apiEnvSchema.safeParse(config);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid API environment configuration: ${details}`);
  }

  assertProductionSecurity(parsed.data);
  return config;
}
