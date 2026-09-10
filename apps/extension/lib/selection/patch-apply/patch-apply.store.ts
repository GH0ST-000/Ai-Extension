import { create } from 'zustand';
import type {
  ApplyPullRequestPatchResponse,
  PreparePullRequestPatchResponse,
} from '@project-x/types';

export type PatchApplyPhase =
  | 'idle'
  | 'preparing'
  | 'preview'
  | 'confirming'
  | 'applying'
  | 'success'
  | 'error'
  | 'stale'
  | 'uncertain';

/** Trusted destination for Apply Fix — never from AI prose. */
export type SuggestFixApplyTarget = {
  owner: string;
  repository: string;
  pullRequestNumber: number;
  path: string;
  findingId?: string;
  findingTitle?: string;
};

type PatchApplyState = {
  phase: PatchApplyPhase;
  target: SuggestFixApplyTarget | null;
  prepared: PreparePullRequestPatchResponse | null;
  commitMessage: string;
  clientRequestId: string | null;
  result: ApplyPullRequestPatchResponse | null;
  error: string | null;
  errorCode: string | null;
  setTarget: (target: SuggestFixApplyTarget | null) => void;
  setPhase: (phase: PatchApplyPhase) => void;
  setPrepared: (prepared: PreparePullRequestPatchResponse | null) => void;
  setCommitMessage: (message: string) => void;
  setClientRequestId: (id: string | null) => void;
  setResult: (result: ApplyPullRequestPatchResponse | null) => void;
  setError: (message: string | null, code?: string | null) => void;
  reset: () => void;
  /** After a successful commit, mark related review drafts stale by head SHA. */
  invalidateAfterCommit: (previousHeadSha: string) => void;
};

const INITIAL = {
  phase: 'idle' as PatchApplyPhase,
  target: null as SuggestFixApplyTarget | null,
  prepared: null as PreparePullRequestPatchResponse | null,
  commitMessage: '',
  clientRequestId: null as string | null,
  result: null as ApplyPullRequestPatchResponse | null,
  error: null as string | null,
  errorCode: null as string | null,
};

export const usePatchApplyStore = create<PatchApplyState>((set) => ({
  ...INITIAL,

  setTarget: (target) => set({ target }),

  setPhase: (phase) => set({ phase }),

  setPrepared: (prepared) =>
    set({
      prepared,
      commitMessage: prepared?.commitMessage ?? '',
      clientRequestId: null,
      result: null,
      error: null,
      errorCode: null,
    }),

  setCommitMessage: (commitMessage) =>
    set({
      commitMessage,
      // Changing commit message invalidates an in-flight confirmation id.
      clientRequestId: null,
    }),

  setClientRequestId: (clientRequestId) => set({ clientRequestId }),

  setResult: (result) => set({ result }),

  setError: (error, errorCode = null) => set({ error, errorCode }),

  reset: () => set({ ...INITIAL }),

  invalidateAfterCommit: (_previousHeadSha) => {
    // Wired from toolbar to review-draft store to avoid circular imports at module load.
    set({ phase: 'success' });
  },
}));
