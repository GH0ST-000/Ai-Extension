import { getPlannerCapabilitySummaries } from './capabilities';

/**
 * Format the allowlisted capability catalog as plain text for the planner prompt.
 */
export function formatCapabilityCatalogForPlanner(): string {
  const summaries = getPlannerCapabilitySummaries();
  const lines: string[] = ['Allowed workflow capabilities (choose only from this list):', ''];

  for (const cap of summaries) {
    lines.push(`- ${cap.type}`);
    lines.push(`  title: ${cap.title}`);
    lines.push(`  purpose: ${cap.description}`);
    lines.push(`  mutationRisk: ${cap.mutationRisk}`);
    lines.push(`  executionMode: ${cap.executionMode}`);
    lines.push(`  costClass: ${cap.costClass ?? 'MEDIUM'}`);
    lines.push(
      `  consumes: ${cap.consumes && cap.consumes.length > 0 ? cap.consumes.join(', ') : '(none)'}`,
    );
    lines.push(
      `  produces: ${cap.produces && cap.produces.length > 0 ? cap.produces.join(', ') : '(none)'}`,
    );
    lines.push(
      `  requiredContext: ${
        cap.requiredContext.length > 0 ? cap.requiredContext.join(', ') : '(none)'
      }`,
    );
    lines.push('');
  }

  lines.push(
    'Do not invent capability names. Do not include merge, shell, Jira write, API execution, or CI control steps.',
  );
  lines.push(
    'Never choose APPROVE or REQUEST_CHANGES — use USER_SELECT_REVIEW_EVENT when a review event is needed.',
  );
  return lines.join('\n').trimEnd();
}
