import { describe, expect, it } from 'vitest';

import { detectHttpCalls } from './http-calls';

const calls = (src: string) =>
  detectHttpCalls(src, 'src/client.ts').map(
    (c) =>
      `${c.method ?? '?'} ${c.path}${c.baseRef ? ` <${c.baseRef}>` : ''}${c.external ? ' [ext]' : ''}`,
  );

describe('detectHttpCalls', () => {
  it('resolves environment-based base URLs (the test client shape)', () => {
    const src = `
const BASE_URL = process.env.USER_API_BASE_URL ?? 'http://localhost:3000';
export async function listUsers() {
  const res = await fetch(\`\${BASE_URL}/api/users\`);
  return res.json();
}
export async function getUser(id: string) {
  return fetch(\`\${process.env.USER_API_BASE_URL}/api/users/\${encodeURIComponent(id)}\`, { headers: {} });
}
export const health = () => fetch(BASE_URL + '/health');
`;
    expect(calls(src)).toEqual([
      'GET /api/users <USER_API_BASE_URL>',
      'GET /api/users/{param} <USER_API_BASE_URL>',
      'GET /health <USER_API_BASE_URL>',
    ]);
  });

  it('fetch options, axios helpers, axios config, http clients and new URL', () => {
    const src = `
await fetch(\`\${API}/api/users\`, { method: 'POST', body });
await fetch('/api/orders', init);
await axios.get<User[]>(\`\${config.apiBaseUrl}/api/users\`);
await axios.delete(apiUrl + '/api/users/' + id);
await axios({ url: \`\${baseUrl}/api/items\`, method: 'put' });
await axios.request({ method: 'PATCH', url: '/api/items/1' });
await this.http.get(\`\${this.baseUrl}/api/teams\`);
await fetch(new URL('/api/search', USER_API_BASE_URL));
const USERS_PATH = '/api/users';
await fetch(\`\${API}\${USERS_PATH}\`);
`;
    expect(calls(src)).toEqual([
      'POST /api/users <API>',
      '? /api/orders',
      'GET /api/users <apiBaseUrl>',
      'DELETE /api/users/{param} <apiUrl>',
      'PUT /api/items <baseUrl>',
      'PATCH /api/items/1',
      'GET /api/teams <baseUrl>',
      'GET /api/search <USER_API_BASE_URL>',
      'GET /api/users <API>',
    ]);
  });

  it('marks external absolute URLs and keeps local ones', () => {
    expect(calls("await fetch('https://api.stripe.com/v1/charges');")).toEqual([
      'GET /v1/charges [ext]',
    ]);
    expect(calls("await fetch('http://localhost:3000/api/users');")).toEqual(['GET /api/users']);
  });

  it('does not guess: unknown URLs, ternaries and definitions are skipped', () => {
    expect(calls('await fetch(url);')).toEqual([]);
    expect(calls("await fetch(flag ? '/a' : '/b');")).toEqual([]);
    expect(calls('function fetch(input) { return input; }')).toEqual([]);
    expect(calls("client.fetch('/api/users');")).toEqual([]);
    expect(calls('await fetch(`users/${id}`);')).toEqual([]);
  });

  it('never executes code and stays bounded', () => {
    const hostile = 'fetch(`${(() => { throw new Error("x") })()}/api/x`);';
    expect(() => detectHttpCalls(hostile)).not.toThrow();
    expect(detectHttpCalls('fetch('.repeat(20000))).toEqual([]);
    // Deeply nested non-HTTP calls exercise the function collector's scan budget.
    // …and a real call after them is still found.
    expect(detectHttpCalls(`${'f('.repeat(200_000)}fetch('/a')`).map((c) => c.path)).toEqual([
      '/a',
    ]);
    expect(detectHttpCalls('x'.repeat(600_000))).toEqual([]);
  });

  it('typed client with an injected fetch, a request wrapper and an endpoint map (real test client shape)', () => {
    const src = `
export const USER_API_ENDPOINTS = {
  health: '/health',
  users: '/api/users',
  userById: (id: string) => \`/api/users/\${encodeURIComponent(id)}\`,
} as const;

export class UserApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  constructor(options: UserApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }
  async getHealth(): Promise<HealthResponse> {
    return parseHealthResponse(await this.getJson(USER_API_ENDPOINTS.health));
  }
  async listUsers(): Promise<User[]> {
    return parseUsersResponse(await this.getJson(USER_API_ENDPOINTS.users)).users;
  }
  async getUser(id: string): Promise<User> {
    return parseUserResponse(await this.getJson(USER_API_ENDPOINTS.userById(id))).user;
  }
  private async getJson(path: string): Promise<unknown> {
    const url = \`\${this.baseUrl}\${path}\`;
    const response = await this.fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
    return response.json();
  }
}
`;
    expect(calls(src)).toEqual([
      'GET /health <baseUrl>',
      'GET /api/users <baseUrl>',
      'GET /api/users/{param} <baseUrl>',
    ]);
    const found = detectHttpCalls(src);
    expect(found.map((c) => c.line)).toEqual([16, 19, 22]);
    expect(found.every((c) => c.confidence === 'medium')).toBe(true);
  });

  it('wrapper variants: arrow functions, method parameters, base prefixes', () => {
    const src = `
const get = (path: string) => fetch(\`\${API_BASE_URL}\${path}\`);
async function request(method: string, path: string, body?: unknown) {
  return fetch(\`\${process.env.ORDERS_URL}/v1\${path}\`, { method, body: JSON.stringify(body) });
}
get('/api/users');
request('POST', '/orders', { a: 1 });
request('DELETE', \`/orders/\${id}\`);
get(dynamicPath);
`;
    expect(calls(src)).toEqual([
      'GET /api/users <API_BASE_URL>',
      'POST /v1/orders <ORDERS_URL>',
      'DELETE /v1/orders/{param} <ORDERS_URL>',
    ]);
  });

  it('injected fetch only on `this`; other receivers and non-path arguments are ignored', () => {
    expect(calls("client.fetchImpl('/api/users');")).toEqual([]);
    expect(calls("this.fetch('/api/users');")).toEqual(['GET /api/users']);
    expect(
      calls('async function load(id) { return fetch(`${BASE}${id}`); }\nload(userId);'),
    ).toEqual([]);
  });
});
