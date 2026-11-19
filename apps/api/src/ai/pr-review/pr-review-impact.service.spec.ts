import type { DownstreamImpactResult, PrReviewDownstreamImpact } from '@project-x/types';
import { describe, expect, it, vi } from 'vitest';

import { renderDownstreamImpactSection } from './pr-review-impact-render';
import { changedContractFiles, PrReviewImpactService } from './pr-review-impact.service';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const DOC = `openapi: 3.0.3\ninfo: { title: t, version: '1' }\npaths:\n  /x:\n    get:\n      responses:\n        '200': { description: ok }\n`;

function service(reads: (sha: string, path: string) => unknown = () => ({ ok: true, text: DOC })) {
  const diff = {
    fetchFileAtRef: vi.fn(async (i: { sha: string; path: string }) => reads(i.sha, i.path)),
  };
  return { svc: new PrReviewImpactService(diff as never), diff };
}
const base = {
  userId: 'u',
  workspaceId: 'w',
  owner: 'acme',
  repository: 'api',
  source: 'github_api',
  baseSha: SHA_A,
  headSha: SHA_B,
  files: [{ path: 'openapi.yaml', status: 'modified' }],
};

describe('PrReviewImpactService', () => {
  it('detects contract files by path, including a renamed file’s previous path', () => {
    expect(
      changedContractFiles([
        { path: 'src/a.ts', status: 'modified' },
        { path: 'docs/openapi.json', status: 'modified' },
        { path: 'api/spec.yaml', status: 'renamed', previousPath: 'swagger.yaml' },
        { path: 'docs/openapi.json', status: 'modified' },
      ]).map((f) => f.path),
    ).toEqual(['docs/openapi.json', 'api/spec.yaml']);
  });

  it('a deadline that already passed reads nothing and reports a timeout', async () => {
    const { svc, diff } = service();
    const controller = new AbortController();
    controller.abort();
    const r = await svc.analyze({ ...base, signal: controller.signal });
    expect(r).toMatchObject({ status: 'unavailable', warnings: ['timeout'] });
    expect(diff.fetchFileAtRef).not.toHaveBeenCalled();
  });

  it('refuses short or missing SHAs (immutable commits only)', async () => {
    const { svc, diff } = service();
    expect((await svc.analyze({ ...base, headSha: 'abc1234' })).warnings).toEqual([
      'unverified_shas',
    ]);
    expect(diff.fetchFileAtRef).not.toHaveBeenCalled();
  });

  it('consumers beyond the access-check budget stay withheld (fail closed)', async () => {
    const consumers = Array.from({ length: 12 }, (_, i) => ({
      repository: { provider: 'github' as const, owner: 'acme', repository: `c${i}` },
      confidence: 'high' as const,
      systems: [],
      evidence: [],
      stale: false,
    }));
    const result: DownstreamImpactResult = {
      provider: { provider: 'github', owner: 'acme', repository: 'api' },
      findings: [
        {
          changeId: 'c1',
          kind: 'removed-endpoint',
          title: 'Removed GET /x',
          method: 'GET',
          path: '/x',
          operation: 'GET /x',
          status: 'potentially_affected',
          consumers,
        },
      ],
      graph: { relationshipsConsidered: 12, stale: false },
    };
    const allowed = new Map(
      consumers
        .slice(0, 10)
        .map((c) => [`github:acme/${c.repository.repository}`, 'allowed' as const]),
    );
    const contractImpact = {
      computeForProvider: vi.fn(async () => ({ result, systemsConsidered: 1 })),
      verifyAccess: vi.fn(async () => ({ access: allowed, noToken: false })),
    };
    const removed = DOC.replace(
      "  /x:\n    get:\n      responses:\n        '200': { description: ok }\n",
      "  /y:\n    get:\n      responses:\n        '200': { description: ok }\n",
    );
    const diff = {
      fetchFileAtRef: vi.fn(async (i: { sha: string }) => ({
        ok: true,
        text: i.sha === SHA_A ? DOC : removed,
      })),
    };
    const r = await new PrReviewImpactService(diff as never, contractImpact as never).analyze(base);
    expect(r.findings[0]!.consumers).toHaveLength(10);
    expect(r.withheldConsumers).toBe(2);
    expect(r.warnings).toEqual(
      expect.arrayContaining(['consumers_withheld', 'access_check_unavailable']),
    );
    expect(r.status).toBe('partial');
  });
});

describe('renderDownstreamImpactSection', () => {
  const impact = (over: Partial<PrReviewDownstreamImpact>): PrReviewDownstreamImpact => ({
    status: 'verified',
    provider: { provider: 'github', owner: 'acme', repository: 'api' },
    contracts: [
      { path: 'openapi.yaml', status: 'compared', breaking: 1, nonBreaking: 0, uncertain: 0 },
    ],
    findings: [],
    withheldConsumers: 0,
    warnings: [],
    analyzedAt: '2026-11-20T00:00:00.000Z',
    ...over,
  });

  it('no section for PRs without contract changes', () => {
    expect(renderDownstreamImpactSection(impact({ status: 'not_analyzed' }))).toBeNull();
  });

  it('honest wording for every state; never "confirmed broken"', () => {
    const texts = (
      [
        'compatible',
        'unavailable',
        'no_system',
        'no_known_consumers',
        'partial',
        'verified',
      ] as const
    ).map((status) =>
      renderDownstreamImpactSection(
        impact({ status, warnings: ['stale_graph'], withheldConsumers: 1 }),
      )!,
    );
    for (const text of texts) {
      expect(text.startsWith('## Downstream Impact')).toBe(true);
      expect(text.toLowerCase()).not.toContain('confirmed broken');
      expect(text).not.toContain('{');
    }
    expect(texts[0]).toContain('no breaking changes');
    expect(texts[1]).toContain('could not be verified');
    expect(texts[3]).toContain('does not mean nothing depends on it');
    expect(texts[5]).toContain('1 potentially affected repository is not shown');
  });
});
