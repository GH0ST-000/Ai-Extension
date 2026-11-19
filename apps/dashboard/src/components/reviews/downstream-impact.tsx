'use client';

import type {
  DownstreamImpactFinding,
  PrReviewDownstreamImpact,
  PrReviewImpactWarning,
  RelationshipProvenanceType,
} from '@project-x/types';

/**
 * Deterministic cross-repository contract impact of a saved PR Review. The API has already
 * removed consumers the viewer cannot access; this only presents what is left.
 */

const HEADLINE: Record<PrReviewDownstreamImpact['status'], string> = {
  verified: 'Breaking API change detected',
  partial: 'Breaking API change — partly verified',
  no_known_consumers: 'Breaking API change — no known consumers',
  no_system: 'Breaking API change — consumers unknown',
  compatible: 'API contract changed — no breaking changes',
  unavailable: 'API contract impact could not be verified',
  not_analyzed: 'No API contract changes',
};

const EXPLANATION: Partial<Record<PrReviewDownstreamImpact['status'], string>> = {
  no_known_consumers:
    'No consumers of the changed operations are known in your Systems. This does not mean nothing depends on them.',
  no_system:
    'This repository is not in any of your Systems, so downstream consumers are unknown. Add it to a System to analyze its consumers.',
  unavailable:
    'The changed API contract could not be read or parsed, so downstream impact is unknown — not absent.',
  compatible: 'The contract changed, but every detected change is backward compatible.',
};

const WARNING_TEXT: Record<PrReviewImpactWarning, string> = {
  stale_graph: 'Dependency data is more than 14 days old. Refresh the System for current results.',
  consumers_withheld:
    'Some potentially affected repositories are hidden because your access to them could not be verified.',
  access_check_unavailable: 'GitHub access to some consumer repositories could not be checked.',
  no_personal_token: 'Connect your personal GitHub token in Settings to see consumer repositories.',
  contract_unavailable: 'A changed API contract could not be read from GitHub.',
  contract_unparseable: 'A changed API contract could not be parsed as OpenAPI.',
  contract_deleted:
    'An API contract file was deleted; its endpoints may have moved, so this is not treated as removal.',
  contract_too_large: 'A changed API contract is too large to compare.',
  too_many_contracts: 'Only the first 3 changed API contracts were compared.',
  rate_limited: 'GitHub rate limit reached while reading API contracts.',
  timeout: 'Contract impact analysis ran out of time.',
  unverified_shas: 'The PR commits could not be verified through the GitHub API.',
};

const EVIDENCE_LABEL: Partial<Record<RelationshipProvenanceType, string>> = {
  http_call: 'Code',
  openapi_reference: 'OpenAPI',
  service_manifest: 'Declared',
};

const CONFIDENCE: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' };

function changeLabel(f: DownstreamImpactFinding): string {
  if (f.kind === 'removed-endpoint') return 'Operation removed';
  if (f.kind === 'removed-response-field' && f.fieldPath)
    return `Removed response field ${f.fieldPath}`;
  if (f.kind === 'type-change' && f.fieldPath) return `Response field type changed: ${f.fieldPath}`;
  return f.title;
}

const date = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : 'unknown');

export function DownstreamImpact({ impact }: { impact: PrReviewDownstreamImpact }) {
  if (impact.status === 'not_analyzed') return null;
  const breaking = ['verified', 'partial', 'no_known_consumers', 'no_system'].includes(
    impact.status,
  );
  const anyConsumer = impact.findings.some((f) => f.consumers.length > 0);
  return (
    <section aria-labelledby="downstream-impact-heading" className="space-y-3">
      <h2 id="downstream-impact-heading" className="text-sm font-semibold text-ink">
        Downstream Impact
      </h2>
      <div
        role="status"
        className={[
          'rounded-xl border px-3 py-2 text-sm',
          breaking
            ? 'border-[#b54708]/35 bg-[#fffaeb] text-ink dark:border-[#f79009]/40 dark:bg-[#f79009]/10'
            : 'border-line bg-mist/60 text-ink',
        ].join(' ')}
      >
        <p className="font-semibold">{HEADLINE[impact.status]}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {impact.provider.owner}/{impact.provider.repository}
          {impact.baseSha && impact.headSha
            ? ` · ${impact.baseSha.slice(0, 7)} → ${impact.headSha.slice(0, 7)}`
            : ''}
          {` · analyzed ${date(impact.analyzedAt)}`}
        </p>
        {EXPLANATION[impact.status] ? (
          <p className="mt-1 text-xs text-muted-foreground">{EXPLANATION[impact.status]}</p>
        ) : null}
      </div>

      {impact.findings.length > 0 ? (
        <ul className="space-y-2">
          {impact.findings.map((finding) => (
            <li
              key={`${finding.changeId}-${finding.operation}-${finding.fieldPath ?? ''}`}
              className="rounded-xl border border-line bg-panel/80 p-3"
            >
              <p className="font-mono text-sm font-semibold text-ink">
                {finding.method} {finding.path}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">{changeLabel(finding)}</p>
              {finding.consumers.length > 0 ? (
                <ul
                  className="mt-2 space-y-2"
                  aria-label={`Potentially affected repositories for ${finding.method} ${finding.path}`}
                >
                  {finding.consumers.map((c) => {
                    const name = `${c.repository.owner}/${c.repository.repository}`;
                    return (
                      <li
                        key={name}
                        className="rounded-lg border border-line/80 bg-mist/40 px-3 py-2"
                      >
                        <p className="text-xs text-muted-foreground">
                          Potentially affected repository
                        </p>
                        <p className="break-all font-mono text-sm font-semibold text-ink">{name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Confidence: {CONFIDENCE[c.confidence] ?? c.confidence} · last validated{' '}
                          {date(c.lastValidatedAt)}
                          {c.stale ? ' · stale' : ''}
                          {c.systems.length > 0
                            ? ` · ${c.systems.map((s) => s.name ?? s.id).join(', ')}`
                            : ''}
                        </p>
                        {c.evidence.length > 0 ? (
                          <details className="mt-1 text-xs">
                            <summary className="cursor-pointer select-none font-semibold text-ink/80 hover:text-ink">
                              Evidence ({c.evidence.length})
                            </summary>
                            <ul className="mt-1 space-y-1 text-muted-foreground">
                              {c.evidence.map((e, i) => (
                                <li key={i}>
                                  <span className="font-semibold text-ink">
                                    {EVIDENCE_LABEL[e.type] ?? e.type}
                                  </span>
                                  {e.repository ? ` · ${e.repository}` : ''}
                                  {e.filePath ? (
                                    <span className="ml-1 break-all font-mono">{e.filePath}</span>
                                  ) : null}
                                  <span className="block">{e.summary}</span>
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {anyConsumer ? (
        <p className="text-xs text-muted-foreground">
          This indicates a potential downstream impact, not a confirmed runtime failure. Whether the
          consumer uses the changed fields was not verified.
        </p>
      ) : null}
      {impact.warnings.length > 0 || impact.withheldConsumers > 0 ? (
        <ul className="space-y-1 text-xs text-muted-foreground" aria-label="Analysis limitations">
          {impact.warnings.map((w) => (
            <li key={w}>• {WARNING_TEXT[w] ?? w}</li>
          ))}
          {impact.withheldConsumers > 0 ? (
            <li>
              • {impact.withheldConsumers} potentially affected{' '}
              {impact.withheldConsumers === 1 ? 'repository is' : 'repositories are'} not shown.
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}
