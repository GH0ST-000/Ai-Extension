import { describe, expect, it, vi } from 'vitest';

import {
  createRequestId,
  normalizeIncomingRequestId,
  normalizeRouteTemplate,
  redactForTelemetry,
  resolveRequestId,
} from '@project-x/shared';

import { RequestContextService } from './request-context.service';
import { NoopErrorTracker, SentryErrorTracker } from './sentry-error-tracker';
import { TracingService } from './tracing.service';

describe('request identity', () => {
  it('accepts safe incoming request ids and rejects unsafe ones', () => {
    const good = createRequestId();
    expect(normalizeIncomingRequestId(good)).toBe(good);
    expect(normalizeIncomingRequestId('req_<script>')).toBeUndefined();
    expect(normalizeIncomingRequestId('x'.repeat(200))).toBeUndefined();
    expect(resolveRequestId('bad').startsWith('req_')).toBe(true);
  });
});

describe('RequestContextService ALS isolation', () => {
  it('isolates concurrent request contexts', async () => {
    const svc = new RequestContextService();
    const results: Array<string | undefined> = [];

    await Promise.all([
      new Promise<void>((resolve) => {
        svc.run({ requestId: 'req_aaaa1111', workspaceId: 'ws_a' }, () => {
          setTimeout(() => {
            results.push(svc.get()?.workspaceId);
            resolve();
          }, 20);
        });
      }),
      new Promise<void>((resolve) => {
        svc.run({ requestId: 'req_bbbb2222', workspaceId: 'ws_b' }, () => {
          setTimeout(() => {
            results.push(svc.get()?.workspaceId);
            resolve();
          }, 5);
        });
      }),
    ]);

    expect(results).toContain('ws_a');
    expect(results).toContain('ws_b');
    expect(svc.get()).toBeUndefined();
  });
});

describe('redaction before telemetry', () => {
  it('redacts secrets from nested objects', () => {
    const { value } = redactForTelemetry({
      authorization: 'Bearer secret-token',
      nested: { password: 'hunter2', github: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    });
    const record = value as Record<string, unknown>;
    expect(record.authorization).toBe('[REDACTED]');
    const nested = record.nested as Record<string, unknown>;
    expect(nested.password).toBe('[REDACTED]');
    expect(String(nested.github)).toContain('[REDACTED]');
  });
});

describe('route template normalization', () => {
  it('never keeps raw workspace or execution ids', () => {
    const route = normalizeRouteTemplate(
      '/api/workspaces/ws_abc123def456/reliability/executions/wex_0123456789abcdef0123456789abcdef',
    );
    expect(route).not.toContain('ws_abc');
    expect(route).not.toContain('wex_');
    expect(route).toContain(':id');
  });
});

describe('error tracker resilience', () => {
  it('noop tracker never throws', () => {
    const tracker = new NoopErrorTracker();
    expect(tracker.captureException(new Error('boom'))).toBeUndefined();
    expect(tracker.captureMessage('hi', 'error')).toBeUndefined();
  });

  it('tryCreate returns noop without dsn', () => {
    const tracker = SentryErrorTracker.tryCreate({
      dsn: '',
      environment: 'test',
      release: 'test',
      tracesSampleRate: 0,
    });
    expect(tracker.captureException(new Error('x'))).toBeUndefined();
  });
});

describe('TracingService', () => {
  it('creates child spans with parent relationship when sampled', async () => {
    const requestContext = new RequestContextService();
    const config = {
      get: vi.fn((key: string) => {
        if (key === 'observability.traceSampleRate') return 1;
        return undefined;
      }),
    };
    const tracing = new TracingService(config as never, requestContext);

    await requestContext.run({ requestId: 'req_trace001', sampled: true }, async () => {
      await tracing.startSpan('parent', { category: 'http' }, async (parent) => {
        expect(parent.traceId.startsWith('trace_')).toBe(true);
        await tracing.startSpan(
          'child',
          { category: 'ai', attributes: { provider: 'openai' } },
          async (child) => {
            expect(child.parentSpanId).toBe(parent.spanId);
            expect(child.attributes.provider).toBe('openai');
            expect(child.attributes).not.toHaveProperty('prompt');
          },
        );
      });
    });
  });
});
