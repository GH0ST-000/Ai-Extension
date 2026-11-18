import { cleanup, render, screen, within } from '@testing-library/react';
import type { PrReviewDownstreamImpact } from '@project-x/types';
import { afterEach, describe, expect, it } from 'vitest';

import { DownstreamImpact } from './downstream-impact';

afterEach(() => cleanup());

const repo = (owner: string, repository: string) => ({
  provider: 'github' as const,
  owner,
  repository,
});
const verified: PrReviewDownstreamImpact = {
  status: 'verified',
  provider: repo('gh0st-000', 'project-x-test-api'),
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  contracts: [
    { path: 'openapi.yaml', status: 'compared', breaking: 1, nonBreaking: 1, uncertain: 0 },
  ],
  findings: [
    {
      changeId: 'c1',
      kind: 'removed-response-field',
      title: 'Removed response field users[].name (200) on GET /api/users',
      method: 'GET',
      path: '/api/users',
      operation: 'GET /api/users',
      fieldPath: 'users[].name',
      statusCode: '200',
      status: 'potentially_affected',
      consumers: [
        {
          repository: repo('gh0st-000', 'project-x-test-client'),
          confidence: 'high',
          systems: [{ id: 's1', name: 'Test Microservices' }],
          evidence: [
            {
              type: 'http_call',
              repository: 'project-x-test-client',
              filePath: 'src/userApiClient.ts',
              summary: 'GET /api/users via baseUrl (line 51)',
              observedAt: '2026-11-19T00:00:00.000Z',
            },
            {
              type: 'openapi_reference',
              repository: 'project-x-test-api',
              filePath: 'openapi.yaml',
              summary: 'OpenAPI GET /api/users',
              observedAt: '2026-11-19T00:00:00.000Z',
            },
          ],
          lastValidatedAt: '2026-11-19T00:00:00.000Z',
          stale: false,
        },
      ],
    },
  ],
  withheldConsumers: 0,
  warnings: [],
  analyzedAt: '2026-11-20T00:00:00.000Z',
};

describe('DownstreamImpact', () => {
  it('shows the breaking operation, the potentially affected repository, confidence and collapsed evidence', () => {
    render(<DownstreamImpact impact={verified} />);
    expect(screen.getByRole('heading', { name: 'Downstream Impact' })).toBeTruthy();
    expect(screen.getByText('Breaking API change detected')).toBeTruthy();
    expect(screen.getByText('GET /api/users')).toBeTruthy();
    expect(screen.getByText('Removed response field users[].name')).toBeTruthy();
    const consumers = screen.getByRole('list', {
      name: 'Potentially affected repositories for GET /api/users',
    });
    expect(within(consumers).getByText('gh0st-000/project-x-test-client')).toBeTruthy();
    expect(within(consumers).getByText(/Confidence: High/)).toBeTruthy();
    expect(screen.getByText('Evidence (2)').closest('details')?.open).toBe(false);
    expect(screen.getByText(/not a confirmed runtime failure/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/[{}]/);
  });

  it('renders nothing when no contract changed', () => {
    const { container } = render(
      <DownstreamImpact impact={{ ...verified, status: 'not_analyzed', findings: [] }} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('honest states: no known consumers, no System, unavailable, compatible', () => {
    const cases: Array<[PrReviewDownstreamImpact['status'], RegExp]> = [
      ['no_known_consumers', /does not mean nothing depends on them/],
      ['no_system', /not in any of your Systems/],
      ['unavailable', /unknown — not absent/],
      ['compatible', /backward compatible/],
    ];
    for (const [status, text] of cases) {
      render(<DownstreamImpact impact={{ ...verified, status, findings: [] }} />);
      expect(screen.getByText(text)).toBeTruthy();
      expect(screen.queryByText(/not a confirmed runtime failure/)).toBeNull();
      cleanup();
    }
  });

  it('withheld consumers and stale data are explained without naming hidden repositories', () => {
    render(
      <DownstreamImpact
        impact={{
          ...verified,
          status: 'partial',
          findings: [{ ...verified.findings[0]!, consumers: [] }],
          withheldConsumers: 2,
          warnings: ['consumers_withheld', 'no_personal_token', 'stale_graph'],
        }}
      />,
    );
    const limits = screen.getByRole('list', { name: 'Analysis limitations' });
    expect(
      within(limits).getByText(/2 potentially affected repositories are not shown/),
    ).toBeTruthy();
    expect(within(limits).getByText(/personal GitHub token/)).toBeTruthy();
    expect(within(limits).getByText(/more than 14 days old/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('project-x-test-client');
  });
});
