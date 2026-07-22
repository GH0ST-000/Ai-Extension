export const APP_NAME = 'Project X' as const;

export const SERVICE_NAMES = {
  api: 'api',
  dashboard: 'dashboard',
  extension: 'extension',
} as const;

export type ServiceName = (typeof SERVICE_NAMES)[keyof typeof SERVICE_NAMES];

/**
 * Sleep helper for retries and backoff without pulling in extra deps.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Narrow unknown errors to a readable message.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Unknown error';
}

/**
 * Ensure a value is a non-empty trimmed string.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
