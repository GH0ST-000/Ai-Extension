import type { NormalizedApiContract, NormalizedApiOperation } from '@project-x/types';

export function findOperation(
  contract: NormalizedApiContract,
  query: { method?: string; path?: string; operationId?: string; id?: string },
): NormalizedApiOperation | null {
  if (query.id) {
    return contract.operations.find((o) => o.id === query.id) ?? null;
  }
  if (query.operationId) {
    const byOpId = contract.operations.filter((o) => o.operationId === query.operationId);
    if (byOpId.length === 1) return byOpId[0] ?? null;
    if (byOpId.length > 1) return null;
  }
  if (query.method && query.path) {
    const method = query.method.toUpperCase();
    return contract.operations.find((o) => o.method === method && o.path === query.path) ?? null;
  }
  return null;
}

export function buildOperationAiContext(
  contract: NormalizedApiContract,
  operation: NormalizedApiOperation,
  maxChars = 18_000,
): string {
  const lines = [
    `API: ${contract.title ?? 'Untitled'} (OpenAPI ${contract.version})`,
    `documentHash: ${contract.documentHash}`,
    contract.source.documentUrl ? `documentUrl: ${contract.source.documentUrl}` : null,
    contract.partial ? 'NOTE: contract parse was partial/truncated.' : null,
    '',
    `Operation: ${operation.method} ${operation.path}`,
    operation.operationId ? `operationId: ${operation.operationId}` : null,
    operation.summary ? `summary: ${operation.summary}` : null,
    operation.deprecated ? 'deprecated: true' : null,
    operation.description ? `description:\n${operation.description}` : null,
    '',
    'Parameters:',
    ...operation.parameters.map(
      (p) =>
        `- ${p.in} ${p.name}${p.required ? ' required' : ' optional'}${
          p.schema?.type ? ` (${p.schema.type}${p.schema.format ? `/${p.schema.format}` : ''})` : ''
        }${p.description ? ` — ${p.description}` : ''}`,
    ),
    '',
    'Request body:',
    operation.requestBody
      ? JSON.stringify(
          {
            required: operation.requestBody.required,
            contentType: operation.requestBody.contentType,
            schema: operation.requestBody.schema,
          },
          null,
          2,
        )
      : '(none)',
    '',
    'Responses:',
    ...operation.responses.map(
      (r) =>
        `- ${r.statusCode}${r.description ? `: ${r.description}` : ''}${
          r.schema ? `\n${JSON.stringify(r.schema, null, 2)}` : ''
        }`,
    ),
    '',
    'Security:',
    operation.security?.length
      ? operation.security.map((s) => `- ${s.name}`).join('\n')
      : '(none defined on operation)',
  ].filter((line): line is string => line != null);

  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text;
}
