import { useEffect, useMemo } from 'react';
import type { PreparePullRequestPatchResponse } from '@project-x/types';

import { cn } from '~/lib/utils/cn';
import {
  applyPullRequestPatch,
  GithubApiError,
  preparePullRequestPatch,
} from '~/lib/services/github-api';

import { useGithubReviewDraftStore } from '../review-draft';
import { useGithubCiStore } from '../ci';
import { usePatchApplyStore, type SuggestFixApplyTarget } from './patch-apply.store';

function createClientRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `patch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildLineDiff(original: string, next: string, maxLines = 120): string[] {
  const a = original.replace(/\r\n/g, '\n').split('\n');
  const b = next.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && out.length < maxLines; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === right) {
      continue;
    }
    if (left !== undefined) {
      out.push(`-${left}`);
    }
    if (right !== undefined && out.length < maxLines) {
      out.push(`+${right}`);
    }
  }
  if (out.length >= maxLines) {
    out.push('…');
  }
  return out;
}

type ApplyFixPanelProps = {
  fixCode: string;
  target: SuggestFixApplyTarget;
  githubConnected?: boolean | null;
  onClose: () => void;
};

export function ApplyFixPanel({
  fixCode,
  target,
  githubConnected = null,
  onClose,
}: ApplyFixPanelProps) {
  const phase = usePatchApplyStore((s) => s.phase);
  const prepared = usePatchApplyStore((s) => s.prepared);
  const commitMessage = usePatchApplyStore((s) => s.commitMessage);
  const clientRequestId = usePatchApplyStore((s) => s.clientRequestId);
  const result = usePatchApplyStore((s) => s.result);
  const error = usePatchApplyStore((s) => s.error);
  const errorCode = usePatchApplyStore((s) => s.errorCode);
  const setPhase = usePatchApplyStore((s) => s.setPhase);
  const setPrepared = usePatchApplyStore((s) => s.setPrepared);
  const setCommitMessage = usePatchApplyStore((s) => s.setCommitMessage);
  const setClientRequestId = usePatchApplyStore((s) => s.setClientRequestId);
  const setResult = usePatchApplyStore((s) => s.setResult);
  const setError = usePatchApplyStore((s) => s.setError);
  const reset = usePatchApplyStore((s) => s.reset);

  const markReviewDraftStale = useGithubReviewDraftStore((s) => s.draft);

  useEffect(() => {
    usePatchApplyStore.getState().setTarget(target);
    return () => {
      // Keep prepared state while panel is remounted; only clear on explicit close/success leave.
    };
  }, [target]);

  const file = prepared?.files[0];
  const diffLines = useMemo(() => {
    if (!file) {
      return [];
    }
    return buildLineDiff(file.originalContent, file.newContent);
  }, [file]);

  async function handlePrepare() {
    setPhase('preparing');
    setError(null);
    try {
      const next = await preparePullRequestPatch(
        target.owner,
        target.repository,
        target.pullRequestNumber,
        {
          path: target.path,
          newContent: fixCode,
          commitMessage: `fix: ${target.findingTitle ?? target.path}`,
          findingId: target.findingId,
        },
      );
      setPrepared(next);
      setPhase('preview');
    } catch (err) {
      const message = err instanceof GithubApiError ? err.message : 'Unable to prepare the fix.';
      const code = err instanceof GithubApiError ? err.code : null;
      setError(message, code);
      setPhase(code === 'PR_HEAD_CHANGED' || code === 'FILE_CHANGED' ? 'stale' : 'error');
    }
  }

  function handleEnterConfirm(current: PreparePullRequestPatchResponse) {
    if (!commitMessage.trim()) {
      setError('Commit message must not be empty.', 'COMMIT_VALIDATION_FAILED');
      return;
    }
    setClientRequestId(createClientRequestId());
    setPhase('confirming');
    setError(null);
    void current;
  }

  async function handleApply() {
    if (!prepared || !clientRequestId) {
      return;
    }
    setPhase('applying');
    setError(null);
    const previousHead = prepared.expectedHeadSha;
    try {
      const applied = await applyPullRequestPatch(
        target.owner,
        target.repository,
        target.pullRequestNumber,
        {
          preparedPatchId: prepared.preparedPatchId,
          commitMessage: commitMessage.trim(),
          clientRequestId,
        },
      );
      setResult(applied);
      setPhase('success');

      useGithubCiStore.getState().invalidateAfterCommit(previousHead);

      // Invalidate review drafts bound to the previous head.
      const draft = markReviewDraftStale;
      if (draft?.expectedHeadSha && draft.expectedHeadSha === previousHead) {
        useGithubReviewDraftStore.setState({
          draft: { ...draft, staleNavigation: true, expectedHeadSha: previousHead },
          snapshot: null,
        });
      } else if (draft && !draft.expectedHeadSha) {
        // Still mark as potentially stale after a commit on same PR.
        if (
          draft.destination.owner === target.owner &&
          draft.destination.repository === target.repository &&
          draft.destination.pullRequestNumber === target.pullRequestNumber
        ) {
          useGithubReviewDraftStore.setState({
            draft: { ...draft, staleNavigation: true },
            snapshot: null,
          });
        }
      }
    } catch (err) {
      const message = err instanceof GithubApiError ? err.message : 'Unable to apply the fix.';
      const code = err instanceof GithubApiError ? err.code : null;
      setError(message, code);
      if (code === 'WRITE_OUTCOME_UNKNOWN') {
        setPhase('uncertain');
      } else if (
        code === 'PR_HEAD_CHANGED' ||
        code === 'FILE_CHANGED' ||
        code === 'PATCH_CONFLICT'
      ) {
        setPhase('stale');
      } else {
        setPhase('error');
      }
    }
  }

  if (phase === 'idle') {
    return (
      <div className="rounded-lg border border-border bg-surface px-2.5 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          Apply Fix
        </p>
        <p className="mt-1 text-[11px] leading-4 text-secondary">
          Prepare a commit on{' '}
          <span className="font-semibold text-primary">
            {target.owner}/{target.repository}#{target.pullRequestNumber}
          </span>{' '}
          for <span className="font-mono text-primary">{target.path}</span>. Nothing is written
          until you confirm.
        </p>
        {githubConnected === false ? (
          <p className="mt-2 text-[11px] text-[#e11d48]">
            Connect a GitHub token in dashboard Settings first.
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-1">
          <button
            type="button"
            disabled={githubConnected === false}
            onClick={() => {
              void handlePrepare();
            }}
            className="rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent disabled:opacity-40"
          >
            Apply Fix
          </button>
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'preparing') {
    return (
      <p className="rounded-lg border border-border bg-surface px-2.5 py-2 text-[11px] text-accent">
        Preparing fix against current PR head…
      </p>
    );
  }

  if (phase === 'success' && result) {
    return (
      <div className="rounded-lg border border-border bg-surface px-2.5 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">
          Fix applied
        </p>
        <p className="mt-1 font-mono text-[11px] text-primary">{result.commitSha.slice(0, 7)}</p>
        <p className="mt-0.5 text-[11px] text-secondary">
          {result.changedFiles} file changed · {result.branch}
          {result.deduplicated ? ' · replayed' : ''}
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          <a
            href={result.commitUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent"
          >
            View Commit
          </a>
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  if (
    phase === 'preview' ||
    phase === 'confirming' ||
    phase === 'applying' ||
    phase === 'error' ||
    phase === 'stale' ||
    phase === 'uncertain'
  ) {
    return (
      <div className="space-y-2 rounded-lg border border-border bg-surface px-2.5 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          {phase === 'confirming' || phase === 'applying' ? 'Confirm apply' : 'Apply Fix'}
        </p>
        {prepared ? (
          <>
            <p className="text-[11px] text-secondary">
              <span className="font-semibold text-primary">
                {prepared.headOwner}/{prepared.headRepository}
              </span>
              {' · '}PR #{prepared.pullRequestNumber}
              {' · '}
              <span className="font-mono">{prepared.headRef}</span>
            </p>
            <p className="font-mono text-[10px] text-muted">
              expected head {prepared.expectedHeadSha.slice(0, 7)}
            </p>
            {file ? (
              <div>
                <p className="text-[11px] font-semibold text-primary">{file.path}</p>
                <p className="text-[10px] text-muted">
                  +{file.additions} / −{file.deletions}
                </p>
                <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-elevated px-2 py-1.5 font-mono text-[10px] leading-4 text-secondary">
                  {diffLines.map((line, index) => (
                    <div
                      key={`${index}-${line.slice(0, 24)}`}
                      className={cn(
                        line.startsWith('+') && 'text-accent',
                        line.startsWith('-') && 'text-[#fb7185]',
                      )}
                    >
                      {line}
                    </div>
                  ))}
                </pre>
              </div>
            ) : null}
            <label className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
              Commit message
              <textarea
                value={commitMessage}
                disabled={phase === 'applying' || phase === 'uncertain'}
                onChange={(event) => setCommitMessage(event.target.value)}
                rows={2}
                className="mt-1 w-full resize-y rounded-md border border-border bg-elevated px-2 py-1.5 text-[11px] leading-4 text-primary outline-none focus:border-accent disabled:opacity-50"
              />
            </label>
          </>
        ) : null}

        {phase === 'applying' ? (
          <p className="text-[11px] text-accent">Applying fix & committing…</p>
        ) : null}
        {error ? (
          <p className="text-[11px] text-[#e11d48]">
            {error}
            {errorCode === 'WRITE_OUTCOME_UNKNOWN'
              ? ' Check the pull request before retrying.'
              : null}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-1">
          {phase === 'preview' ? (
            <button
              type="button"
              onClick={() => {
                if (prepared) {
                  handleEnterConfirm(prepared);
                }
              }}
              className="rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent"
            >
              Continue to confirm
            </button>
          ) : null}
          {phase === 'confirming' ? (
            <button
              type="button"
              disabled={!commitMessage.trim()}
              onClick={() => {
                void handleApply();
              }}
              className="rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent disabled:opacity-40"
            >
              Apply Fix & Commit
            </button>
          ) : null}
          <button
            type="button"
            disabled={phase === 'applying'}
            onClick={() => {
              if (phase === 'confirming') {
                setPhase('preview');
                setClientRequestId(null);
                return;
              }
              if (phase === 'uncertain' || phase === 'stale' || phase === 'error') {
                setPhase(prepared ? 'preview' : 'idle');
                return;
              }
              reset();
              onClose();
            }}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return null;
}

export function canOfferApplyFix(input: {
  fixCode: string | null | undefined;
  target: SuggestFixApplyTarget | null | undefined;
}): boolean {
  return Boolean(
    input.fixCode?.trim() &&
    input.target &&
    input.target.owner !== 'unknown' &&
    input.target.repository !== 'unknown' &&
    input.target.pullRequestNumber > 0 &&
    input.target.path.trim(),
  );
}
