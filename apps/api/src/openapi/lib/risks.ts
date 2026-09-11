import type {
  ApiContractFinding,
  NormalizedApiContract,
  NormalizedApiOperation,
} from '@project-x/types';

/**
 * Deterministic contract-risk heuristics (facts from OpenAPI only).
 * AI may elaborate; these findings are grounded.
 */
export function analyzeApiContractDeterministic(
  contract: NormalizedApiContract,
  scope: 'operation' | 'tag' | 'contract',
  operation?: NormalizedApiOperation | null,
  tag?: string,
): {
  findings: ApiContractFinding[];
  openQuestions: string[];
  riskLevel: 'high' | 'medium' | 'low';
} {
  const ops =
    scope === 'operation' && operation
      ? [operation]
      : scope === 'tag' && tag
        ? contract.operations.filter((o) => o.tags?.includes(tag))
        : contract.operations;

  const findings: ApiContractFinding[] = [];
  const openQuestions: string[] = [];
  let n = 0;
  const add = (finding: Omit<ApiContractFinding, 'id'>) => {
    n += 1;
    findings.push({ ...finding, id: `f${n}` });
  };

  for (const op of ops.slice(0, 80)) {
    if (!op.security?.length && !contract.operations.every((o) => !o.security?.length)) {
      // only flag if some ops have security and this one doesn't? Better: flag missing global+op
    }
    if (!op.security?.length) {
      add({
        severity: 'medium',
        category: 'security',
        title: `No security defined for ${op.method} ${op.path}`,
        description:
          'The OpenAPI contract does not declare a security requirement for this operation.',
        evidence: [
          {
            kind: 'security',
            method: op.method,
            path: op.path,
            operationId: op.operationId,
          },
        ],
        recommendation:
          'Document the expected authentication scheme, or explicitly mark as public.',
      });
    }

    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(op.method);
    if (mutating) {
      const hasIdempotency = op.parameters.some((p) => /idempotenc/i.test(p.name));
      if (!hasIdempotency) {
        add({
          severity: 'medium',
          category: 'idempotency',
          title: `Idempotency undefined for ${op.method} ${op.path}`,
          description:
            'The contract does not define an idempotency key or duplicate-request behavior for this mutating operation.',
          evidence: [{ kind: 'operation', method: op.method, path: op.path }],
          recommendation: 'Document idempotency expectations for safe client retries.',
        });
        openQuestions.push(
          `Can ${op.method} ${op.path} be safely retried without duplicate side effects?`,
        );
      }
    }

    if (!op.responses.length) {
      add({
        severity: 'high',
        category: 'responses',
        title: `No responses defined for ${op.method} ${op.path}`,
        description: 'OpenAPI operation declares no response objects.',
        evidence: [{ kind: 'operation', method: op.method, path: op.path }],
      });
    } else {
      const has2xx = op.responses.some(
        (r) => /^2\d\d$/.test(r.statusCode) || r.statusCode === 'default',
      );
      if (!has2xx) {
        add({
          severity: 'medium',
          category: 'responses',
          title: `No success response for ${op.method} ${op.path}`,
          description: 'No 2xx (or default) response is defined.',
          evidence: [{ kind: 'response', method: op.method, path: op.path }],
        });
      }

      const schemas = op.responses
        .map((r) => r.schema?.name ?? r.schema?.type ?? 'anonymous')
        .filter(Boolean);
      if (new Set(schemas).size > 1 && op.responses.length > 2) {
        add({
          severity: 'low',
          category: 'consistency',
          title: `Mixed response schemas on ${op.method} ${op.path}`,
          description: 'Different response status codes appear to use inconsistent schema shapes.',
          evidence: op.responses.map((r) => ({
            kind: 'response' as const,
            method: op.method,
            path: op.path,
            statusCode: r.statusCode,
            note: r.schema?.name ?? r.schema?.type,
          })),
        });
      }
    }

    for (const p of op.parameters) {
      if (
        p.schema?.type === 'string' &&
        !p.schema.maxLength &&
        !p.schema.enum &&
        !p.schema.format
      ) {
        add({
          severity: 'low',
          category: 'validation',
          title: `Unbounded string parameter ${p.name}`,
          description: `Parameter ${p.in}.${p.name} has no format, enum, or maxLength constraint.`,
          evidence: [
            {
              kind: 'parameter',
              method: op.method,
              path: op.path,
              name: p.name,
            },
          ],
        });
      }
    }

    if (op.deprecated) {
      add({
        severity: 'medium',
        category: 'deprecation',
        title: `Deprecated operation ${op.method} ${op.path}`,
        description: 'Operation is marked deprecated in the contract.',
        evidence: [{ kind: 'operation', method: op.method, path: op.path }],
      });
    }
  }

  // Deduplicate similar low-noise findings: keep first 25
  const limited = findings.slice(0, 25);
  const high = limited.some((f) => f.severity === 'high');
  const medium = limited.some((f) => f.severity === 'medium');
  return {
    findings: limited,
    openQuestions: [...new Set(openQuestions)].slice(0, 12),
    riskLevel: high ? 'high' : medium ? 'medium' : 'low',
  };
}
