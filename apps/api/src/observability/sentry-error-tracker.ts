import type { ObservabilityContext, ObservabilityLogLevel } from '@project-x/types';
import { safeTelemetryMetadata } from '@project-x/shared';

import type { ErrorTracker, ErrorTrackerCaptureContext } from './error-tracker';

/** No-op when Sentry DSN is absent — product must still run. */
export class NoopErrorTracker implements ErrorTracker {
  captureException(_error?: unknown, _context?: ErrorTrackerCaptureContext): string | undefined {
    return undefined;
  }

  captureMessage(
    _message?: string,
    _level?: ObservabilityLogLevel,
    _context?: ErrorTrackerCaptureContext,
  ): string | undefined {
    return undefined;
  }

  setContext(_context?: ObservabilityContext): void {
    // noop
  }

  async flush(_timeoutMs?: number): Promise<boolean> {
    return true;
  }
}

type SentryLike = {
  init: (options: Record<string, unknown>) => void;
  captureException: (error: unknown, hint?: Record<string, unknown>) => string;
  captureMessage: (message: string, captureContext?: Record<string, unknown>) => string;
  setTags: (tags: Record<string, string>) => void;
  setContext: (name: string, context: Record<string, unknown> | null) => void;
  setUser: (user: { id?: string } | null) => void;
  flush: (timeout?: number) => Promise<boolean>;
  withScope: (
    callback: (scope: {
      setTag: (key: string, value: string) => void;
      setExtra: (key: string, value: unknown) => void;
      setFingerprint: (fingerprint: string[]) => void;
      setLevel: (level: string) => void;
    }) => void,
  ) => void;
};

function toSentryLevel(level: ObservabilityLogLevel): string {
  if (level === 'warn') return 'warning';
  return level;
}

function applySafeContext(
  scope: {
    setTag: (key: string, value: string) => void;
    setExtra: (key: string, value: unknown) => void;
    setFingerprint?: (fingerprint: string[]) => void;
  },
  context?: ErrorTrackerCaptureContext,
): void {
  if (!context) return;

  const tagKeys: Array<keyof ObservabilityContext> = [
    'environment',
    'release',
    'service',
    'capability',
    'provider',
    'errorCode',
    'plan',
    'requestId',
    'traceId',
    'executionId',
    'workflowId',
  ];

  for (const key of tagKeys) {
    const value = context[key];
    if (typeof value === 'string' && value.length > 0) {
      scope.setTag(key, value.slice(0, 200));
    }
  }

  if (context.userIdHash) {
    scope.setTag('userIdHash', context.userIdHash);
  }
  if (context.workspaceId) {
    scope.setTag('workspaceId', context.workspaceId);
  }

  if (context.tags) {
    for (const [key, value] of Object.entries(context.tags)) {
      if (typeof value === 'string') scope.setTag(key.slice(0, 64), value.slice(0, 200));
    }
  }

  if (context.extra) {
    const safe = safeTelemetryMetadata(context.extra);
    if (safe) {
      for (const [key, value] of Object.entries(safe)) {
        scope.setExtra(key, value);
      }
    }
  }

  if (context.fingerprint && scope.setFingerprint) {
    scope.setFingerprint(context.fingerprint);
  }
}

export class SentryErrorTracker implements ErrorTracker {
  private readonly sentry: SentryLike;

  constructor(sentry: SentryLike) {
    this.sentry = sentry;
  }

  static tryCreate(options: {
    dsn: string;
    environment: string;
    release: string;
    tracesSampleRate: number;
  }): ErrorTracker {
    if (!options.dsn.trim()) {
      return new NoopErrorTracker();
    }

    try {
      // Dynamic require keeps local/dev workable without forcing Sentry init path.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Sentry = require('@sentry/node') as SentryLike;
      Sentry.init({
        dsn: options.dsn,
        environment: options.environment,
        release: options.release,
        tracesSampleRate: options.tracesSampleRate,
        sendDefaultPii: false,
        beforeSend(event: { request?: { headers?: Record<string, unknown>; data?: unknown } }) {
          if (event.request?.headers) {
            const headers = { ...event.request.headers };
            for (const key of Object.keys(headers)) {
              const lower = key.toLowerCase();
              if (
                lower === 'authorization' ||
                lower === 'cookie' ||
                lower === 'set-cookie' ||
                lower.includes('token') ||
                lower.includes('secret')
              ) {
                headers[key] = '[REDACTED]';
              }
            }
            event.request.headers = headers;
          }
          if (event.request) {
            delete event.request.data;
          }
          return event;
        },
      });
      return new SentryErrorTracker(Sentry);
    } catch {
      return new NoopErrorTracker();
    }
  }

  captureException(error: unknown, context?: ErrorTrackerCaptureContext): string | undefined {
    try {
      let eventId: string | undefined;
      this.sentry.withScope((scope) => {
        applySafeContext(scope, context);
        eventId = this.sentry.captureException(error);
      });
      return eventId;
    } catch {
      return undefined;
    }
  }

  captureMessage(
    message: string,
    level: ObservabilityLogLevel,
    context?: ErrorTrackerCaptureContext,
  ): string | undefined {
    try {
      let eventId: string | undefined;
      this.sentry.withScope((scope) => {
        scope.setLevel(toSentryLevel(level));
        applySafeContext(scope, context);
        eventId = this.sentry.captureMessage(message);
      });
      return eventId;
    } catch {
      return undefined;
    }
  }

  setContext(context: ObservabilityContext): void {
    try {
      this.sentry.setTags({
        ...(context.environment ? { environment: context.environment } : {}),
        ...(context.release ? { release: context.release } : {}),
        ...(context.service ? { service: context.service } : {}),
      });
      if (context.userIdHash) {
        this.sentry.setUser({ id: context.userIdHash });
      }
      this.sentry.setContext('observability', {
        requestId: context.requestId,
        traceId: context.traceId,
        executionId: context.executionId,
        workspaceId: context.workspaceId,
      });
    } catch {
      // never break product
    }
  }

  async flush(timeoutMs = 2000): Promise<boolean> {
    try {
      return await this.sentry.flush(timeoutMs);
    } catch {
      return false;
    }
  }
}
