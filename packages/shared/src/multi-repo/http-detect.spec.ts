import { describe, expect, it } from 'vitest';

import { detectHttpConsumerPaths, detectHttpProviderPaths } from './http-detect';

describe('http-detect', () => {
  it('detects NestJS provider route decorators', () => {
    const content = `
@Controller('payments')
export class PaymentsController {
  @Post('/payments/:id/retry')
  retry() {}
}
`;
    const found = detectHttpProviderPaths(content, 'payments.controller.ts');
    expect(found.some((e) => e.method === 'POST' && e.path.includes('/payments'))).toBe(true);
    expect(found[0]?.kind).toBe('provider');
    expect(found[0]?.confidence).toBe('high');
  });

  it('detects OpenAPI path keys', () => {
    const content = `
paths:
  "/payments/{id}/retry":
    post:
      operationId: retryPayment
`;
    const found = detectHttpProviderPaths(content, 'openapi.yaml');
    expect(found.some((e) => e.path === '/payments/{id}/retry')).toBe(true);
  });

  it('detects fetch/axios consumer call sites', () => {
    const content = `
async function retry(id: string) {
  await fetch('/payments/' + id + '/retry');
  await axios.post('/payments/{id}/retry');
}
`;
    const found = detectHttpConsumerPaths(content, 'api-client.ts');
    expect(found.some((e) => e.kind === 'consumer')).toBe(true);
    expect(found.some((e) => e.path.includes('/payments'))).toBe(true);
  });
});
