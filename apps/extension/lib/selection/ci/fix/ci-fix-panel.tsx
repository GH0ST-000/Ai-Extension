import { AIAction } from '@project-x/types';
import type { CIFixSessionStatus } from '@project-x/types';

import { useSelectionToolbarStore } from '../../store';
import { useGithubCiStore } from '../ci.store';
import { safeHttpsHref } from '../safe-external-url';
import {
  buildCiSuggestFixCustomPrompt,
  buildCiSuggestFixSelectedText,
} from './build-ci-suggest-context';
import { useCIFixSessionStore } from './ci-fix.store';

function stageIndex(status: CIFixSessionStatus): number {
  switch (status) {
    case 'ANALYZING':
    case 'ANALYZED':
    case 'TARGET_REQUIRED':
      return 0;
    case 'READY_TO_SUGGEST':
    case 'SUGGESTING':
    case 'SUGGESTED':
      return 1;
    case 'PATCH_READY':
      return 2;
    case 'APPLYING':
    case 'COMMIT_CREATED':
      return 3;
    case 'WAITING_FOR_NEW_CI':
    case 'VERIFYING':
    case 'PASSED':
    case 'STILL_FAILING':
    case 'DIFFERENT_FAILURE':
    case 'CHECK_NOT_FOUND':
      return 4;
    default:
      return 0;
  }
}

const STAGES = ['Analyze', 'Fix', 'Patch', 'Apply', 'Verify'] as const;

export function CiFixSessionPanel() {
  const session = useCIFixSessionStore((s) => s.session);
  const viewOpen = useCIFixSessionStore((s) => s.viewOpen);
  const selectTarget = useCIFixSessionStore((s) => s.selectTarget);
  const markSuggesting = useCIFixSessionStore((s) => s.markSuggesting);
  const clear = useCIFixSessionStore((s) => s.clear);
  const closeView = useCIFixSessionStore((s) => s.closeView);
  const destination = useGithubCiStore((s) => s.destination);
  const evidence = useGithubCiStore((s) => s.evidence);
  const summary = useGithubCiStore((s) => s.summary);
  const refresh = useGithubCiStore((s) => s.refresh);
  const selectCheck = useGithubCiStore((s) => s.selectCheck);
  const analyzeSelected = useGithubCiStore((s) => s.analyzeSelected);
  const startAction = useSelectionToolbarStore((s) => s.startAction);

  if (!viewOpen || !session || !destination) {
    return null;
  }

  const active = stageIndex(session.status);
  const headShort = session.sourceHeadSha.slice(0, 7);
  const commitShort = session.appliedCommit?.sha.slice(0, 7);
  const openCommit = safeHttpsHref(session.appliedCommit?.url);

  const handleSuggestFix = () => {
    if (!session.analysis || !session.selectedTarget) {
      return;
    }
    if (session.status === 'STALE') {
      return;
    }
    markSuggesting();
    const customPrompt = buildCiSuggestFixCustomPrompt({
      checkName: session.sourceCheck.name,
      headSha: session.sourceHeadSha,
      analysis: session.analysis,
      target: session.selectedTarget,
      evidence,
    });
    const selectedText = buildCiSuggestFixSelectedText({
      checkName: session.sourceCheck.name,
      target: session.selectedTarget,
      analysis: session.analysis,
    });
    useSelectionToolbarStore.setState({ selectedText });
    void startAction(AIAction.SUGGEST_FIX, {
      customPrompt,
      applyTarget: {
        owner: session.repository.owner,
        repository: session.repository.name,
        pullRequestNumber: session.pullRequestNumber,
        path: session.selectedTarget.filePath,
        findingId: `ci-fix:${session.id}`,
        findingTitle: session.sourceCheck.name,
      },
    });
  };

  const handleAnalyzeNewFailure = () => {
    const checkId = session.verification?.matchedCheckId ?? session.sourceCheck.id;
    clear();
    void selectCheck(checkId).then(() => {
      void analyzeSelected();
    });
  };

  return (
    <div className="mt-2 max-h-[440px] overflow-y-auto rounded-lg border border-border bg-surface px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">CI Fix</p>
          <p className="mt-0.5 text-[12px] font-semibold text-primary">
            {session.sourceCheck.name}
          </p>
          <p className="text-[11px] text-secondary">
            PR #{session.pullRequestNumber} · {headShort}
          </p>
        </div>
        <button
          type="button"
          onClick={closeView}
          className="rounded-md px-1.5 py-0.5 text-[11px] text-secondary hover:bg-hover"
          aria-label="Close CI Fix panel"
        >
          Close
        </button>
      </div>

      <ol className="mt-2 flex flex-wrap gap-1" aria-label="CI Fix stages">
        {STAGES.map((label, index) => (
          <li
            key={label}
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              index === active
                ? 'bg-accent-soft font-semibold text-accent'
                : index < active
                  ? 'text-primary'
                  : 'text-muted'
            }`}
            aria-current={index === active ? 'step' : undefined}
          >
            {index + 1} {label}
          </li>
        ))}
      </ol>

      {session.errorMessage ? (
        <p className="mt-2 text-[11px] text-[#e11d48]" role="alert">
          {session.errorMessage}
        </p>
      ) : null}

      {session.status === 'ANALYZING' ? (
        <p className="mt-2 text-[11px] text-accent" role="status">
          Analyzing failure…
        </p>
      ) : null}

      {session.analysis && session.status !== 'ANALYZING' ? (
        <div className="mt-2 border-t border-border pt-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            Failure analyzed
          </p>
          <p className="mt-1 text-[11px] leading-4 text-primary">
            {session.analysis.likelyRootCause}
          </p>
          <p className="mt-1 text-[10px] text-secondary">
            Confidence: {session.analysis.confidence}
            {session.selectedTarget ? ` · Likely file: ${session.selectedTarget.filePath}` : ''}
          </p>
        </div>
      ) : null}

      {session.status === 'TARGET_REQUIRED' ? (
        <fieldset className="mt-2 border-t border-border pt-2">
          <legend className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            Possible fix targets
          </legend>
          <ul className="mt-1 space-y-1">
            {session.candidateTargets.map((target) => (
              <li key={target.filePath}>
                <label className="flex cursor-pointer items-start gap-1.5 rounded-md px-1 py-1 text-[11px] hover:bg-hover">
                  <input
                    type="radio"
                    name="ci-fix-target"
                    className="mt-0.5"
                    onChange={() => selectTarget(target.filePath)}
                  />
                  <span>
                    <span className="font-medium text-primary">{target.filePath}</span>
                    <span className="block text-[10px] text-secondary">
                      {target.reason ?? target.source}
                      {target.inPullRequestDiff ? ' · Changed in this PR' : ''}
                      {' · '}
                      {target.trust}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}

      {session.status === 'READY_TO_SUGGEST' || session.status === 'SUGGESTING' ? (
        <div className="mt-2 border-t border-border pt-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            Suggested change
          </p>
          <p className="mt-1 text-[11px] text-secondary">
            Generate a minimal suggested change for{' '}
            <span className="font-mono text-primary">{session.selectedTarget?.filePath}</span>. Not
            verified until CI passes.
          </p>
          <button
            type="button"
            disabled={session.status === 'SUGGESTING' || !session.selectedTarget}
            onClick={handleSuggestFix}
            className="mt-2 rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent disabled:opacity-40"
          >
            {session.status === 'SUGGESTING' ? 'Suggesting…' : 'Suggest Fix'}
          </button>
        </div>
      ) : null}

      {session.status === 'SUGGESTED' || session.status === 'PATCH_READY' ? (
        <div className="mt-2 border-t border-border pt-2">
          <p className="text-[11px] text-secondary">
            Suggested change ready. Use Generate/Apply Fix in the result panel — Day 14 confirmation
            is required before any commit.
          </p>
        </div>
      ) : null}

      {session.status === 'WAITING_FOR_NEW_CI' || session.status === 'VERIFYING' ? (
        <div className="mt-2 border-t border-border pt-2" role="status">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            Fix committed
          </p>
          <p className="mt-1 font-mono text-[11px] text-primary">{commitShort}</p>
          <p className="mt-1 text-[11px] text-secondary">
            CI has not verified this change yet. Refresh when checks run for the new commit.
          </p>
          {openCommit ? (
            <a
              href={openCommit}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-[11px] text-accent"
            >
              View commit
            </a>
          ) : null}
          <button
            type="button"
            onClick={() => {
              void refresh();
            }}
            className="mt-2 rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent"
          >
            Refresh CI
          </button>
        </div>
      ) : null}

      {session.status === 'PASSED' && session.verification ? (
        <div className="mt-2 border-t border-border pt-2" role="status">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">
            CI Fix verified
          </p>
          <p className="mt-1 text-[11px] text-secondary">
            {session.sourceCheck.name}: {headShort} failed → {commitShort} passed.
          </p>
          {session.verification.otherChecksFailing ? (
            <p className="mt-1 text-[11px] text-secondary">
              The targeted check now passes. Other CI checks are still failing.
            </p>
          ) : summary?.overallStatus === 'SUCCESS' ? (
            <p className="mt-1 text-[11px] text-secondary">Overall CI for this head is passing.</p>
          ) : (
            <p className="mt-1 text-[11px] text-secondary">
              The selected CI check now passes on the updated PR.
            </p>
          )}
        </div>
      ) : null}

      {session.status === 'STILL_FAILING' ? (
        <div className="mt-2 border-t border-border pt-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            CI Fix not verified
          </p>
          <p className="mt-1 text-[11px] text-secondary">
            The check still fails on commit {commitShort}. The failure appears to be the same.
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            <button
              type="button"
              onClick={handleAnalyzeNewFailure}
              className="rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent"
            >
              Analyze Again
            </button>
            <button
              type="button"
              onClick={() => {
                void refresh();
              }}
              className="rounded-md px-2 py-1 text-[11px] text-secondary hover:bg-hover"
            >
              Refresh CI
            </button>
          </div>
        </div>
      ) : null}

      {session.status === 'DIFFERENT_FAILURE' ? (
        <div className="mt-2 border-t border-border pt-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            CI changed
          </p>
          <p className="mt-1 text-[11px] text-secondary">
            The original failure appears to have changed. The check still fails, but current
            evidence points to a different problem.
          </p>
          <button
            type="button"
            onClick={handleAnalyzeNewFailure}
            className="mt-2 rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent"
          >
            Analyze New Failure
          </button>
        </div>
      ) : null}

      {session.status === 'CHECK_NOT_FOUND' ? (
        <div className="mt-2 border-t border-border pt-2">
          <p className="text-[11px] text-secondary">
            The original check has not appeared for the new commit.
          </p>
          <button
            type="button"
            onClick={() => {
              void refresh();
            }}
            className="mt-2 rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent"
          >
            Refresh CI
          </button>
        </div>
      ) : null}

      {session.status === 'STALE' ? (
        <div className="mt-2 flex flex-wrap gap-1 border-t border-border pt-2">
          <button
            type="button"
            onClick={() => {
              clear();
              void refresh();
            }}
            className="rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent"
          >
            Start New Fix Attempt
          </button>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1 border-t border-border pt-2">
        <button
          type="button"
          onClick={closeView}
          className="rounded-md px-2 py-1 text-[11px] text-secondary hover:bg-hover"
        >
          Back to CI
        </button>
      </div>
    </div>
  );
}
