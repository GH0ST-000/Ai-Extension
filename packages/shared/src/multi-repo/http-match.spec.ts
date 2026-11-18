import { describe, expect, it } from 'vitest';

import { detectHttpCalls } from './http-calls';
import { matchHttpDependencies, type ProviderOperation, type RepoHttpFacts } from './http-match';
import { extractOpenApiOperations } from './openapi-detect';
import { detectRouteDefinitions } from './route-detect';

const API = 'github:gh0st-000/project-x-test-api';
const CLIENT = 'github:gh0st-000/project-x-test-client';

const OPENAPI = `openapi: 3.0.3
info: { title: Users, version: 1.0.0 }
paths:
  /health:
    get: { summary: ok }
  /api/users:
    get: { summary: list }
  /api/users/{id}:
    get: { summary: one }
`;
const SERVER = `import express from 'express';
const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/users', (_req, res) => res.json(users));
app.get('/api/users/:id', (req, res) => res.json(find(req.params.id)));
`;
const CLIENT_SRC = `const BASE_URL = process.env.USER_API_BASE_URL ?? 'http://localhost:3000';
export const health = () => fetch(\`\${BASE_URL}/health\`);
export const listUsers = () => fetch(\`\${BASE_URL}/api/users\`).then((r) => r.json());
export const getUser = (id: string) => fetch(\`\${BASE_URL}/api/users/\${id}\`).then((r) => r.json());
`;

function provider(key: string, openapi?: string, server?: string): RepoHttpFacts {
  const operations: ProviderOperation[] = [];
  if (openapi) {
    for (const op of extractOpenApiOperations(openapi).operations) {
      operations.push({
        ...op,
        filePath: 'openapi.yaml',
        source: 'openapi',
        confidence: 'high',
        summary: 'openapi',
      });
    }
  }
  if (server) {
    for (const r of detectRouteDefinitions([{ path: 'src/server.ts', content: server }])) {
      operations.push({ ...r, source: 'route' });
    }
  }
  return { key, operations, calls: [], declared: [] };
}
function consumer(
  key: string,
  src: string,
  declared: RepoHttpFacts['declared'] = [],
): RepoHttpFacts {
  return {
    key,
    operations: [],
    calls: detectHttpCalls(src).map((c) => ({ ...c, filePath: 'src/users-client.ts' })),
    declared,
  };
}
const MANIFEST = [
  {
    targetKey: API,
    filePath: 'service-dependencies.json',
    baseUrlEnv: 'USER_API_BASE_URL',
    endpoints: [{ method: 'GET' as const, path: '/api/users' }],
  },
];

describe('matchHttpDependencies — acceptance shape', () => {
  it('client → api, high confidence with manifest + code + OpenAPI; direction preserved', () => {
    const { links } = matchHttpDependencies([
      provider(API, OPENAPI, SERVER),
      consumer(CLIENT, CLIENT_SRC, MANIFEST),
    ]);
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.consumerKey).toBe(CLIENT);
    expect(link.providerKey).toBe(API);
    expect(link.confidence).toBe('high');
    expect(link.corroborated).toBe(true);
    expect(link.declaredEnvUsed).toBe(true);
    expect(link.endpoints.map((e) => `${e.method} ${e.path} ${e.operation?.source}`)).toEqual([
      'GET /health openapi',
      'GET /api/users openapi',
      'GET /api/users/{param} openapi',
    ]);
  });

  it('confidence comes from evidence, not from the manifest', () => {
    // A concrete call uniquely matched to a trusted provider operation is high — with or
    // without a manifest; the manifest adds evidence, not confidence.
    const plain = matchHttpDependencies([
      provider(API, undefined, SERVER),
      consumer(CLIENT, 'fetch(`${BASE}/api/users`);'),
    ]);
    expect(plain.links.map((l) => `${l.consumerKey}->${l.providerKey}:${l.confidence}`)).toEqual([
      `${CLIENT}->${API}:high`,
    ]);
    const declared = matchHttpDependencies([
      provider(API, undefined, SERVER),
      consumer(CLIENT, 'fetch(`${BASE}/api/users`);', MANIFEST),
    ]);
    expect(declared.links[0]?.confidence).toBe('high');
    // A weak call (method unknown) only corroborates: medium.
    const weak = matchHttpDependencies([
      provider(API, OPENAPI),
      consumer(CLIENT, "fetch('/api/users', init);"),
    ]);
    expect(weak.links[0]).toMatchObject({ confidence: 'medium', corroborated: true });
  });

  it('keeps every provider record of an endpoint (OpenAPI and route) on one link', () => {
    const { links } = matchHttpDependencies([
      provider(API, OPENAPI, SERVER),
      consumer(CLIENT, CLIENT_SRC),
    ]);
    expect(links).toHaveLength(1);
    const users = links[0]!.endpoints.find((e) => e.path === '/api/users/{param}')!;
    expect(users.operations.map((o) => o.source)).toEqual(['openapi', 'route']);
  });
});

describe('matchHttpDependencies — false positives', () => {
  it('no relationship when the provider exposes nothing matching', () => {
    const r = matchHttpDependencies([
      provider(API, undefined, "const app = express();\napp.get('/api/orders', h);"),
      consumer(CLIENT, CLIENT_SRC),
    ]);
    expect(r.links).toEqual([]);
    expect(r.unresolved.get(CLIENT)).toBe(3);
  });

  it('/health alone never proves a dependency', () => {
    const r = matchHttpDependencies([
      provider(API, OPENAPI),
      consumer(CLIENT, 'fetch(`${BASE}/health`);'),
    ]);
    expect(r.links).toEqual([]);
  });

  it('identical routes in two repositories are ambiguous (no link) unless the manifest disambiguates', () => {
    const OTHER = 'github:acme/users-v2';
    const ambiguous = matchHttpDependencies([
      provider(API, OPENAPI),
      provider(OTHER, OPENAPI),
      consumer(CLIENT, CLIENT_SRC),
    ]);
    expect(ambiguous.links).toEqual([]);
    expect(ambiguous.unresolved.get(CLIENT)).toBe(3);
    const resolved = matchHttpDependencies([
      provider(API, OPENAPI),
      provider(OTHER, OPENAPI),
      consumer(CLIENT, CLIENT_SRC, MANIFEST),
    ]);
    expect(resolved.links.map((l) => l.providerKey)).toEqual([API]);
  });

  it('ambiguous providers: the manifest endpoint list may attribute, but only as medium', () => {
    const OTHER = 'github:acme/users-v2';
    const listed = [
      {
        ...MANIFEST[0]!,
        baseUrlEnv: undefined,
        endpoints: [{ method: 'GET' as const, path: '/api/users' }],
      },
    ];
    const r = matchHttpDependencies([
      provider(API, OPENAPI),
      provider(OTHER, OPENAPI),
      consumer(CLIENT, 'fetch(`${this.baseUrl}/api/users`);', listed),
    ]);
    expect(r.links.map((l) => [l.providerKey, l.confidence])).toEqual([[API, 'medium']]);
    expect(r.links[0]!.endpoints[0]!.disambiguatedByManifest).toBe(true);
  });

  it('conflicting evidence is not silently attributed (declared base URL vs actual provider)', () => {
    const OTHER = 'github:acme/orders';
    const r = matchHttpDependencies([
      provider(API, OPENAPI),
      provider(OTHER, 'openapi: 3.0.0\npaths:\n  /api/orders:\n    get: {}\n'),
      consumer(CLIENT, 'fetch(`${process.env.USER_API_BASE_URL}/api/orders`);', MANIFEST),
    ]);
    expect(r.unresolved.get(CLIENT)).toBe(1);
    expect(r.links.map((l) => [l.providerKey, l.corroborated])).toEqual([[API, false]]);
  });

  it('external absolute URLs are never matched', () => {
    const r = matchHttpDependencies([
      provider(API, OPENAPI),
      consumer(CLIENT, "fetch('https://partner.example.com/api/users');"),
    ]);
    expect(r.links).toEqual([]);
  });

  it('a declaration alone is a low-confidence declared link; declared + env usage is medium', () => {
    const declaredOnly = matchHttpDependencies([provider(API), consumer(CLIENT, '', MANIFEST)])
      .links[0]!;
    expect(declaredOnly).toMatchObject({
      confidence: 'low',
      corroborated: false,
      declaredEnvUsed: false,
    });
    const envUsed = matchHttpDependencies([provider(API), consumer(CLIENT, CLIENT_SRC, MANIFEST)])
      .links[0]!;
    expect(envUsed).toMatchObject({
      confidence: 'medium',
      corroborated: false,
      declaredEnvUsed: true,
    });
  });

  it('never links a repository to itself', () => {
    const self = provider(API, OPENAPI);
    self.calls = detectHttpCalls(CLIENT_SRC).map((c) => ({ ...c, filePath: 'x.ts' }));
    expect(matchHttpDependencies([self]).links).toEqual([]);
  });
});
