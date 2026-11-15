/**
 * Saved (historical) PR reviews in the extension: rendered with the live report view, read-only,
 * fetched from the history API only (no AI call, no review request, no GitHub write).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PrReviewReportDetail } from '@project-x/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../../api/background-http', () => ({
  extensionApiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock('../../workspace/current-workspace-id', () => ({
  getCurrentWorkspaceId: async () => 'ws_1',
}));

import { SavedPrReviewButton } from './saved-pr-review-button';
import { SavedPrReviewPanel, savedReviewMemoryLine } from './saved-pr-review-panel';

const MARKDOWN = [
  '## Summary',
  'Reviewed.',
  '',
  '## Risk Findings',
  '1. **[high]** `src/a.ts` — Missing authorization check',
  '   Why: Any user can delete any note.',
  '   Lines: L4',
  '   Ref: prf_0123456789abcdef',
  '   Evidence:',
  '   │ await db.note.delete({ where: { id } });',
].join('\n');

function report(over: Partial<PrReviewReportDetail> = {}): PrReviewReportDetail {
  return {
    id: 'clrep0000000001',
    schemaVersion: 1,
    owner: 'acme',
    repository: 'app',
    pullRequestNumber: 7,
    pullRequestTitle: 'Add webhooks',
    headSha: 'abcdef1234567890',
    status: 'completed',
    failureCode: null,
    riskLevel: 'high',
    diffSource: 'github_api',
    findingsCount: 1,
    needsInvestigationCount: 0,
    filesTotal: 1,
    filesReviewed: 1,
    coverageComplete: true,
    memoryMode: 'on',
    memoryStatus: 'applied',
    initiatedByMe: true,
    initiatorName: null,
    startedAt: '2026-11-15T10:00:00.000Z',
    completedAt: '2026-11-15T10:01:00.000Z',
    createdAt: '2026-11-15T10:01:00.000Z',
    baseBranch: 'main',
    headBranch: 'feat/x',
    reportMarkdown: MARKDOWN,
    snapshot: {
      version: 1,
      coverage: null,
      reviewScope: {
        source: 'github_api',
        totalFiles: 1,
        analyzedFiles: 1,
        skippedFiles: 0,
        truncated: false,
      },
      findings: [],
      memory: {
        mode: 'on',
        status: 'applied',
        ruleCount: 3,
        sharedRules: [],
        personalRuleCount: 2,
      },
      execution: { durationMs: 1, batches: 1, batchesSucceeded: 1, batchesFailed: 0 },
    },
    ...over,
  };
}

beforeEach(() => apiFetch.mockReset());
afterEach(() => cleanup());

describe('SavedPrReviewPanel', () => {
  it('renders the saved report with the live report view, read-only', () => {
    const onBack = vi.fn();
    render(
      <SavedPrReviewPanel report={report()} backLabel="Back to current review" onBack={onBack} />,
    );
    expect(screen.getByText(/Missing authorization check/)).toBeTruthy();
    expect(screen.getByText(/Read-only snapshot of commit abcdef1/)).toBeTruthy();
    expect(screen.getByText(/did not run the AI or use review credits/)).toBeTruthy();
    // No write / AI actions in history.
    expect(screen.queryByText('Post to GitHub')).toBeNull();
    expect(screen.queryByText(/Suggest fix/i)).toBeNull();
    fireEvent.click(screen.getByText('Back to current review'));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('identifies partial and failed reviews', () => {
    render(
      <SavedPrReviewPanel
        report={report({ status: 'partial' })}
        backLabel="Back"
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/Partial review/)).toBeTruthy();
    cleanup();
    render(
      <SavedPrReviewPanel
        report={report({ status: 'failed', reportMarkdown: null })}
        backLabel="Back"
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/This review failed/)).toBeTruthy();
  });

  it('memory line: personal preferences only as the server returned them (initiator only)', () => {
    expect(savedReviewMemoryLine(report())).toBe(
      'Project Memory: 3 rules applied (including 2 of your personal preferences).',
    );
    const forTeammate = report({
      snapshot: {
        ...report().snapshot,
        memory: { mode: 'on', status: 'applied', ruleCount: 1, sharedRules: [] },
      },
    });
    expect(savedReviewMemoryLine(forTeammate)).toBe('Project Memory: 1 rule applied.');
    expect(
      savedReviewMemoryLine(
        report({
          snapshot: {
            ...report().snapshot,
            memory: { mode: 'off', status: 'disabled', ruleCount: 0, sharedRules: [] },
          },
        }),
      ),
    ).toBe('Project Memory was off for this review.');
  });
});

describe('SavedPrReviewPanel never touches the live review draft', () => {
  it('no draft actions, and an existing live draft for the same PR is preserved exactly', async () => {
    const { useGithubReviewDraftStore } = await import('../review-draft');
    const { buildPrReviewReport } = await import('../utils/build-pr-review-report');
    const live = buildPrReviewReport({
      markdown: MARKDOWN,
      context: {
        type: 'github',
        url: 'https://github.com/acme/app/pull/7',
        title: 'PR',
        github: { owner: 'acme', repository: 'app', pullRequestNumber: 7 },
      },
      final: true,
    })!;
    useGithubReviewDraftStore.getState().clearDraft();
    useGithubReviewDraftStore.getState().addFinding(live, live.findings[0]!);
    const before = structuredClone(useGithubReviewDraftStore.getState().draft);
    try {
      const onBack = vi.fn();
      render(<SavedPrReviewPanel report={report()} backLabel="Back" onBack={onBack} />);
      expect(screen.queryByText('Add to Review')).toBeNull();
      expect(screen.queryByText('In Review')).toBeNull();
      expect(screen.queryByText(/Review Draft ·/)).toBeNull();
      for (const button of screen.getAllByRole('button')) fireEvent.click(button);
      expect(useGithubReviewDraftStore.getState().draft).toEqual(before);
      expect(useGithubReviewDraftStore.getState().phase).toBe('report');
      expect(apiFetch).not.toHaveBeenCalled();
    } finally {
      useGithubReviewDraftStore.getState().clearDraft();
    }
  });
});

describe('SavedPrReviewButton', () => {
  it('fetches only the latest saved report (GET) and opens it', async () => {
    apiFetch.mockResolvedValueOnce(Response.json({ report: report() }));
    const onOpen = vi.fn();
    render(
      <SavedPrReviewButton owner="acme" repository="app" pullRequestNumber={7} onOpen={onOpen} />,
    );
    fireEvent.click(screen.getByTestId('saved-pr-review-button'));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(report()));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetch.mock.calls[0]! as [string, RequestInit];
    expect(path).toBe(
      '/workspaces/ws_1/pr-reviews/latest?owner=acme&repository=app&pullRequestNumber=7',
    );
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('shows empty and error states', async () => {
    apiFetch.mockResolvedValueOnce(Response.json({ report: null }));
    render(
      <SavedPrReviewButton owner="acme" repository="app" pullRequestNumber={7} onOpen={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('saved-pr-review-button'));
    await waitFor(() => expect(screen.getByText('No saved review for this PR yet.')).toBeTruthy());

    apiFetch.mockResolvedValueOnce(Response.json({ message: 'x' }, { status: 503 }));
    fireEvent.click(screen.getByTestId('saved-pr-review-button'));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/GitHub could not confirm/),
    );
  });
});

describe('ReviewHistoryStatus', () => {
  const OP = '11111111-1111-4111-8111-111111111111';

  it('says "saved" only when the server confirmed the stored snapshot', async () => {
    const { ReviewHistoryStatus } = await import('./review-history-status');
    apiFetch.mockResolvedValueOnce(Response.json({ status: 'saved', reportId: 'clrep1' }));
    render(<ReviewHistoryStatus operationId={OP} />);
    expect(screen.getByTestId('review-history-status').getAttribute('data-state')).toBe('checking');
    await waitFor(() =>
      expect(screen.getByTestId('review-history-status').textContent).toBe(
        'Saved to Review history.',
      ),
    );
    const [path, init] = apiFetch.mock.calls[0]! as [string, RequestInit];
    expect(path).toBe(`/workspaces/ws_1/pr-reviews/operations/${OP}`);
    expect(init.method).toBe('GET');
  });

  it('reports "not saved" after one re-check, and "couldn\'t confirm" on errors', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { ReviewHistoryStatus, REVIEW_HISTORY_RECHECK_MS } =
        await import('./review-history-status');
      apiFetch.mockImplementation(async () => Response.json({ status: 'not_saved' }));
      render(<ReviewHistoryStatus operationId={OP} />);
      await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId('review-history-status').getAttribute('data-state')).toBe(
        'checking',
      );
      await vi.advanceTimersByTimeAsync(REVIEW_HISTORY_RECHECK_MS);
      await waitFor(() =>
        expect(screen.getByTestId('review-history-status').getAttribute('data-state')).toBe(
          'not_saved',
        ),
      );
      expect(apiFetch).toHaveBeenCalledTimes(2);
      cleanup();

      apiFetch
        .mockReset()
        .mockImplementation(async () =>
          Response.json({ message: 'internal db error P2000' }, { status: 500 }),
        );
      render(<ReviewHistoryStatus operationId={OP} />);
      await waitFor(() =>
        expect(screen.getByTestId('review-history-status').getAttribute('data-state')).toBe(
          'unknown',
        ),
      );
      expect(screen.getByTestId('review-history-status').textContent).not.toMatch(/P2000|db/);
      expect(screen.getByTestId('review-history-status').textContent).not.toMatch(/^Saved/);

      apiFetch.mockReset().mockImplementation(async () => Response.json({ status: 'saved' })); // no id → not trusted
      cleanup();
      render(<ReviewHistoryStatus operationId={OP} />);
      await waitFor(() =>
        expect(screen.getByTestId('review-history-status').getAttribute('data-state')).toBe(
          'unknown',
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
