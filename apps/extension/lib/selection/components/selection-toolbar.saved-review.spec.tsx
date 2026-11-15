/**
 * B1 regression: while a saved (historical) PR review is shown, the action menu behind it is
 * hidden and its single-key shortcuts must be inert — no AI request, no credit, no change to
 * the current review. Real SelectionToolbar + store; only I/O boundaries are stubbed.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PageContext, PrReviewReportDetail } from '@project-x/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const streamAiAction = vi.fn();
vi.mock('../../services/ai-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, streamAiAction: (...args: unknown[]) => streamAiAction(...args) };
});
// No network from anything else the toolbar touches.
vi.mock('../../api/background-http', () => ({
  extensionApiFetch: vi.fn(async () => {
    throw new Error('network disabled in test');
  }),
  extensionApiStream: vi.fn(async () => {
    throw new Error('network disabled in test');
  }),
}));
vi.mock('../../services/auth-storage', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, hasAuthSession: async () => true };
});
const fetchLatestSavedPrReview = vi.fn();
vi.mock('../../api/pr-review-history', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchLatestSavedPrReview: (...args: unknown[]) => fetchLatestSavedPrReview(...args),
  };
});

import { useSelectionToolbarStore } from '../store';
import { SelectionToolbar } from './selection-toolbar';

const CONTEXT: PageContext = {
  type: 'github',
  url: 'https://github.com/acme/app/pull/7',
  title: 'PR',
  github: { owner: 'acme', repository: 'app', pullRequestNumber: 7 },
};

const SAVED: PrReviewReportDetail = {
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
  memoryStatus: 'disabled',
  initiatedByMe: true,
  initiatorName: null,
  startedAt: '2026-11-15T10:00:00.000Z',
  completedAt: '2026-11-15T10:01:00.000Z',
  createdAt: '2026-11-15T10:01:00.000Z',
  baseBranch: 'main',
  headBranch: 'feat/x',
  reportMarkdown: [
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
  ].join('\n'),
  snapshot: {
    version: 1,
    coverage: null,
    reviewScope: null,
    findings: [],
    memory: null,
    execution: { durationMs: 1, batches: 1, batchesSucceeded: 1, batchesFailed: 0 },
  },
};

// Every AI shortcut key (see SHORTCUT_TO_ACTION), in both cases.
const SHORTCUT_KEYS = ['e', 'i', 's', 't', 'c', 'r', 'f', 'a', 'u', 'o', 'j', 'p'];

function assistantState() {
  const s = useSelectionToolbarStore.getState();
  return structuredClone({
    phase: s.phase,
    assistant: s.assistant,
    requestId: s.requestId,
    lastReviewContext: s.lastReviewContext,
    lastReviewScope: s.lastReviewScope,
    lastReviewOperationId: s.lastReviewOperationId,
    findingDispositions: s.findingDispositions,
    customPrompt: s.customPrompt,
  });
}

async function openToolbarWithSavedReview() {
  useSelectionToolbarStore.setState({
    phase: 'assistant',
    anchorRect: { top: 10, left: 10, width: 10, height: 10, bottom: 20, right: 20 } as never,
    assistant: { status: 'menu' },
    lastReviewContext: CONTEXT,
    // A real selection: without one the store ignores actions, which would make this vacuous.
    selectedText: 'await db.note.delete({ where: { id } });',
  });
  render(<SelectionToolbar />);
  // The saved-review entry lives in the GitHub tab of the action menu.
  const githubTab = screen.queryByRole('tab', { name: /github/i });
  if (githubTab) fireEvent.click(githubTab);
  fireEvent.click(await screen.findByTestId('saved-pr-review-button'));
  await screen.findByTestId('saved-pr-review-panel');
}

beforeEach(() => {
  streamAiAction.mockReset().mockResolvedValue('streamed');
  fetchLatestSavedPrReview.mockReset().mockResolvedValue(SAVED);
});
afterEach(() => {
  cleanup();
  useSelectionToolbarStore.setState({
    phase: 'hidden',
    anchorRect: null,
    assistant: { status: 'menu' },
    lastReviewContext: null,
    selectedText: '',
  });
});

describe('Saved review open: AI shortcuts are inert', () => {
  it('no shortcut key starts an AI request or changes the current review state', async () => {
    await openToolbarWithSavedReview();
    const before = assistantState();
    for (const key of [...SHORTCUT_KEYS, ...SHORTCUT_KEYS.map((k) => k.toUpperCase())]) {
      await act(async () => {
        fireEvent.keyDown(document, { key });
      });
    }
    expect(streamAiAction).not.toHaveBeenCalled();
    expect(assistantState()).toEqual(before);
    expect(assistantState().assistant).toEqual({ status: 'menu' });
    // Still on the saved review, nothing replaced it.
    expect(screen.getByTestId('saved-pr-review-panel')).toBeTruthy();
  });

  it('shortcuts work again after returning to the current view (listener restored)', async () => {
    await openToolbarWithSavedReview();
    fireEvent.click(screen.getByText('Back'));
    await waitFor(() => expect(screen.queryByTestId('saved-pr-review-panel')).toBeNull());
    await act(async () => {
      fireEvent.keyDown(document, { key: 'e' });
    });
    await waitFor(() =>
      expect(useSelectionToolbarStore.getState().assistant.status).not.toBe('menu'),
    );
    // The same key that was inert over the saved review now reaches the AI client.
    await waitFor(() => expect(streamAiAction).toHaveBeenCalledTimes(1));
  });
});
