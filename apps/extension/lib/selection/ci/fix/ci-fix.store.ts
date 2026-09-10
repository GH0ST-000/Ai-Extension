import { create } from 'zustand';
import {
  buildCIFailureSignature,
  resolveCIFixTargets,
  selectPrimaryCIFixTarget,
  verificationToSessionStatus,
  verifyCIFixAgainstSummary,
} from '@project-x/shared';
import type {
  CICheckFailureEvidence,
  CIFailureAnalysis,
  CIFixSession,
  CIFixSessionStatus,
  CIFixTarget,
  CINormalizedCheck,
  GitHubWriteErrorCode,
  PullRequestCISummary,
} from '@project-x/types';

function nowIso(): string {
  return new Date().toISOString();
}

function createSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ci-fix-${Date.now()}`;
}

function touch(session: CIFixSession, patch: Partial<CIFixSession>): CIFixSession {
  return { ...session, ...patch, updatedAt: nowIso() };
}

export type CIFixSessionBinding = {
  owner: string;
  repository: string;
  pullRequestNumber: number;
  sourceHeadSha: string;
  sourceCheck: CINormalizedCheck;
  changedFilePaths?: string[];
};

type CIFixStore = {
  session: CIFixSession | null;
  viewOpen: boolean;
  /** Start or resume fix flow for an explicitly selected failed check. */
  startFromCheck: (binding: CIFixSessionBinding) => void;
  attachAnalysis: (
    analysis: CIFailureAnalysis,
    evidence: CICheckFailureEvidence,
    expectedHeadSha: string,
    changedFilePaths?: string[],
  ) => void;
  selectTarget: (filePath: string) => void;
  markSuggesting: () => void;
  markSuggested: (summary: string) => void;
  markPatchReady: () => void;
  markApplying: () => void;
  recordCommit: (input: {
    sha: string;
    url?: string;
    branch?: string;
    /** Must match session source head that was prepared against. */
    previousHeadSha: string;
  }) => void;
  /** Apply verification using a CI summary for the post-commit head. */
  applyVerificationSummary: (summary: PullRequestCISummary) => void;
  markStale: (message?: string) => void;
  setError: (message: string, code?: GitHubWriteErrorCode | null) => void;
  assertBinding: (live: {
    owner?: string;
    repository?: string;
    pullRequestNumber?: number;
    headSha?: string;
  }) => boolean;
  openView: () => void;
  closeView: () => void;
  clear: () => void;
};

function deriveStatusAfterTargets(
  targets: CIFixTarget[],
): Pick<
  CIFixSession,
  'status' | 'selectedTarget' | 'candidateTargets' | 'errorCode' | 'errorMessage'
> {
  const decision = selectPrimaryCIFixTarget(targets);
  if (decision.insufficient) {
    return {
      status: 'ERROR',
      candidateTargets: targets,
      selectedTarget: undefined,
      errorCode: 'FIX_CONTEXT_INSUFFICIENT',
      errorMessage: 'There isn’t enough trusted code context to generate a safe fix.',
    };
  }
  if (decision.ambiguous) {
    return {
      status: 'TARGET_REQUIRED',
      candidateTargets: targets,
      selectedTarget: undefined,
      errorCode: 'FIX_TARGET_AMBIGUOUS',
      errorMessage:
        'More than one code location may be causing this failure. Choose the target to inspect.',
    };
  }
  return {
    status: 'READY_TO_SUGGEST',
    candidateTargets: targets,
    selectedTarget: decision.selected,
    errorCode: undefined,
    errorMessage: undefined,
  };
}

export const useCIFixSessionStore = create<CIFixStore>((set, get) => ({
  session: null,
  viewOpen: false,

  startFromCheck: (binding) => {
    const createdAt = nowIso();
    set({
      viewOpen: true,
      session: {
        id: createSessionId(),
        repository: { owner: binding.owner, name: binding.repository },
        pullRequestNumber: binding.pullRequestNumber,
        sourceHeadSha: binding.sourceHeadSha,
        sourceCheck: {
          id: binding.sourceCheck.id,
          name: binding.sourceCheck.name,
          status: binding.sourceCheck.status,
          conclusion: binding.sourceCheck.conclusion,
        },
        candidateTargets: [],
        status: 'ANALYZING',
        createdAt,
        updatedAt: createdAt,
      },
    });
  },

  attachAnalysis: (analysis, evidence, expectedHeadSha, changedFilePaths) => {
    const session = get().session;
    if (!session) {
      return;
    }
    if (
      analysis.headSha !== session.sourceHeadSha ||
      expectedHeadSha !== session.sourceHeadSha ||
      evidence.headSha !== session.sourceHeadSha ||
      analysis.checkId !== session.sourceCheck.id
    ) {
      set({
        session: touch(session, {
          status: 'STALE',
          errorCode: 'FIX_SESSION_STALE',
          errorMessage: 'This fix attempt belongs to an older version of the pull request.',
        }),
      });
      return;
    }

    const paths = [
      ...(changedFilePaths ?? []),
      ...analysis.affectedFiles.filter((f) => f.verified).map((f) => f.path),
    ];
    const targets = resolveCIFixTargets({
      analysis,
      evidence,
      changedFilePaths: paths,
    });
    const derived = deriveStatusAfterTargets(targets);
    const signature = buildCIFailureSignature({
      checkName: session.sourceCheck.name,
      evidence,
      analysis,
    });

    set({
      session: touch(session, {
        analysis,
        previousFailureSignature: signature,
        ...derived,
      }),
    });
  },

  selectTarget: (filePath) => {
    const session = get().session;
    if (!session || session.status === 'STALE') {
      return;
    }
    const target = session.candidateTargets.find((t) => t.filePath === filePath);
    if (!target || !target.verified) {
      set({
        session: touch(session, {
          status: 'ERROR',
          errorCode: 'FIX_TARGET_INVALID',
          errorMessage: 'The selected fix target is not valid for this repository.',
        }),
      });
      return;
    }
    set({
      session: touch(session, {
        selectedTarget: target,
        status: 'READY_TO_SUGGEST',
        errorCode: undefined,
        errorMessage: undefined,
      }),
    });
  },

  markSuggesting: () => {
    const session = get().session;
    if (!session || !session.selectedTarget) {
      return;
    }
    if (session.status === 'STALE') {
      return;
    }
    set({ session: touch(session, { status: 'SUGGESTING' }) });
  },

  markSuggested: (summary) => {
    const session = get().session;
    if (!session) {
      return;
    }
    set({
      session: touch(session, {
        status: 'SUGGESTED',
        suggestion: { summary: summary.slice(0, 4_000), createdAt: nowIso() },
      }),
    });
  },

  markPatchReady: () => {
    const session = get().session;
    if (!session) {
      return;
    }
    set({ session: touch(session, { status: 'PATCH_READY' }) });
  },

  markApplying: () => {
    const session = get().session;
    if (!session) {
      return;
    }
    set({ session: touch(session, { status: 'APPLYING' }) });
  },

  recordCommit: (input) => {
    const session = get().session;
    if (!session) {
      return;
    }
    if (input.previousHeadSha !== session.sourceHeadSha) {
      set({
        session: touch(session, {
          status: 'STALE',
          errorCode: 'FIX_SESSION_STALE',
          errorMessage: 'This fix attempt belongs to an older version of the pull request.',
        }),
      });
      return;
    }
    set({
      session: touch(session, {
        status: 'WAITING_FOR_NEW_CI',
        appliedCommit: {
          sha: input.sha,
          url: input.url,
          branch: input.branch,
        },
        currentHeadSha: input.sha,
        verification: undefined,
        originalFailureCleared: false,
      }),
    });
  },

  applyVerificationSummary: (summary) => {
    const session = get().session;
    if (!session || !session.appliedCommit || !session.currentHeadSha) {
      return;
    }
    if (
      summary.owner !== session.repository.owner ||
      summary.repository !== session.repository.name ||
      summary.pullRequestNumber !== session.pullRequestNumber
    ) {
      set({
        session: touch(session, {
          status: 'STALE',
          errorCode: 'VERIFICATION_CONTEXT_STALE',
          errorMessage: 'CI results belong to a different pull request than this fix attempt.',
        }),
      });
      return;
    }

    if (summary.headSha !== session.currentHeadSha) {
      // New head moved again — treat as stale for this attempt
      if (session.status === 'WAITING_FOR_NEW_CI' || session.status === 'VERIFYING') {
        set({
          session: touch(session, {
            status: 'STALE',
            errorCode: 'VERIFICATION_CONTEXT_STALE',
            errorMessage: 'The pull request head changed after this fix was committed.',
          }),
        });
      }
      return;
    }

    let currentSignature = session.previousFailureSignature;
    const matchedName = session.sourceCheck.name;
    const matched = summary.checks.find(
      (c) => c.name.trim().toLowerCase() === matchedName.trim().toLowerCase(),
    );
    if (matched && (matched.conclusion === 'FAILURE' || matched.conclusion === 'TIMED_OUT')) {
      // Best-effort: signature from check name only until detail reloaded
      currentSignature = buildCIFailureSignature({
        checkName: matched.name,
        analysis: session.analysis,
      });
    }

    const verification = verifyCIFixAgainstSummary({
      originalCheckId: session.sourceCheck.id,
      originalCheckName: session.sourceCheck.name,
      originalHeadSha: session.sourceHeadSha,
      newHeadSha: session.currentHeadSha,
      summary,
      previousFailureSignature: session.previousFailureSignature,
      currentFailureSignature: currentSignature,
    });

    const nextStatus: CIFixSessionStatus = verificationToSessionStatus(verification.status);
    set({
      session: touch(session, {
        verification,
        status: nextStatus,
        originalFailureCleared:
          verification.status === 'PASSED' || verification.status === 'DIFFERENT_FAILURE',
      }),
    });
  },

  markStale: (message) => {
    const session = get().session;
    if (!session) {
      return;
    }
    set({
      session: touch(session, {
        status: 'STALE',
        errorCode: 'FIX_SESSION_STALE',
        errorMessage:
          message ?? 'This fix attempt belongs to an older version of the pull request.',
      }),
    });
  },

  setError: (message, code) => {
    const session = get().session;
    if (!session) {
      return;
    }
    set({
      session: touch(session, {
        status: 'ERROR',
        errorMessage: message,
        errorCode: code ?? 'UNKNOWN',
      }),
    });
  },

  assertBinding: (live) => {
    const session = get().session;
    if (!session) {
      return false;
    }
    const owner = live.owner?.trim();
    const repository = live.repository?.trim();
    const number = live.pullRequestNumber;
    if (
      (owner && owner !== session.repository.owner) ||
      (repository && repository !== session.repository.name) ||
      (number && number !== session.pullRequestNumber)
    ) {
      get().markStale();
      return false;
    }
    if (live.headSha && live.headSha !== session.sourceHeadSha && !session.appliedCommit) {
      get().markStale(
        'The pull request changed since this CI failure was analyzed. Refresh CI and start a new fix attempt.',
      );
      return false;
    }
    if (
      session.appliedCommit &&
      live.headSha &&
      session.currentHeadSha &&
      live.headSha !== session.currentHeadSha &&
      live.headSha !== session.sourceHeadSha
    ) {
      get().markStale('The pull request head changed after this fix was committed.');
      return false;
    }
    return true;
  },

  openView: () => set({ viewOpen: true }),
  closeView: () => set({ viewOpen: false }),

  clear: () => set({ session: null, viewOpen: false }),
}));
