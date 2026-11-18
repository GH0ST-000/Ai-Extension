import type { ApiContractChange, RepositoryRelationship } from '@project-x/types';
import { describe, expect, it } from 'vitest';

import { computeDownstreamImpact, type ScopedRelationship } from './downstream-impact';
import { toRepositoryIdentity } from './identity';

const API = toRepositoryIdentity('gh0st-000', 'project-x-test-api');
const CLIENT = toRepositoryIdentity('gh0st-000', 'project-x-test-client');
const OTHER = toRepositoryIdentity('acme', 'billing-web');
const NOW = new Date('2026-11-20T12:00:00.000Z');
const FRESH = '2026-11-19T10:00:00.000Z';

let n = 0;
function rel(
  over: Partial<RepositoryRelationship> & { key?: string } = {},
): RepositoryRelationship {
  n += 1;
  const { key = 'GET /api/users', ...rest } = over;
  return {
    id: `rel_${n}`,
    from: CLIENT,
    to: API,
    type: 'HTTP_CALLS',
    resource: { kind: 'http_operation', key },
    confidence: 'high',
    provenance: [
      {
        type: 'http_call',
        repository: CLIENT.repository,
        filePath: 'src/userApiClient.ts',
        summary: `${key} via baseUrl (line 51)`,
        observedAt: FRESH,
      },
      {
        type: 'openapi_reference',
        repository: API.repository,
        filePath: 'openapi.yaml',
        summary: `OpenAPI ${key}`,
        observedAt: FRESH,
      },
    ],
    status: 'active',
    lastValidatedAt: FRESH,
    ...rest,
  };
}
const scoped = (r: RepositoryRelationship, systemId = 'sys_1'): ScopedRelationship => ({
  relationship: r,
  system: { id: systemId, name: 'Test Microservices' },
});
function change(over: Partial<ApiContractChange>): ApiContractChange {
  return {
    id: 'c1',
    kind: 'removed-response-field',
    impact: 'breaking',
    title: 'Removed response field users[].name (200) on GET /api/users',
    description: '',
    method: 'GET',
    path: '/api/users',
    fieldPath: 'users[].name',
    statusCode: '200',
    ...over,
  };
}
const ADDED: ApiContractChange = change({
  id: 'c2',
  kind: 'added-response-field',
  impact: 'non-breaking',
  title: 'Added response field users[].displayName (200) on GET /api/users',
  fieldPath: 'users[].displayName',
});

/** The real graph: 3 consumer calls + 3 provider-operation self rows + an old superseded row. */
const REAL_GRAPH = [
  scoped(rel({ key: 'GET /health' })),
  scoped(rel({ key: 'GET /api/users' })),
  scoped(rel({ key: 'GET /api/users/{param}' })),
  ...['GET /health', 'GET /api/users', 'GET /api/users/{param}'].map((key) =>
    scoped(rel({ key, type: 'PROVIDES_API', from: API, to: API })),
  ),
  scoped(
    rel({
      resource: { kind: 'service', key: 'gh0st-000/project-x-test-api' },
      confidence: 'low',
      status: 'superseded',
    }),
  ),
];

describe('computeDownstreamImpact', () => {
  it('ACCEPTANCE: users[].name removed on GET /api/users → project-x-test-client potentially affected', () => {
    const result = computeDownstreamImpact({
      provider: API,
      changes: [change({}), ADDED],
      relationships: REAL_GRAPH,
      now: NOW,
    });
    expect(result.findings).toHaveLength(1); // the additive change produces nothing
    const finding = result.findings[0]!;
    expect(finding).toMatchObject({
      status: 'potentially_affected',
      method: 'GET',
      path: '/api/users',
      operation: 'GET /api/users',
      fieldPath: 'users[].name',
      kind: 'removed-response-field',
    });
    expect(finding.consumers).toHaveLength(1);
    expect(finding.consumers[0]).toMatchObject({
      repository: CLIENT,
      confidence: 'high',
      systems: [{ id: 'sys_1', name: 'Test Microservices' }],
      stale: false,
      lastValidatedAt: FRESH,
    });
    expect(finding.consumers[0]!.evidence.map((e) => [e.type, e.filePath])).toEqual([
      ['http_call', 'src/userApiClient.ts'],
      ['openapi_reference', 'openapi.yaml'],
    ]);
    // Only the 3 consumer → provider calls count; no self rows, no superseded row.
    expect(result.graph).toMatchObject({ relationshipsConsidered: 3, stale: false });
    // GET /health is never flagged by a change to another endpoint.
    expect(result.findings.some((f) => f.operation === 'GET /health')).toBe(false);
  });

  it('matches canonical operations: parameter names and trailing slashes do not matter; methods and segments do', () => {
    const byId = change({ path: '/api/users/{id}/', fieldPath: 'user.name' });
    expect(
      computeDownstreamImpact({
        provider: API,
        changes: [byId],
        relationships: REAL_GRAPH,
        now: NOW,
      }).findings[0]!.consumers,
    ).toHaveLength(1);
    for (const other of [
      change({ method: 'POST' }),
      change({ path: '/api/users/settings' }),
      change({ path: '/api' }),
    ]) {
      const f = computeDownstreamImpact({
        provider: API,
        changes: [other],
        relationships: REAL_GRAPH,
        now: NOW,
      }).findings[0]!;
      expect(f.status, `${other.method} ${other.path}`).toBe('no_known_consumers');
    }
  });

  it('a breaking change on /health itself does affect /health callers', () => {
    const f = computeDownstreamImpact({
      provider: API,
      changes: [change({ kind: 'removed-endpoint', path: '/health', fieldPath: undefined })],
      relationships: REAL_GRAPH,
      now: NOW,
    }).findings[0]!;
    expect(f.consumers.map((c) => c.repository.repository)).toEqual(['project-x-test-client']);
  });

  it('only breaking changes count; uncertain and non-breaking produce no findings', () => {
    const r = computeDownstreamImpact({
      provider: API,
      changes: [ADDED, change({ impact: 'uncertain' }), change({ impact: 'non-breaking' })],
      relationships: REAL_GRAPH,
      now: NOW,
    });
    expect(r.findings).toEqual([]);
  });

  it('direction: calls made BY the changed repository, and relationships into other providers, are ignored', () => {
    const r = computeDownstreamImpact({
      provider: API,
      changes: [change({})],
      relationships: [
        scoped(rel({ from: API, to: OTHER })), // the provider calling someone else
        scoped(rel({ from: CLIENT, to: OTHER })), // another provider's consumer
      ],
      now: NOW,
    });
    expect(r.findings[0]!.status).toBe('no_known_consumers');
    expect(r.graph.relationshipsConsidered).toBe(0);
  });

  it('multiple consumers, duplicates and multiple systems are merged per consumer', () => {
    const r = computeDownstreamImpact({
      provider: API,
      changes: [change({})],
      relationships: [
        scoped(rel({ confidence: 'medium' }), 'sys_1'),
        scoped(rel({}), 'sys_2'),
        scoped(rel({}), 'sys_2'),
        scoped(rel({ from: OTHER, confidence: 'medium' }), 'sys_1'),
      ],
      now: NOW,
    });
    const consumers = r.findings[0]!.consumers;
    expect(
      consumers.map((c) => [c.repository.repository, c.confidence, c.systems.map((s) => s.id)]),
    ).toEqual([
      ['project-x-test-client', 'high', ['sys_1', 'sys_2']],
      ['billing-web', 'medium', ['sys_1']],
    ]);
  });

  it('distinct operations stay distinct; repeated identical changes are not duplicated', () => {
    const r = computeDownstreamImpact({
      provider: API,
      changes: [
        change({}),
        change({ id: 'dup' }),
        change({ id: 'c3', path: '/api/users/{id}', fieldPath: 'user.name' }),
      ],
      relationships: REAL_GRAPH,
      now: NOW,
    });
    expect(r.findings.map((f) => `${f.operation} ${f.fieldPath}`)).toEqual([
      'GET /api/users users[].name',
      'GET /api/users/{param} user.name',
    ]);
  });

  it('no known consumers is reported as such (never as safe)', () => {
    const r = computeDownstreamImpact({
      provider: API,
      changes: [change({})],
      relationships: [],
      now: NOW,
    });
    expect(r.findings).toEqual([
      expect.objectContaining({ status: 'no_known_consumers', consumers: [] }),
    ]);
    expect(r.graph).toEqual({ relationshipsConsidered: 0, stale: false });
  });

  it('stale graphs are flagged from real timestamps; missing timestamps are not invented', () => {
    const old = '2026-10-01T00:00:00.000Z';
    const r = computeDownstreamImpact({
      provider: API,
      changes: [change({})],
      relationships: [scoped(rel({ lastValidatedAt: old }))],
      now: NOW,
    });
    expect(r.findings[0]!.consumers[0]).toMatchObject({ stale: true, lastValidatedAt: old });
    expect(r.graph).toMatchObject({ stale: true, oldestValidatedAt: old });
    const unknown = computeDownstreamImpact({
      provider: API,
      changes: [change({})],
      relationships: [scoped(rel({ lastValidatedAt: undefined }))],
      now: NOW,
    });
    expect(unknown.findings[0]!.consumers[0]!.lastValidatedAt).toBeUndefined();
    expect(unknown.graph.stale).toBe(false);
  });

  it('relationships without a method or with unparseable keys never match', () => {
    const r = computeDownstreamImpact({
      provider: API,
      changes: [change({})],
      relationships: [scoped(rel({ key: '/api/users' })), scoped(rel({ key: 'nonsense' }))],
      now: NOW,
    });
    expect(r.findings[0]!.status).toBe('no_known_consumers');
  });
});
