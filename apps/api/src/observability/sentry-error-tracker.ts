import type { ObservabilityContext, ObservabilityLogLevel } from '@project-x/types';
import { safeTelemetryMetadata } from '@project-x/shared';

import type { ErrorTracker, ErrorTrackerCaptureContext } from './error-tracker';
import { redactSecretPathSegments, redactUrlForLog } from '../common/http/redact-url';

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

export type SentryLike = {
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

  static tryCreate(
    options: {
      dsn: string;
      environment: string;
      release: string;
      tracesSampleRate: number;
    },
    // Dynamic require keeps local/dev workable without forcing the Sentry init path;
    // injectable so tests never load the real SDK.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loadSentry: () => SentryLike = () => require('@sentry/node') as SentryLike,
  ): ErrorTracker {
    if (!options.dsn.trim()) {
      return new NoopErrorTracker();
    }

    try {
      const Sentry = loadSentry();
      Sentry.init({
        dsn: options.dsn,
        environment: options.environment,
        release: options.release,
        tracesSampleRate: options.tracesSampleRate,
        sendDefaultPii: false,
        beforeSend: (event: SentryEventLike) => scrubSentryEvent(event),
        beforeSendTransaction: (event: SentryEventLike) => scrubSentryEvent(event),
        beforeBreadcrumb: (breadcrumb: SentryBreadcrumbLike) => scrubBreadcrumb(breadcrumb),
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

type SentryBreadcrumbLike = {
  message?: string;
  data?: Record<string, unknown>;
};

export type SentryEventLike = {
  transaction?: string;
  request?: {
    url?: string;
    query_string?: unknown;
    headers?: Record<string, unknown>;
    data?: unknown;
    cookies?: unknown;
  };
  breadcrumbs?: SentryBreadcrumbLike[];
  exception?: { values?: Array<{ value?: string }> };
  message?: string;
  contexts?: { trace?: { data?: Record<string, unknown> } & Record<string, unknown> };
  spans?: Array<{ description?: string; data?: Record<string, unknown> }>;
};

/** Every string value of a span/trace data bag, scrubbed (url.full, http.target, http.url…). */
function scrubDataBag(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    const urlLike = /url|target|path|query/i.test(key);
    out[key] = redactSecretPathSegments(urlLike ? (redactUrlForLog(value) ?? value) : value);
  }
  return out;
}

const SENSITIVE_HEADER = (lower: string) =>
  lower === 'authorization' ||
  lower === 'cookie' ||
  lower === 'set-cookie' ||
  lower.includes('token') ||
  lower.includes('secret');

/**
 * N-19: scrub everything Sentry may carry from a request before it leaves the process:
 * secret path segments (workspace invitation tokens) in the request URL, transaction name,
 * breadcrumbs and exception messages; query strings, bodies and cookies dropped; credential
 * headers replaced.
 */
export function scrubSentryEvent<T extends SentryEventLike>(event: T): T {
  if (event.request) {
    if (typeof event.request.url === 'string') {
      event.request.url = redactUrlForLog(event.request.url);
    }
    delete event.request.query_string;
    delete event.request.data;
    delete event.request.cookies;
    if (event.request.headers) {
      const headers = { ...event.request.headers };
      for (const key of Object.keys(headers)) {
        if (SENSITIVE_HEADER(key.toLowerCase())) headers[key] = '[REDACTED]';
        else if (typeof headers[key] === 'string') {
          headers[key] = redactSecretPathSegments(headers[key] as string); // e.g. Referer
        }
      }
      event.request.headers = headers;
    }
  }
  if (typeof event.transaction === 'string') {
    event.transaction = redactSecretPathSegments(event.transaction);
  }
  if (typeof event.message === 'string') event.message = redactSecretPathSegments(event.message);
  for (const value of event.exception?.values ?? []) {
    if (typeof value.value === 'string') value.value = redactSecretPathSegments(value.value);
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  // Adversarial N4: tracing payloads carry raw request URLs too.
  if (event.contexts?.trace?.data)
    event.contexts.trace.data = scrubDataBag(event.contexts.trace.data);
  for (const span of event.spans ?? []) {
    if (typeof span.description === 'string') {
      span.description = redactSecretPathSegments(span.description);
    }
    span.data = scrubDataBag(span.data);
  }
  return event;
}

export function scrubBreadcrumb<T extends SentryBreadcrumbLike>(breadcrumb: T): T {
  if (typeof breadcrumb.message === 'string') {
    breadcrumb.message = redactSecretPathSegments(breadcrumb.message);
  }
  if (breadcrumb.data) {
    const data = { ...breadcrumb.data };
    for (const key of ['url', 'to', 'from', 'http.url']) {
      if (typeof data[key] === 'string') data[key] = redactUrlForLog(data[key] as string);
    }
    breadcrumb.data = data;
  }
  return breadcrumb;
}
