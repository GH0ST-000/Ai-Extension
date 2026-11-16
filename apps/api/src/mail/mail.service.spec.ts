import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MailService } from './mail.service';

const KEY = 're_secret_key_value_123';
const message = {
  to: 'person@example.com',
  subject: 'Reset your password',
  html: '<p>https://app.example.test/reset-password#token=SECRET</p>',
  text: 'https://app.example.test/reset-password#token=SECRET',
  template: 'password_reset',
};

function service(enabled = true) {
  return new MailService({
    get: () => ({
      enabled,
      resendApiKey: enabled ? KEY : '',
      from: 'Project X <no-reply@example.test>',
    }),
  } as never);
}

describe('MailService (Resend over HTTPS, never called for real in tests)', () => {
  const realFetch = globalThis.fetch;
  const logs: string[] = [];

  beforeEach(() => {
    logs.length = 0;
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logs.push(JSON.stringify(args));
      });
    }
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  const noSecretsLogged = () => {
    const all = logs.join('\n');
    for (const secret of [KEY, 'person@example.com', 'token=SECRET', 'Reset your password']) {
      expect(all).not.toContain(secret);
    }
  };

  it('not configured: reports not_configured, sends nothing, never pretends to deliver', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;
    expect(await service(false).send(message)).toEqual({
      delivered: false,
      reason: 'not_configured',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    noSecretsLogged();
  });

  it('sends one authenticated request to Resend with html and text bodies', async () => {
    const fetchSpy = vi.fn(async () => Response.json({ id: 'msg_123' }));
    globalThis.fetch = fetchSpy as never;
    expect(await service().send(message)).toEqual({ delivered: true, providerId: 'msg_123' });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'Project X <no-reply@example.test>',
      to: ['person@example.com'],
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    noSecretsLogged();
  });

  it('provider rejection, timeout and network errors are reported, not thrown, and not leaked', async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ message: `bad key ${KEY} for person@example.com` }, { status: 403 }),
    ) as never;
    expect(await service().send(message)).toEqual({
      delivered: false,
      reason: 'provider_rejected',
    });
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    }) as never;
    expect(await service().send(message)).toEqual({ delivered: false, reason: 'timeout' });
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as never;
    expect(await service().send(message)).toEqual({ delivered: false, reason: 'network' });
    noSecretsLogged();
  });
});
