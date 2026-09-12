import type {
  ContextDriftField,
  ContextDriftSummary,
  ExecutionContextVersion,
} from '@project-x/types';

export function detectContextDrift(
  original: ExecutionContextVersion,
  current: ExecutionContextVersion,
): ContextDriftSummary {
  const fields: ContextDriftField[] = [];

  compare('prSha', 'PR SHA', original.prSha, current.prSha, fields);
  compare('openapiHash', 'OpenAPI hash', original.openapiHash, current.openapiHash, fields);
  compare('memoryVersion', 'Memory version', original.memoryVersion, current.memoryVersion, fields);
  compare(
    'systemContextVersion',
    'System context version',
    original.systemContextVersion,
    current.systemContextVersion,
    fields,
  );
  compare('jiraUpdatedAt', 'Jira updated', original.jiraUpdatedAt, current.jiraUpdatedAt, fields);
  compare(
    'plannerVersion',
    'Planner version',
    original.plannerVersion,
    current.plannerVersion,
    fields,
  );
  compare('promptVersion', 'Prompt version', original.promptVersion, current.promptVersion, fields);
  compare('aiModel', 'AI model', original.aiModel, current.aiModel, fields);
  compare('repository', 'Repository', original.repository, current.repository, fields);
  compare('jiraIssueKey', 'Jira issue', original.jiraIssueKey, current.jiraIssueKey, fields);

  return {
    hasDrift: fields.length > 0,
    fields,
    summary:
      fields.length === 0
        ? 'No context drift detected.'
        : `${fields.length} context field(s) changed since the original execution.`,
  };
}

function compare(
  key: ContextDriftField['key'],
  label: string,
  previous: string | undefined,
  next: string | undefined,
  fields: ContextDriftField[],
): void {
  const a = previous ?? '';
  const b = next ?? '';
  if (a === b) return;
  if (!a && !b) return;
  fields.push({
    key,
    label,
    previous: a || undefined,
    current: b || undefined,
  });
}
