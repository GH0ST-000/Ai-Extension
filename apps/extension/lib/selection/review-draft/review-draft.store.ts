import { create } from 'zustand';
import type {
  GitHubReviewDraft,
  GitHubReviewEvent,
  GitHubReviewSubmissionSnapshot,
  PRReviewFinding,
  PRReviewReport,
  SubmitPullRequestReviewResponse,
} from '@project-x/types';

import { createReviewDraftFromReport, findingToDraftComment } from './draft-builders';
import type { ReviewWorkspacePhase } from './types';

type GithubReviewDraftState = {
  draft: GitHubReviewDraft | null;
  snapshot: GitHubReviewSubmissionSnapshot | null;
  phase: ReviewWorkspacePhase;
  submitResult: SubmitPullRequestReviewResponse | null;
  submitError: string | null;
  submitErrorCode: string | null;
  ensureDraft: (report: PRReviewReport) => GitHubReviewDraft;
  addFinding: (
    report: PRReviewReport,
    finding: PRReviewFinding,
  ) => { ok: boolean; message?: string };
  removeComment: (commentId: string) => void;
  restoreComment: (commentId: string) => void;
  setCommentBody: (commentId: string, body: string) => void;
  setOverallBody: (body: string) => void;
  setEvent: (event: GitHubReviewEvent) => void;
  setPhase: (phase: ReviewWorkspacePhase) => void;
  setSnapshot: (snapshot: GitHubReviewSubmissionSnapshot | null) => void;
  setSubmitResult: (result: SubmitPullRequestReviewResponse | null) => void;
  setSubmitError: (message: string | null, code?: string | null) => void;
  markStaleIfDestinationMismatch: (live: {
    owner?: string;
    repository?: string;
    pullRequestNumber?: number;
  }) => void;
  markFindingsReviewed: (findingIds: string[]) => string[];
  clearDraft: () => void;
  resetSubmissionUi: () => void;
};

const INITIAL = {
  draft: null as GitHubReviewDraft | null,
  snapshot: null as GitHubReviewSubmissionSnapshot | null,
  phase: 'report' as ReviewWorkspacePhase,
  submitResult: null as SubmitPullRequestReviewResponse | null,
  submitError: null as string | null,
  submitErrorCode: null as string | null,
};

export const useGithubReviewDraftStore = create<GithubReviewDraftState>((set, get) => ({
  ...INITIAL,

  ensureDraft: (report) => {
    const existing = get().draft;
    if (existing) {
      const sameDestination =
        existing.destination.owner === report.repository.owner &&
        existing.destination.repository === report.repository.name &&
        existing.destination.pullRequestNumber === report.pullRequest.number;
      if (sameDestination) {
        return existing;
      }
      // Never retarget an existing draft to another PR.
      set({
        draft: { ...existing, staleNavigation: true },
        snapshot: null,
      });
      return get().draft!;
    }
    const draft = createReviewDraftFromReport(report);
    set({
      draft,
      snapshot: null,
      phase: 'report',
      submitResult: null,
      submitError: null,
      submitErrorCode: null,
    });
    return draft;
  },

  addFinding: (report, finding) => {
    const existing = get().draft;
    if (
      existing &&
      (existing.destination.owner !== report.repository.owner ||
        existing.destination.repository !== report.repository.name ||
        existing.destination.pullRequestNumber !== report.pullRequest.number)
    ) {
      return {
        ok: false,
        message: `Draft belongs to PR #${existing.destination.pullRequestNumber}. Clear it or return to that PR.`,
      };
    }
    const draft = get().ensureDraft(report);
    const duplicate = draft.comments.find(
      (comment) => comment.findingId === finding.id && !comment.removed,
    );
    if (duplicate) {
      return { ok: false, message: 'Finding already in the review draft.' };
    }

    const restored = draft.comments.find(
      (comment) => comment.findingId === finding.id && comment.removed,
    );
    if (restored) {
      set({
        draft: {
          ...draft,
          comments: draft.comments.map((comment) =>
            comment.id === restored.id ? { ...comment, removed: false, enabled: true } : comment,
          ),
        },
        snapshot: null,
        phase: get().phase === 'confirming' ? 'editing' : get().phase,
      });
      return { ok: true };
    }

    set({
      draft: {
        ...draft,
        comments: [...draft.comments, findingToDraftComment(finding)],
      },
      snapshot: null,
      // Stay on report so the user can curate multiple findings; chip opens draft.
      phase:
        get().phase === 'success' ? 'report' : get().phase === 'editing' ? 'editing' : 'report',
      submitResult: null,
      submitError: null,
      submitErrorCode: null,
    });
    return { ok: true };
  },

  removeComment: (commentId) => {
    const draft = get().draft;
    if (!draft) {
      return;
    }
    set({
      draft: {
        ...draft,
        comments: draft.comments.map((comment) =>
          comment.id === commentId ? { ...comment, removed: true, enabled: false } : comment,
        ),
      },
      snapshot: null,
    });
  },

  restoreComment: (commentId) => {
    const draft = get().draft;
    if (!draft) {
      return;
    }
    set({
      draft: {
        ...draft,
        comments: draft.comments.map((comment) =>
          comment.id === commentId ? { ...comment, removed: false, enabled: true } : comment,
        ),
      },
      snapshot: null,
    });
  },

  setCommentBody: (commentId, body) => {
    const draft = get().draft;
    if (!draft) {
      return;
    }
    set({
      draft: {
        ...draft,
        comments: draft.comments.map((comment) =>
          comment.id === commentId ? { ...comment, body } : comment,
        ),
      },
      snapshot: null,
    });
  },

  setOverallBody: (body) => {
    const draft = get().draft;
    if (!draft) {
      return;
    }
    set({
      draft: { ...draft, body },
      snapshot: null,
    });
  },

  setEvent: (event) => {
    const draft = get().draft;
    if (!draft) {
      return;
    }
    set({
      draft: { ...draft, event },
      snapshot: null,
    });
  },

  setPhase: (phase) => set({ phase }),

  setSnapshot: (snapshot) => set({ snapshot }),

  setSubmitResult: (submitResult) => set({ submitResult }),

  setSubmitError: (submitError, submitErrorCode = null) => set({ submitError, submitErrorCode }),

  markStaleIfDestinationMismatch: (live) => {
    const draft = get().draft;
    if (!draft) {
      return;
    }
    const owner = live.owner?.trim();
    const repository = live.repository?.trim();
    const number = live.pullRequestNumber;
    if (!owner || !repository || !number) {
      return;
    }
    const mismatch =
      owner !== draft.destination.owner ||
      repository !== draft.destination.repository ||
      number !== draft.destination.pullRequestNumber;
    if (mismatch && !draft.staleNavigation) {
      set({
        draft: { ...draft, staleNavigation: true },
        snapshot: null,
      });
    }
  },

  markFindingsReviewed: (findingIds) => findingIds,

  clearDraft: () => set({ ...INITIAL }),

  resetSubmissionUi: () =>
    set({
      snapshot: null,
      submitResult: null,
      submitError: null,
      submitErrorCode: null,
      phase: 'editing',
    }),
}));
