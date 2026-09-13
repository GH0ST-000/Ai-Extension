import { describe, expect, it } from 'vitest';

import {
  createRequestId,
  estimateAiCost,
  hashUserIdForTelemetry,
  httpStatusClass,
  isClientTelemetryEvent,
  isSafeTelemetryComponent,
  normalizeIncomingRequestId,
  normalizeModelLabel,
  normalizeProviderUsage,
  normalizeRouteTemplate,
  redactForTelemetry,
  redactSensitiveString,
  resolveRequestId,
  safeTelemetryMetadata,
} from './index';

describe('observability identity', () => {
  it('generates req_ prefixed request ids', () => {
    const id = createRequestId();
    expect(id.startsWith('req_')).toBe(true);
    expect(normalizeIncomingRequestId(id)).toBe(id);
  });

  it('rejects invalid incoming request ids', () => {
    expect(normalizeIncomingRequestId('not-valid')).toBeUndefined();
    expect(normalizeIncomingRequestId('x'.repeat(200))).toBeUndefined();
    expect(normalizeIncomingRequestId('req_<script>')).toBeUndefined();
  });

  it('falls back to generated id', () => {
    const id = resolveRequestId('bad');
    expect(id.startsWith('req_')).toBe(true);
  });

  it('hashes user ids without exposing raw value', () => {
    const hash = hashUserIdForTelemetry('user-123');
    expect(hash.startsWith('u_')).toBe(true);
    expect(hash).not.toContain('user-123');
  });
});

describe('observability redaction', () => {
  it('redacts bearer tokens and github pats', () => {
    const text = redactSensitiveString(
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.aaa.bbb and ghp_abcdefghijklmnopqrstuvwxyz012345',
    );
    expect(text).not.toContain('eyJ');
    expect(text).not.toContain('ghp_');
    expect(text).toContain('[REDACTED]');
  });

  it('redacts nested secrets and handles circular refs', () => {
    const circular: Record<string, unknown> = { ok: true };
    circular.self = circular;
    const input = {
      authorization: 'Bearer secret-token-value',
      nested: { password: 'hunter2', accessToken: 'abc' },
      circular,
      long: 'x'.repeat(2000),
    };
    const { value, truncated } = redactForTelemetry(input);
    expect(truncated).toBe(true);
    const record = value as Record<string, unknown>;
    expect(record.authorization).toBe('[REDACTED]');
    const nested = record.nested as Record<string, unknown>;
    expect(nested.password).toBe('[REDACTED]');
    expect(nested.accessToken).toBe('[REDACTED]');
  });

  it('marks safeTelemetryMetadata truncated', () => {
    const meta = safeTelemetryMetadata({ token: 'secret', note: 'ok' });
    expect(meta?.token).toBe('[REDACTED]');
    expect(meta?.note).toBe('ok');
  });
});

describe('observability labels', () => {
  it('normalizes route templates without raw ids', () => {
    expect(normalizeRouteTemplate('/api/workspaces/ws_abc123def/memory')).toBe(
      '/api/workspaces/:id/memory',
    );
    expect(
      normalizeRouteTemplate('/api/reliability/executions/wex_0123456789abcdef0123456789abcdef'),
    ).toBe('/api/reliability/executions/:id');
    expect(httpStatusClass(502)).toBe('5xx');
  });

  it('validates client telemetry allowlists', () => {
    expect(isClientTelemetryEvent('api_request_failed')).toBe(true);
    expect(isClientTelemetryEvent('page_view')).toBe(false);
    expect(isSafeTelemetryComponent('content-script')).toBe(true);
    expect(isSafeTelemetryComponent('content_script')).toBe(true);
    expect(isSafeTelemetryComponent('../evil')).toBe(false);
  });
});

describe('ai usage and cost', () => {
  it('normalizes provider usage without inventing tokens', () => {
    expect(normalizeProviderUsage(undefined).providerReported).toBe(false);
    const usage = normalizeProviderUsage({ promptTokens: 10, completionTokens: 5 });
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      providerReported: true,
    });
  });

  it('estimates cost for known models and unavailable for unknown', () => {
    const known = estimateAiCost({
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, providerReported: true },
    });
    expect(known.source).toBe('provider_usage');
    expect(known.totalCostUsd).toBeCloseTo(0.75, 5);
    expect(known.pricingVersion).toBe('2026-09-01');

    const unknown = estimateAiCost({
      provider: 'openai',
      model: 'totally-unknown-model',
      usage: { inputTokens: 100, outputTokens: 50, providerReported: true },
    });
    expect(unknown.source).toBe('unavailable');
    expect(unknown.totalCostUsd).toBeUndefined();
  });

  it('normalizes model labels', () => {
    expect(normalizeModelLabel('openai', 'gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(normalizeModelLabel('openai', 'custom-weird-$$$')).toBe('other');
  });
});
