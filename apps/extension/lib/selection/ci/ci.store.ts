import { create } from 'zustand';
import type {
  CICheckFailureEvidence,
  CIFailureAnalysis,
  CINormalizedCheck,
  GitHubWriteErrorCode,
  PageContextChangedFile,
  PullRequestCISummary,
} from '@project-x/types';

import {
  analyzeCheckFailure,
  fetchCheckFailureEvidence,
  fetchPullRequestChecks,
  GithubApiError,
} from '../../services/github-api';
import { useCIFixSessionStore } from './fix/ci-fix.store';

export type CiPanelView = 'closed' | 'overview' | 'check-detail';

export type CiDestination = {
  owner: string;
  repository: string;
  pullRequestNumber: number;
  pullRequestTitle?: string;
  changedFiles?: PageContextChangedFile[];
};

type CiState = {
  view: CiPanelView;
  destination: CiDestination | null;
  summary: PullRequestCISummary | null;
  /** Previous head after Apply Fix — summary for that SHA is stale. */
  staleAfterCommit: boolean;
  loadingSummary: boolean;
  selectedCheckId: string | null;
  evidence: CICheckFailureEvidence | null;
  loadingEvidence: boolean;
  analysis: CIFailureAnalysis | null;
  analyzing: boolean;
  showEvidence: boolean;
  error: string | null;
  errorCode: GitHubWriteErrorCode | null;
  abortController: AbortController | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  open: (destination: CiDestination) => void;
  close: () => void;
  backToOverview: () => void;
  refresh: () => Promise<void>;
  selectCheck: (checkId: string) => Promise<void>;
  analyzeSelected: () => Promise<void>;
  retryAnalyze: () => Promise<void>;
  setShowEvidence: (show: boolean) => void;
  invalidateAfterCommit: (previousHeadSha: string) => void;
  clearForNavigation: () => void;
};

const POLL_MS = 30_000;

function stopPolling(get: () => CiState, set: (partial: Partial<CiState>) => void): void {
  const timer = get().pollTimer;
  if (timer) {
    clearInterval(timer);
    set({ pollTimer: null });
  }
}

function maybeStartPolling(
  get: () => CiState,
  set: (partial: Partial<CiState>) => void,
  refresh: () => Promise<void>,
): void {
  stopPolling(get, set);
  const summary = get().summary;
  const fixSession = useCIFixSessionStore.getState().session;
  const waitingForCi =
    fixSession?.status === 'WAITING_FOR_NEW_CI' || fixSession?.status === 'VERIFYING';
  const shouldPoll =
    get().view !== 'closed' && (summary?.overallStatus === 'PENDING' || waitingForCi);
  if (!shouldPoll) {
    return;
  }
  const startedAt = Date.now();
  const MAX_POLL_MS = 15 * 60 * 1000;
  const timer = setInterval(() => {
    if (get().view === 'closed') {
      stopPolling(get, set);
      return;
    }
    const liveFix = useCIFixSessionStore.getState().session;
    const stillWaiting =
      liveFix?.status === 'WAITING_FOR_NEW_CI' || liveFix?.status === 'VERIFYING';
    const stillPending = get().summary?.overallStatus === 'PENDING';
    if ((!stillWaiting && !stillPending) || Date.now() - startedAt > MAX_POLL_MS) {
      stopPolling(get, set);
      return;
    }
    void refresh();
  }, POLL_MS);
  set({ pollTimer: timer });
}

export const useGithubCiStore = create<CiState>((set, get) => ({
  view: 'closed',
  destination: null,
  summary: null,
  staleAfterCommit: false,
  loadingSummary: false,
  selectedCheckId: null,
  evidence: null,
  loadingEvidence: false,
  analysis: null,
  analyzing: false,
  showEvidence: false,
  error: null,
  errorCode: null,
  abortController: null,
  pollTimer: null,

  open: (destination) => {
    get().abortController?.abort();
    stopPolling(get, set);
    set({
      view: 'overview',
      destination,
      summary: null,
      staleAfterCommit: false,
      selectedCheckId: null,
      evidence: null,
      analysis: null,
      showEvidence: false,
      error: null,
      errorCode: null,
      abortController: null,
    });
    void get().refresh();
  },

  close: () => {
    get().abortController?.abort();
    stopPolling(get, set);
    useCIFixSessionStore.getState().clear();
    set({
      view: 'closed',
      destination: null,
      summary: null,
      staleAfterCommit: false,
      selectedCheckId: null,
      evidence: null,
      analysis: null,
      analyzing: false,
      loadingEvidence: false,
      loadingSummary: false,
      showEvidence: false,
      error: null,
      errorCode: null,
      abortController: null,
    });
  },

  backToOverview: () => {
    get().abortController?.abort();
    set({
      view: 'overview',
      selectedCheckId: null,
      evidence: null,
      analysis: null,
      analyzing: false,
      loadingEvidence: false,
      showEvidence: false,
      error: null,
      errorCode: null,
      abortController: null,
    });
  },

  refresh: async () => {
    const destination = get().destination;
    if (!destination) {
      return;
    }
    get().abortController?.abort();
    const controller = new AbortController();
    const requestDest = { ...destination };
    set({
      loadingSummary: true,
      error: null,
      errorCode: null,
      abortController: controller,
      staleAfterCommit: false,
    });

    try {
      const summary = await fetchPullRequestChecks(
        requestDest.owner,
        requestDest.repository,
        requestDest.pullRequestNumber,
        controller.signal,
      );
      const live = get().destination;
      if (
        !live ||
        live.owner !== requestDest.owner ||
        live.repository !== requestDest.repository ||
        live.pullRequestNumber !== requestDest.pullRequestNumber
      ) {
        return;
      }
      set({ summary, loadingSummary: false, abortController: null });
      const fixStore = useCIFixSessionStore.getState();
      if (
        fixStore.session &&
        (fixStore.session.status === 'WAITING_FOR_NEW_CI' ||
          fixStore.session.status === 'VERIFYING')
      ) {
        fixStore.applyVerificationSummary(summary);
      } else if (fixStore.session) {
        fixStore.assertBinding({
          owner: summary.owner,
          repository: summary.repository,
          pullRequestNumber: summary.pullRequestNumber,
          headSha: summary.headSha,
        });
      }
      maybeStartPolling(get, set, () => get().refresh());
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      const message = err instanceof GithubApiError ? err.message : 'Unable to load CI status.';
      const code = err instanceof GithubApiError ? err.code : null;
      set({ loadingSummary: false, error: message, errorCode: code, abortController: null });
      stopPolling(get, set);
    }
  },

  selectCheck: async (checkId) => {
    const destination = get().destination;
    const summary = get().summary;
    if (!destination || !summary) {
      return;
    }
    get().abortController?.abort();
    const controller = new AbortController();
    const boundHead = summary.headSha;
    set({
      view: 'check-detail',
      selectedCheckId: checkId,
      evidence: null,
      analysis: null,
      showEvidence: false,
      loadingEvidence: true,
      error: null,
      errorCode: null,
      abortController: controller,
    });

    try {
      const evidence = await fetchCheckFailureEvidence(
        destination.owner,
        destination.repository,
        destination.pullRequestNumber,
        checkId,
        controller.signal,
      );
      if (get().selectedCheckId !== checkId) {
        return;
      }
      if (evidence.headSha !== boundHead || get().summary?.headSha !== evidence.headSha) {
        set({
          loadingEvidence: false,
          error: 'The pull request changed while loading this check. Refresh the CI status.',
          errorCode: 'STALE_CI_CONTEXT',
          abortController: null,
        });
        return;
      }
      set({ evidence, loadingEvidence: false, abortController: null });
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      const message = err instanceof GithubApiError ? err.message : 'Unable to load check details.';
      const code = err instanceof GithubApiError ? err.code : null;
      set({ loadingEvidence: false, error: message, errorCode: code, abortController: null });
    }
  },

  analyzeSelected: async () => {
    const destination = get().destination;
    const summary = get().summary;
    const checkId = get().selectedCheckId;
    if (!destination || !summary || !checkId) {
      return;
    }
    get().abortController?.abort();
    const controller = new AbortController();
    const bound = {
      headSha: summary.headSha,
      checkId,
      owner: destination.owner,
      repository: destination.repository,
      pullRequestNumber: destination.pullRequestNumber,
    };
    set({ analyzing: true, error: null, errorCode: null, abortController: controller });

    try {
      const result = await analyzeCheckFailure(
        bound.owner,
        bound.repository,
        bound.pullRequestNumber,
        bound.checkId,
        {
          expectedHeadSha: bound.headSha,
          changedFiles: (destination.changedFiles ?? []).map((f) => ({ path: f.path })),
          pullRequestTitle: destination.pullRequestTitle,
        },
        controller.signal,
      );
      if (
        get().selectedCheckId !== bound.checkId ||
        get().summary?.headSha !== bound.headSha ||
        get().destination?.pullRequestNumber !== bound.pullRequestNumber
      ) {
        return;
      }
      if (result.analysis.headSha !== bound.headSha || result.analysis.checkId !== bound.checkId) {
        set({
          analyzing: false,
          error:
            'The pull request changed while this CI result was being analyzed. Refresh the CI status.',
          errorCode: 'STALE_CI_CONTEXT',
          abortController: null,
        });
        return;
      }
      set({
        analysis: result.analysis,
        evidence: result.evidence,
        analyzing: false,
        abortController: null,
      });
      const fixStore = useCIFixSessionStore.getState();
      if (
        fixStore.session &&
        fixStore.session.sourceCheck.id === bound.checkId &&
        (fixStore.session.status === 'ANALYZING' || fixStore.viewOpen)
      ) {
        fixStore.attachAnalysis(
          result.analysis,
          result.evidence,
          bound.headSha,
          (destination.changedFiles ?? []).map((f) => f.path),
        );
      }
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      const message =
        err instanceof GithubApiError ? err.message : 'Unable to analyze this CI failure.';
      const code = err instanceof GithubApiError ? err.code : null;
      set({ analyzing: false, error: message, errorCode: code, abortController: null });
      const fixStore = useCIFixSessionStore.getState();
      if (fixStore.session?.status === 'ANALYZING') {
        fixStore.setError(message, code);
      }
    }
  },

  retryAnalyze: async () => {
    const summary = get().summary;
    const evidence = get().evidence;
    if (!summary || !evidence || evidence.headSha !== summary.headSha) {
      set({
        error: 'CI evidence is stale. Refresh the CI status, then analyze again.',
        errorCode: 'STALE_CI_CONTEXT',
      });
      return;
    }
    await get().analyzeSelected();
  },

  setShowEvidence: (show) => set({ showEvidence: show }),

  invalidateAfterCommit: (previousHeadSha) => {
    const summary = get().summary;
    if (summary && summary.headSha === previousHeadSha) {
      set({
        summary: null,
        staleAfterCommit: true,
        selectedCheckId: null,
        evidence: null,
        analysis: null,
        error: null,
        errorCode: null,
      });
      stopPolling(get, set);
    } else if (get().view !== 'closed') {
      set({
        summary: null,
        staleAfterCommit: true,
        selectedCheckId: null,
        evidence: null,
        analysis: null,
      });
      stopPolling(get, set);
    }
  },

  clearForNavigation: () => {
    if (get().view === 'closed') {
      useCIFixSessionStore.getState().clear();
      return;
    }
    get().close();
    useCIFixSessionStore.getState().clear();
  },
}));

export function formatCiEntryLabel(summary: PullRequestCISummary | null): string {
  if (!summary) {
    return 'CI';
  }
  const { counts, overallStatus } = summary;
  if (overallStatus === 'PENDING') {
    return counts.pending > 0 ? `CI · Running` : 'CI · Pending';
  }
  if (overallStatus === 'FAILURE') {
    return `CI · ${counts.failed} failed`;
  }
  if (overallStatus === 'SUCCESS') {
    if (counts.total > 0 && counts.passed === counts.total) {
      return 'CI · Passed';
    }
    return `CI · ${counts.passed}/${counts.total} passed`;
  }
  if (overallStatus === 'CANCELLED') {
    return 'CI · Cancelled';
  }
  return `CI · ${overallStatus}`;
}

export function findCheck(
  summary: PullRequestCISummary | null,
  checkId: string | null,
): CINormalizedCheck | null {
  if (!summary || !checkId) {
    return null;
  }
  return summary.checks.find((c) => c.id === checkId) ?? null;
}
