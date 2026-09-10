import { AIAction } from '@project-x/types';

import { useSelectionToolbarStore } from '../store';
import { useGithubCiStore } from './ci.store';
import { CiFixSessionPanel } from './fix/ci-fix-panel';
import { useCIFixSessionStore } from './fix/ci-fix.store';
import { safeHttpsHref } from './safe-external-url';

export function CiCheckDetailPanel() {
  const destination = useGithubCiStore((s) => s.destination);
  const summary = useGithubCiStore((s) => s.summary);
  const selectedCheckId = useGithubCiStore((s) => s.selectedCheckId);
  const evidence = useGithubCiStore((s) => s.evidence);
  const analysis = useGithubCiStore((s) => s.analysis);
  const loadingEvidence = useGithubCiStore((s) => s.loadingEvidence);
  const analyzing = useGithubCiStore((s) => s.analyzing);
  const showEvidence = useGithubCiStore((s) => s.showEvidence);
  const error = useGithubCiStore((s) => s.error);
  const backToOverview = useGithubCiStore((s) => s.backToOverview);
  const analyzeSelected = useGithubCiStore((s) => s.analyzeSelected);
  const retryAnalyze = useGithubCiStore((s) => s.retryAnalyze);
  const setShowEvidence = useGithubCiStore((s) => s.setShowEvidence);
  const startAction = useSelectionToolbarStore((s) => s.startAction);
  const fixViewOpen = useCIFixSessionStore((s) => s.viewOpen);
  const startFixSession = useCIFixSessionStore((s) => s.startFromCheck);
  const attachAnalysis = useCIFixSessionStore((s) => s.attachAnalysis);

  const check = evidence?.check ?? summary?.checks.find((c) => c.id === selectedCheckId) ?? null;

  if (!destination || !check) {
    return (
      <div className="mt-2 rounded-lg border border-border bg-surface px-2.5 py-2">
        <p className="text-[11px] text-secondary">Check not found.</p>
        <button
          type="button"
          onClick={backToOverview}
          className="mt-2 rounded-md px-2 py-1 text-[11px] text-secondary hover:bg-hover"
        >
          Back
        </button>
      </div>
    );
  }

  if (fixViewOpen) {
    return <CiFixSessionPanel />;
  }

  const openUrl = safeHttpsHref(check.detailsUrl);
  const headShort = (evidence?.headSha ?? summary?.headSha ?? '').slice(0, 7);
  const failed =
    check.conclusion === 'FAILURE' ||
    check.conclusion === 'TIMED_OUT' ||
    check.conclusion === 'ACTION_REQUIRED';

  const handleFixCiFailure = () => {
    if (!summary || !failed) {
      return;
    }
    startFixSession({
      owner: destination.owner,
      repository: destination.repository,
      pullRequestNumber: destination.pullRequestNumber,
      sourceHeadSha: summary.headSha,
      sourceCheck: check,
      changedFilePaths: (destination.changedFiles ?? []).map((f) => f.path),
    });
    if (
      analysis &&
      evidence &&
      analysis.checkId === check.id &&
      analysis.headSha === summary.headSha
    ) {
      attachAnalysis(
        analysis,
        evidence,
        summary.headSha,
        (destination.changedFiles ?? []).map((f) => f.path),
      );
    } else {
      void analyzeSelected();
    }
  };

  const handleSuggestFix = () => {
    if (!analysis) {
      return;
    }
    const verifiedFixPath = analysis.affectedFiles.find((f) => f.verified)?.path;
    if (!verifiedFixPath) {
      return;
    }
    const seed = [
      `CI failure on ${check.name} (head ${headShort})`,
      analysis.likelyRootCause,
      ...analysis.suggestedNextSteps,
      ...(evidence?.annotations
        .filter((a) => a.path === verifiedFixPath)
        .map((a) => `${a.path}:${a.startLine ?? '?'} — ${a.message}`) ?? []),
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 8_000);

    useSelectionToolbarStore.setState({ selectedText: seed });
    void startAction(AIAction.SUGGEST_FIX, {
      applyTarget: {
        owner: destination.owner,
        repository: destination.repository,
        pullRequestNumber: destination.pullRequestNumber,
        path: verifiedFixPath,
        findingId: `ci:${check.id}`,
      },
    });
  };

  const verifiedFixPath = analysis?.affectedFiles.find((f) => f.verified)?.path;

  return (
    <div className="mt-2 max-h-[420px] overflow-y-auto rounded-lg border border-border bg-surface px-2.5 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">CI Failure</p>
      <p className="mt-0.5 text-[12px] font-semibold text-primary">{check.name}</p>
      <p className="text-[11px] text-secondary">
        Failed · PR #{destination.pullRequestNumber}
        {headShort ? ` · ${headShort}` : ''}
      </p>

      {loadingEvidence ? (
        <p className="mt-2 text-[11px] text-accent" role="status">
          Loading failure evidence…
        </p>
      ) : null}

      {error ? (
        <p className="mt-2 text-[11px] text-[#e11d48]" role="alert">
          {error}
        </p>
      ) : null}

      {analyzing ? (
        <p className="mt-2 text-[11px] text-accent" role="status">
          Reading failure evidence… correlating with PR changes… analyzing root cause…
        </p>
      ) : null}

      {analysis ? (
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
              Root cause
            </p>
            <p className="mt-1 text-[11px] leading-4 text-primary">{analysis.likelyRootCause}</p>
            <p className="mt-1 text-[10px] text-secondary">
              Confidence: {analysis.confidence} · Related to this PR:{' '}
              {analysis.relatedToPullRequest}
              {analysis.evidenceTruncated ? ' · Partial evidence' : ''}
            </p>
          </div>
        </div>
      ) : null}

      {showEvidence && evidence?.logExcerpt ? (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-hover p-2 font-mono text-[10px] text-secondary">
          {evidence.logExcerpt}
          {evidence.truncated ? '\n… (truncated)' : ''}
        </pre>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1 border-t border-border pt-2">
        {failed ? (
          <button
            type="button"
            disabled={analyzing || loadingEvidence || !summary}
            onClick={handleFixCiFailure}
            className="rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent disabled:opacity-40"
          >
            Fix CI Failure
          </button>
        ) : null}

        {!analysis ? (
          <button
            type="button"
            disabled={analyzing || loadingEvidence}
            onClick={() => {
              void analyzeSelected();
            }}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover disabled:opacity-40"
          >
            Analyze Failure
          </button>
        ) : (
          <button
            type="button"
            disabled={analyzing}
            onClick={() => {
              void retryAnalyze();
            }}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover"
          >
            Retry
          </button>
        )}

        {analysis?.canSuggestFix && verifiedFixPath ? (
          <button
            type="button"
            onClick={handleSuggestFix}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover"
          >
            Suggest Fix
          </button>
        ) : null}

        {evidence?.logExcerpt ? (
          <button
            type="button"
            onClick={() => setShowEvidence(!showEvidence)}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover"
          >
            {showEvidence ? 'Hide Evidence' : 'View Evidence'}
          </button>
        ) : null}

        {openUrl ? (
          <a
            href={openUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-md px-2 py-1 text-[11px] font-medium text-accent hover:bg-hover"
          >
            Open Check
          </a>
        ) : null}

        <button
          type="button"
          onClick={backToOverview}
          className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover"
        >
          Back
        </button>
      </div>
    </div>
  );
}
