import type {
  DownstreamImpactFinding,
  PrReviewDownstreamImpact,
  PrReviewImpactWarning,
} from '@project-x/types';

/** Heading the extension recognizes; placed BEFORE "## Summary" so older clients ignore it. */
export const DOWNSTREAM_IMPACT_HEADING = '## Downstream Impact';

const WARNING_TEXT: Record<PrReviewImpactWarning, string> = {
  stale_graph: 'Dependency data is more than 14 days old — refresh the System for current results.',
  consumers_withheld:
    'Some potentially affected repositories are hidden because your access to them could not be verified.',
  access_check_unavailable:
    'GitHub access to some consumer repositories could not be checked right now.',
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

const CONFIDENCE: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' };

function describeChange(f: DownstreamImpactFinding): string {
  if (f.kind === 'removed-endpoint') return 'Operation removed';
  if (f.kind === 'removed-response-field' && f.fieldPath)
    return `Response field removed: \`${f.fieldPath}\``;
  if (f.kind === 'type-change' && f.fieldPath)
    return `Response field type changed: \`${f.fieldPath}\``;
  return f.title;
}

const day = (iso?: string) => (iso ? iso.slice(0, 10) : 'unknown');

/**
 * Plain Markdown for the live PR Review response. Only for the reviewer it was computed for
 * (consumers already re-authorized). Never persisted as the shared report Markdown.
 * Returns null when no API contract changed (no section at all).
 */
export function renderDownstreamImpactSection(impact: PrReviewDownstreamImpact): string | null {
  if (impact.status === 'not_analyzed') return null;
  const provider = `${impact.provider.owner}/${impact.provider.repository}`;
  const lines: string[] = [DOWNSTREAM_IMPACT_HEADING];
  const breaking = impact.contracts.reduce((n, c) => n + c.breaking, 0);

  switch (impact.status) {
    case 'compatible':
      lines.push(`API contract changed in ${provider} — no breaking changes detected.`);
      break;
    case 'unavailable':
      lines.push(
        `API contract changes in ${provider} could not be verified, so downstream impact is unknown.`,
      );
      break;
    case 'no_system':
      lines.push(
        `Breaking API change detected in ${provider}, but this repository is not in any of your Systems, so downstream consumers are unknown.`,
      );
      break;
    case 'no_known_consumers':
      lines.push(
        `Breaking API change detected in ${provider}. No consumers are known in your Systems — this does not mean nothing depends on it.`,
      );
      break;
    default:
      lines.push(
        breaking > 0
          ? `Breaking API change detected in ${provider}.`
          : `API contract changes in ${provider} were only partly verified.`,
      );
  }

  for (const f of impact.findings) {
    lines.push('', `- **${f.method} ${f.path}** — ${describeChange(f)}`);
    for (const c of f.consumers) {
      const files = [...new Set(c.evidence.map((e) => e.filePath).filter(Boolean))].slice(0, 3);
      lines.push(
        `  - Potentially affected: ${c.repository.owner}/${c.repository.repository} — confidence ${CONFIDENCE[c.confidence] ?? c.confidence}${
          files.length ? ` — evidence: ${files.join(', ')}` : ''
        } — last validated ${day(c.lastValidatedAt)}${c.stale ? ' (stale)' : ''}`,
      );
    }
  }
  if (impact.findings.some((f) => f.consumers.length > 0)) {
    lines.push(
      '',
      '_Potential downstream impact, not a confirmed runtime failure: consumer usage of the changed fields was not verified._',
    );
  }
  for (const w of impact.warnings) lines.push(`> ${WARNING_TEXT[w]}`);
  if (impact.withheldConsumers > 0) {
    lines.push(
      `> ${impact.withheldConsumers} potentially affected ${impact.withheldConsumers === 1 ? 'repository is' : 'repositories are'} not shown.`,
    );
  }
  return lines.join('\n');
}
