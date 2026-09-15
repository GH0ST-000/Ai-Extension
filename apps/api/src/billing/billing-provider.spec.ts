import { describe, expect, it } from 'vitest';

import { createBillingProvider, SandboxBillingProvider } from './billing-provider';

describe('createBillingProvider', () => {
  it('uses sandbox provider outside production', () => {
    const provider = createBillingProvider({
      nodeEnv: 'test',
      paddle: {
        environment: 'sandbox',
        apiKey: '',
        webhookSecret: 'test-webhook-secret',
        clientToken: '',
        prices: {
          proMonthly: '',
          proYearly: '',
          teamMonthly: '',
          teamYearly: '',
        },
      },
    });
    expect(provider).toBeInstanceOf(SandboxBillingProvider);
  });

  it('rejects sandbox paddle config when NODE_ENV is production', () => {
    expect(() =>
      createBillingProvider({
        nodeEnv: 'production',
        paddle: {
          environment: 'sandbox',
          apiKey: 'live_key',
          webhookSecret: 'whsec',
          clientToken: '',
          prices: {
            proMonthly: 'pri_pro',
            proYearly: '',
            teamMonthly: 'pri_team',
            teamYearly: '',
          },
        },
      }),
    ).toThrow(/Sandbox Paddle billing is forbidden/);
  });

  it('rejects production without live Paddle secrets', () => {
    expect(() =>
      createBillingProvider({
        nodeEnv: 'production',
        paddle: {
          environment: 'production',
          apiKey: '',
          webhookSecret: '',
          clientToken: '',
          prices: {
            proMonthly: 'pri_pro',
            proYearly: '',
            teamMonthly: 'pri_team',
            teamYearly: '',
          },
        },
      }),
    ).toThrow(/PADDLE_API_KEY and PADDLE_WEBHOOK_SECRET/);
  });
});
