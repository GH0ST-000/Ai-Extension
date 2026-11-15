import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PrReviewHistoryItem, PrReviewReportDetail } from '@project-x/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildHistoryMarkdown,
  historyExportFilename,
  parsePullRequestFilter,
  parseRepositoryFilter,
  stripMachineTrailers,
} from './reviews-data';

// ── page dependencies ───────────────────────────────────────────────────────
const nav = { params: new URLSearchParams(), replace: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => '/app/reviews',
  useSearchParams: () => nav.params,
}));
vi.mock('../../../lib/workspace-context', () => ({
  useWorkspace: () => ({ ready: true, currentWorkspaceId: 'ws_1', workspaceRevision: 1 }),
}));
const apiFetch = vi.fn();
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetch(...args) };
});

const item = (over: Partial<PrReviewHistoryItem> = {}): PrReviewHistoryItem => ({
  id: 'clrep0000000001',
  schemaVersion: 1,
  owner: 'acme',
  repository: 'app',
  pullRequestNumber: 7,
  pullRequestTitle: 'Add webhooks',
  headSha: 'abcdef1234567890',
  status: 'completed',
  failureCode: null,
  riskLevel: 'medium',
  diffSource: 'github_api',
  findingsCount: 2,
  needsInvestigationCount: 1,
  filesTotal: 4,
  filesReviewed: 4,
  coverageComplete: true,
  memoryMode: 'on',
  memoryStatus: 'applied',
  initiatedByMe: true,
  initiatorName: 'Luka',
  startedAt: '2026-11-15T10:00:00.000Z',
  completedAt: '2026-11-15T10:01:00.000Z',
  createdAt: '2026-11-15T10:01:00.000Z',
  ...over,
});

const detail = (over: Partial<PrReviewReportDetail> = {}): PrReviewReportDetail => ({
  ...item(),
  baseBranch: 'main',
  headBranch: 'feat/x',
  reportMarkdown: '## Summary\nLooks fine.\n[[px:review-coverage eyJ2IjoxfQ]]',
  snapshot: {
    version: 1,
    coverage: null,
    reviewScope: null,
    findings: [
      {
        stableId: 'f1',
        path: 'src/a.ts',
        lineStart: 3,
        lineEnd: 5,
        category: 'correctness',
        severity: 'high',
        requestedSeverity: 'high',
        confidence: 'high',
        title: 'Missing await',
        explanation: 'The promise is not awaited.',
        evidence: 'save(x)',
        evidenceKind: 'changed',
        changeType: 'added',
        impact: 'Lost writes',
        trigger: '',
        failurePath: '',
        verification: { status: 'confirmed' },
        disposition: 'reported',
        alsoIn: [],
      },
    ],
    memory: { mode: 'on', status: 'applied', ruleCount: 1, sharedRules: [] },
    execution: { durationMs: 1000, batches: 1, batchesSucceeded: 1, batchesFailed: 0 },
  },
  ...over,
});

beforeEach(() => {
  nav.params = new URLSearchParams();
  nav.replace.mockReset();
  apiFetch.mockReset();
});
afterEach(() => cleanup());

describe('review history data helpers', () => {
  it('parses repository and pull request filters strictly', () => {
    expect(parseRepositoryFilter('acme/app')).toEqual({ owner: 'acme', repository: 'app' });
    expect(parseRepositoryFilter('https://github.com/acme/app.git')).toEqual({
      owner: 'acme',
      repository: 'app',
    });
    expect(parseRepositoryFilter('acme')).toBeNull();
    expect(parseRepositoryFilter('../etc/passwd')).toBeNull();
    expect(parsePullRequestFilter('#12')).toBe(12);
    expect(parsePullRequestFilter('0')).toBeNull();
    expect(parsePullRequestFilter('1e3')).toBeNull();
  });

  it('exports the delivered report with a header and without machine trailers', () => {
    const md = buildHistoryMarkdown(detail());
    expect(md).toContain('# PR review — acme/app#7');
    expect(md).toContain('- Status: Complete · risk medium');
    expect(md).toContain('- Coverage: 4/4 files (complete)');
    expect(md).toContain('Looks fine.');
    expect(md).not.toContain('[[px:');
    expect(stripMachineTrailers('a\n[[px:review-incomplete reason]]\nb')).toBe('a\nb');
    expect(historyExportFilename(item())).toBe('acme-app-pr7-2026-11-15.md');
  });

  it('exports a failed or text-less report from the structured snapshot', () => {
    const failed = buildHistoryMarkdown(
      detail({
        status: 'failed',
        failureCode: 'all_batches_failed',
        reportMarkdown: null,
        snapshot: {
          ...detail().snapshot,
          findings: [],
          failure: { code: 'all_batches_failed', failedBatches: 1 },
        },
      }),
    );
    expect(failed).toContain('No usage was charged');
    expect(failed).toContain('_No report was produced._');
    const structured = buildHistoryMarkdown(detail({ reportMarkdown: null }));
    expect(structured).toContain('### [HIGH] Missing await');
    expect(structured).toContain('`src/a.ts:3-5`');
  });
});

describe('review history page', () => {
  async function renderPage() {
    const { default: Page } = await import('./page');
    render(<Page />);
  }

  it('shows loading, then the saved reviews with status, findings and coverage', async () => {
    let resolve!: (v: unknown) => void;
    apiFetch.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await renderPage();
    expect(screen.getByText('Loading review history…')).toBeTruthy();
    await act(async () => {
      resolve({
        items: [
          item(),
          item({
            id: 'clrep0000000002',
            status: 'partial',
            coverageComplete: false,
            filesReviewed: 2,
          }),
          item({ id: 'clrep0000000003', status: 'failed' }),
        ],
        nextCursor: null,
        someRepositoriesHidden: true,
        accessCheckIncomplete: false,
      });
    });
    expect(screen.getAllByText(/acme\/app#7/)).toHaveLength(3);
    const list = within(screen.getByRole('list', { name: 'Saved reviews' }));
    expect(list.getByText('Partial')).toBeTruthy();
    expect(list.getByText('Failed')).toBeTruthy();
    expect(screen.getAllByText('2 findings · 1 to investigate').length).toBeGreaterThan(0);
    expect(screen.getByText('2/4 files')).toBeTruthy();
    expect(screen.getByText('Not reviewed')).toBeTruthy();
    expect(screen.getByText(/Some reviews are hidden/)).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith(
      '/workspaces/ws_1/pr-reviews?limit=20',
      expect.objectContaining({ workspaceId: 'ws_1' }),
    );
  });

  it('shows an empty state and a safe error state', async () => {
    apiFetch.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      someRepositoriesHidden: false,
      accessCheckIncomplete: false,
    });
    await renderPage();
    await waitFor(() => expect(screen.getByText('No saved reviews yet')).toBeTruthy());
    cleanup();
    apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await renderPage();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/reach Project X/i));
  });

  it('opening a report only reads the saved snapshot (one GET), keeps filters, and goes back', async () => {
    nav.params = new URLSearchParams('repo=acme/app&report=clrep0000000001');
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET');
      if (path.includes('/pr-reviews/clrep0000000001')) return detail();
      return {
        items: [item()],
        nextCursor: null,
        someRepositoriesHidden: false,
        accessCheckIncomplete: false,
      };
    });
    await renderPage();
    await waitFor(() => expect(screen.getByText('Missing await')).toBeTruthy());
    expect(screen.getByText(/read-only snapshot/)).toBeTruthy();
    expect(
      apiFetch.mock.calls.every(([path]) => String(path).startsWith('/workspaces/ws_1/pr-reviews')),
    ).toBe(true);
    fireEvent.click(screen.getByText('← Back to review history'));
    expect(nav.replace).toHaveBeenCalledWith('/app/reviews?repo=acme%2Fapp', { scroll: false });
  });

  it('validates filters before querying', async () => {
    apiFetch.mockResolvedValue({
      items: [],
      nextCursor: null,
      someRepositoriesHidden: false,
      accessCheckIncomplete: false,
    });
    await renderPage();
    fireEvent.change(screen.getByPlaceholderText('#123'), { target: { value: '5' } });
    fireEvent.click(screen.getByText('Apply'));
    expect(screen.getByRole('alert').textContent).toMatch(/Choose a repository/);
    fireEvent.change(screen.getByPlaceholderText('owner/repo'), { target: { value: 'acme/app' } });
    fireEvent.click(screen.getByText('Apply'));
    expect(nav.replace).toHaveBeenCalledWith('/app/reviews?repo=acme%2Fapp&pr=5', {
      scroll: false,
    });
  });
});

describe('short server pages', () => {
  const page = (ids: string[], nextCursor: string | null, extra = {}) => ({
    items: ids.map((id) => item({ id })),
    nextCursor,
    someRepositoriesHidden: false,
    accessCheckIncomplete: false,
    ...extra,
  });

  it('follows short pages (scan budget) to fill the view, then shows the reviews', async () => {
    apiFetch
      .mockResolvedValueOnce(page([], 'c1', { someRepositoriesHidden: true }))
      .mockResolvedValueOnce(page([], 'c2'))
      .mockResolvedValueOnce(page(['clrep00000000aa'], null));
    const { default: Page } = await import('./page');
    render(<Page />);
    await waitFor(() => expect(screen.getAllByText(/acme\/app#7/)).toHaveLength(1));
    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(String(apiFetch.mock.calls[1]![0])).toContain('cursor=c1');
    expect(String(apiFetch.mock.calls[2]![0])).toContain('cursor=c2');
    expect(screen.queryByText('No saved reviews yet')).toBeNull();
    expect(screen.getByText(/Some reviews are hidden/)).toBeTruthy();
  });

  it('never claims "no reviews" while the server still has a cursor; GitHub outage is explained', async () => {
    apiFetch.mockResolvedValue(page([], 'cX', { accessCheckIncomplete: true }));
    const { default: Page } = await import('./page');
    render(<Page />);
    await waitFor(() => expect(screen.getByText('Try loading more')).toBeTruthy());
    expect(apiFetch).toHaveBeenCalledTimes(1); // no follow-up while GitHub cannot confirm access
    expect(screen.queryByText('No saved reviews yet')).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/GitHub could not confirm access/);
  });
});
