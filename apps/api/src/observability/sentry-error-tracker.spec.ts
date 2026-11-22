import { describe, expect, it, vi } from 'vitest';

const sentryInit = vi.fn();
/** A stand-in for @sentry/node: the real SDK is never loaded in this test. */
const fakeSentry = {
  init: (options: unknown) => sentryInit(options),
  captureException: vi.fn(() => 'evt'),
  captureMessage: vi.fn(() => 'evt'),
  setTags: vi.fn(),
  setContext: vi.fn(),
  withScope: vi.fn(),
};

import { scrubSentryEvent, SentryErrorTracker } from './sentry-error-tracker';

const TOKEN = 'Zq3_invite-token_value-with-entropy';

/** What Sentry's Node HTTP integration attaches to an error during the accept request. */
function acceptEvent() {
  return {
    transaction: `POST /api/workspace-invitations/${TOKEN}/accept`,
    request: {
      url: `https://api.projectx.dev/api/workspace-invitations/${TOKEN}/accept?x=1`,
      query_string: 'x=1',
      headers: {
        authorization: 'Bearer eyJ.secret',
        cookie: 'px_at=abc',
        referer: `https://app.projectx.dev/invite/x/workspace-invitations/${TOKEN}/accept`,
        'user-agent': 'Mozilla',
      },
      data: { anything: 'body' },
      cookies: { px_at: 'abc' },
    },
    exception: { values: [{ value: `Failed at /api/workspace-invitations/${TOKEN}/accept` }] },
    contexts: {
      trace: {
        data: {
          'url.full': `https://api.projectx.dev/api/workspace-invitations/${TOKEN}/accept?a=1`,
          'http.target': `/api/workspace-invitations/${TOKEN}/accept`,
          'http.method': 'POST',
        },
      },
    },
    spans: [
      {
        description: `POST /api/workspace-invitations/${TOKEN}/accept`,
        data: { 'http.url': `https://api.projectx.dev/api/workspace-invitations/${TOKEN}/accept` },
      },
    ],
    breadcrumbs: [
      {
        message: `POST /api/workspace-invitations/${TOKEN}/accept`,
        data: { url: `https://api.projectx.dev/api/workspace-invitations/${TOKEN}/accept` },
      },
    ],
  };
}

describe('N-19: Sentry never receives invitation tokens', () => {
  it('scrubs request URL, query, body, cookies, headers, transaction, breadcrumbs and messages', () => {
    const scrubbed = scrubSentryEvent(acceptEvent());
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('eyJ.secret');
    expect(serialized).not.toContain('px_at=abc');
    expect(scrubbed.request.url).toBe(
      'https://api.projectx.dev/api/workspace-invitations/[redacted]/accept',
    );
    expect(scrubbed.request).not.toHaveProperty('query_string');
    expect(scrubbed.request).not.toHaveProperty('data');
    expect(scrubbed.transaction).toBe('POST /api/workspace-invitations/[redacted]/accept');
  });

  it('the hooks actually installed in Sentry.init apply the scrubbing (events, transactions, breadcrumbs)', () => {
    SentryErrorTracker.tryCreate(
      {
        dsn: 'https://public@o0.ingest.sentry.io/0',
        environment: 'test',
        release: 'r',
        tracesSampleRate: 0,
      },
      () => fakeSentry as never,
    );
    const options = sentryInit.mock.calls.at(-1)![0] as Record<string, (e: unknown) => unknown>;
    expect(options.sendDefaultPii).toBe(false);
    for (const hook of ['beforeSend', 'beforeSendTransaction'] as const) {
      expect(JSON.stringify(options[hook]!(acceptEvent()))).not.toContain(TOKEN);
    }
    expect(JSON.stringify(options.beforeBreadcrumb!(acceptEvent().breadcrumbs[0]))).not.toContain(
      TOKEN,
    );
  });
});
