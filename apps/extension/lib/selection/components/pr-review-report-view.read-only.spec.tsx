/**
 * Read-only mode of the PR review report view (saved / historical reviews): nothing may change
 * the live review draft, start an AI action or post to GitHub. Live reviews keep every action.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PageContext, PRReviewReport } from '@project-x/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useGithubReviewDraftStore } from '../review-draft';
import { buildPrReviewReport } from '../utils/build-pr-review-report';
import { PrReviewReportView } from './pr-review-report-view';

const CONTEXT: PageContext = {
  type: 'github',
  url: 'https://github.com/acme/app/pull/7',
  title: 'PR',
  github: { owner: 'acme', repository: 'app', pullRequestNumber: 7 },
};
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
  '2. **[medium]** `src/b.ts` — Unchecked result',
  '   Why: The value is used without validation.',
  '   Lines: L9',
  '   Ref: prf_fedcba9876543210',
  '   Evidence:',
  '   │ const v = parse(input);',
].join('\n');

function report(): PRReviewReport {
  return buildPrReviewReport({ markdown: MARKDOWN, context: CONTEXT, final: true })!;
}

function renderView(props: Partial<Parameters<typeof PrReviewReportView>[0]> = {}) {
  const handlers = {
    onSuggestFixForFinding: vi.fn(),
    onPostComment: vi.fn(async () => ({ ok: true as const })),
    onCopyCommentDraft: vi.fn(async () => true),
    onFilterChange: vi.fn(),
    onSetDisposition: vi.fn(),
  };
  render(
    <PrReviewReportView
      report={report()}
      filter="all"
      dispositions={{}}
      githubConnected
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

/** A live review's draft for the same PR, with one finding already queued (user work). */
function seedLiveDraft(phase: 'report' | 'editing' = 'report') {
  const live = report();
  useGithubReviewDraftStore.getState().addFinding(live, live.findings[1]!);
  useGithubReviewDraftStore.setState({ phase });
  return structuredClone(useGithubReviewDraftStore.getState().draft);
}

const draftState = () => {
  const { draft, phase, snapshot, submitResult, submitError } =
    useGithubReviewDraftStore.getState();
  return structuredClone({ draft, phase, snapshot, submitResult, submitError });
};

beforeEach(() => useGithubReviewDraftStore.getState().clearDraft());
afterEach(() => {
  cleanup();
  useGithubReviewDraftStore.getState().clearDraft();
});

describe('PrReviewReportView readOnly (saved reviews)', () => {
  it('renders findings but no action that can draft, invoke AI or post — even if handlers are passed', () => {
    seedLiveDraft();
    const handlers = renderView({ readOnly: true });
    expect(screen.getByText('Missing authorization check')).toBeTruthy();
    expect(screen.queryByText('Add to Review')).toBeNull();
    expect(screen.queryByText('In Review')).toBeNull();
    expect(screen.queryByText(/Review Draft ·/)).toBeNull();
    expect(screen.queryByText('Suggest Fix')).toBeNull();
    expect(screen.queryByText('Post to GitHub')).toBeNull();
    expect(screen.queryByText('in draft')).toBeNull(); // live draft membership is not shown
    expect(handlers.onSuggestFixForFinding).not.toHaveBeenCalled();
    expect(handlers.onPostComment).not.toHaveBeenCalled();
  });

  it('never writes the review draft store: existing live draft is preserved exactly', () => {
    seedLiveDraft();
    const before = draftState();
    renderView({ readOnly: true });
    // Interact with everything that is still available.
    fireEvent.click(screen.getByText('Summary'));
    for (const button of screen.getAllByRole('button')) fireEvent.click(button);
    expect(draftState()).toEqual(before);
  });

  it('does not open the live draft workspace or mark the draft stale', () => {
    seedLiveDraft('editing');
    // The page shows another PR: a live view would mark the draft stale; a saved one must not.
    window.history.replaceState({}, '', '/acme/other/pull/99');
    try {
      const before = draftState();
      renderView({ readOnly: true });
      expect(screen.getByText('Missing authorization check')).toBeTruthy(); // report, not draft
      expect(draftState()).toEqual(before);
      expect(useGithubReviewDraftStore.getState().draft?.staleNavigation).toBeFalsy();
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  it('with no draft at all, a saved review creates none', () => {
    renderView({ readOnly: true });
    for (const button of screen.getAllByRole('button')) fireEvent.click(button);
    expect(useGithubReviewDraftStore.getState().draft).toBeNull();
  });
});

describe('PrReviewReportView live (default) keeps its actions', () => {
  it('Add to Review, Suggest Fix, Post to GitHub and the draft chip work as before', () => {
    const handlers = renderView();
    expect(screen.getAllByText('Add to Review')).toHaveLength(2);
    fireEvent.click(screen.getAllByText('Add to Review')[0]!);
    const draft = useGithubReviewDraftStore.getState().draft;
    expect(draft?.comments.filter((c) => !c.removed)).toHaveLength(1);
    expect(screen.getByText('Review Draft · 1')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Suggest Fix')[0]!);
    expect(handlers.onSuggestFixForFinding).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Post to GitHub')).toBeTruthy();
  });
});
