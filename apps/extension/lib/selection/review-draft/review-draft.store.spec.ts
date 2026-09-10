import { beforeEach, describe, expect, it } from 'vitest';
import type { PRReviewFinding, PRReviewReport } from '@project-x/types';

import { useGithubReviewDraftStore } from './review-draft.store';

const report: PRReviewReport = {
  repository: { owner: 'acme', name: 'app' },
  pullRequest: { number: 9 },
  riskLevel: 'low',
  overview: 'Fine',
  stats: {
    analyzedFiles: 1,
    skippedFiles: 0,
    findings: 1,
    critical: 0,
    high: 0,
    medium: 0,
    low: 1,
    suggestions: 0,
  },
  findings: [],
};

const finding: PRReviewFinding = {
  id: 'finding-1',
  index: 1,
  severity: 'low',
  title: 'Nit',
  why: 'style',
  raw: 'nit',
};

describe('useGithubReviewDraftStore', () => {
  beforeEach(() => {
    useGithubReviewDraftStore.getState().clearDraft();
  });

  it('prevents duplicate findings and allows restore after remove', () => {
    const store = useGithubReviewDraftStore.getState();
    expect(store.addFinding(report, finding).ok).toBe(true);
    expect(store.addFinding(report, finding).ok).toBe(false);

    const commentId = useGithubReviewDraftStore.getState().draft!.comments[0]!.id;
    useGithubReviewDraftStore.getState().removeComment(commentId);
    expect(useGithubReviewDraftStore.getState().draft!.comments[0]!.removed).toBe(true);

    useGithubReviewDraftStore.getState().restoreComment(commentId);
    expect(useGithubReviewDraftStore.getState().draft!.comments[0]!.removed).toBe(false);
  });

  it('marks draft stale on PR navigation mismatch without retargeting', () => {
    useGithubReviewDraftStore.getState().ensureDraft(report);
    useGithubReviewDraftStore.getState().markStaleIfDestinationMismatch({
      owner: 'acme',
      repository: 'app',
      pullRequestNumber: 10,
    });
    const draft = useGithubReviewDraftStore.getState().draft!;
    expect(draft.staleNavigation).toBe(true);
    expect(draft.destination.pullRequestNumber).toBe(9);
  });

  it('never auto-selects APPROVE', () => {
    const draft = useGithubReviewDraftStore.getState().ensureDraft(report);
    expect(draft.event).toBe('COMMENT');
  });
});
