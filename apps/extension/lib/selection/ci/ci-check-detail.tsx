import { AIAction } from '@project-x/types';

import { useSelectionToolbarStore } from '../store';
import { useGithubCiStore } from './ci.store';
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

  const openUrl = safeHttpsHref(check.detailsUrl);
  const headShort = (evidence?.headSha ?? summary?.headSha ?? '').slice(0, 7);
  const verifiedFixPath = analysis?.affectedFiles.find((f) => f.verified)?.path;

  const handleSuggestFix = () => {
    if (!analysis || !verifiedFixPath) {
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

          {analysis.evidence.length > 0 ? (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                Evidence
              </p>
              <ul className="mt-1 space-y-1.5">
                {analysis.evidence.slice(0, 6).map((item, index) => (
                  <li key={`${item.source}-${index}`} className="text-[11px] text-secondary">
                    <span className="font-medium text-primary">
                      {item.path
                        ? `${item.path}${item.startLine ? `:${item.startLine}` : ''}`
                        : item.label}
                    </span>
                    <span className="mt-0.5 block whitespace-pre-wrap font-mono text-[10px] text-secondary">
                      {item.excerpt.slice(0, 400)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {analysis.suggestedNextSteps.length > 0 ? (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                Suggested next steps
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-secondary">
                {analysis.suggestedNextSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {!analysis && evidence && !analyzing ? (
        <div className="mt-2 border-t border-border pt-2">
          <p className="text-[11px] text-secondary">
            {evidence.summaryText?.slice(0, 280) ||
              (evidence.annotations[0]?.message ?? 'Failure metadata loaded.')}
          </p>
          {evidence.logsUnavailable && evidence.annotations.length === 0 ? (
            <p className="mt-1 text-[10px] text-muted">
              Detailed logs are not available for this check (third-party or restricted).
            </p>
          ) : null}
        </div>
      ) : null}

      {showEvidence && evidence?.logExcerpt ? (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-hover p-2 font-mono text-[10px] text-secondary">
          {evidence.logExcerpt}
          {evidence.truncated ? '\n… (truncated)' : ''}
        </pre>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1 border-t border-border pt-2">
        {!analysis ? (
          <button
            type="button"
            disabled={analyzing || loadingEvidence}
            onClick={() => {
              void analyzeSelected();
            }}
            className="rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent disabled:opacity-40"
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
            className="rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent"
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

      {analysis && !analysis.canSuggestFix ? (
        <p className="mt-2 text-[10px] text-muted">
          Suggest Fix needs a verified changed file with enough trusted context. Use Day 8 Suggest
          Fix from the relevant source when available.
        </p>
      ) : null}
    </div>
  );
}
