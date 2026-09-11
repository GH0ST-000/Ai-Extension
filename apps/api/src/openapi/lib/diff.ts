import type {
  ApiContractChange,
  ApiContractDiff,
  NormalizedApiContract,
  NormalizedApiOperation,
  NormalizedApiSchema,
} from '@project-x/types';

function opKey(op: NormalizedApiOperation): string {
  return `${op.method} ${op.path}`;
}

function schemaFieldType(schema: NormalizedApiSchema | undefined): string {
  if (!schema) return 'unknown';
  if (schema.type) return schema.format ? `${schema.type}:${schema.format}` : schema.type;
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  return 'unknown';
}

function collectRequiredRequestFields(op: NormalizedApiOperation): Set<string> {
  const fields = new Set<string>();
  for (const p of op.parameters) {
    if (p.required) fields.add(`${p.in}:${p.name}`);
  }
  const required = op.requestBody?.schema?.required ?? [];
  for (const name of required) {
    fields.add(`body:${name}`);
  }
  return fields;
}

function collectResponseProps(op: NormalizedApiOperation, status: string): Map<string, string> {
  const map = new Map<string, string>();
  const response = op.responses.find((r) => r.statusCode === status);
  const props = response?.schema?.properties ?? {};
  for (const [name, schema] of Object.entries(props)) {
    map.set(name, schemaFieldType(schema));
  }
  return map;
}

function collectEnums(op: NormalizedApiOperation): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const visit = (prefix: string, schema: NormalizedApiSchema | undefined) => {
    if (!schema) return;
    if (schema.enum) {
      map.set(prefix, new Set(schema.enum.map((v) => String(v))));
    }
    for (const [k, v] of Object.entries(schema.properties ?? {})) {
      visit(`${prefix}.${k}`, v);
    }
    if (schema.items) visit(`${prefix}[]`, schema.items);
  };
  if (op.requestBody?.schema) visit('body', op.requestBody.schema);
  for (const p of op.parameters) {
    visit(`${p.in}.${p.name}`, p.schema);
  }
  return map;
}

/**
 * Deterministic structural OpenAPI comparison. AI must not override these facts.
 */
export function diffApiContracts(
  base: NormalizedApiContract,
  head: NormalizedApiContract,
  refs: { baseRef: string; headRef: string },
): ApiContractDiff {
  const breaking: ApiContractChange[] = [];
  const nonBreaking: ApiContractChange[] = [];
  const uncertain: ApiContractChange[] = [];
  let seq = 0;
  const push = (
    impact: ApiContractChange['impact'],
    change: Omit<ApiContractChange, 'id' | 'impact'>,
  ) => {
    seq += 1;
    const item: ApiContractChange = { ...change, id: `c${seq}`, impact };
    if (impact === 'breaking') breaking.push(item);
    else if (impact === 'non-breaking') nonBreaking.push(item);
    else uncertain.push(item);
  };

  const baseOps = new Map(base.operations.map((o) => [opKey(o), o]));
  const headOps = new Map(head.operations.map((o) => [opKey(o), o]));

  for (const [key, op] of baseOps) {
    if (!headOps.has(key)) {
      push('breaking', {
        kind: 'removed-endpoint',
        title: `Removed ${key}`,
        description: `Endpoint ${key} exists in base but not in head.`,
        method: op.method,
        path: op.path,
      });
    }
  }

  for (const [key, op] of headOps) {
    if (!baseOps.has(key)) {
      push('non-breaking', {
        kind: 'added-endpoint',
        title: `Added ${key}`,
        description: `Endpoint ${key} was added.`,
        method: op.method,
        path: op.path,
      });
      continue;
    }
    const baseOp = baseOps.get(key)!;

    const baseRequired = collectRequiredRequestFields(baseOp);
    const headRequired = collectRequiredRequestFields(op);
    for (const field of headRequired) {
      if (!baseRequired.has(field)) {
        push('breaking', {
          kind: 'new-required-request-field',
          title: `New required field ${field} on ${key}`,
          description: `Head requires ${field}, which was not required in base.`,
          method: op.method,
          path: op.path,
        });
      }
    }

    const baseStatuses = new Set(baseOp.responses.map((r) => r.statusCode));
    const headStatuses = new Set(op.responses.map((r) => r.statusCode));
    for (const status of baseStatuses) {
      if (!headStatuses.has(status)) {
        push('breaking', {
          kind: 'removed-response',
          title: `Removed response ${status} on ${key}`,
          description: `Response ${status} was removed from the contract.`,
          method: op.method,
          path: op.path,
        });
      }
    }
    for (const status of headStatuses) {
      if (!baseStatuses.has(status)) {
        push('non-breaking', {
          kind: 'added-response',
          title: `Added response ${status} on ${key}`,
          description: `Response ${status} was added.`,
          method: op.method,
          path: op.path,
        });
      }
    }

    for (const status of baseStatuses) {
      if (!headStatuses.has(status)) continue;
      const baseProps = collectResponseProps(baseOp, status);
      const headProps = collectResponseProps(op, status);
      for (const [name, baseType] of baseProps) {
        if (!headProps.has(name)) {
          push('breaking', {
            kind: 'removed-response-field',
            title: `Removed response field ${name} (${status}) on ${key}`,
            description: `Field ${name} was removed from response ${status}.`,
            method: op.method,
            path: op.path,
          });
        } else if (headProps.get(name) !== baseType) {
          push('breaking', {
            kind: 'type-change',
            title: `Type change for ${name} (${status}) on ${key}`,
            description: `${name} changed from ${baseType} to ${headProps.get(name)}.`,
            method: op.method,
            path: op.path,
          });
        }
      }
      for (const name of headProps.keys()) {
        if (!baseProps.has(name)) {
          push('non-breaking', {
            kind: 'other',
            title: `Added optional response field ${name} (${status}) on ${key}`,
            description: `Field ${name} was added to response ${status}. Treated as non-breaking when optional.`,
            method: op.method,
            path: op.path,
          });
        }
      }
    }

    const baseEnums = collectEnums(baseOp);
    const headEnums = collectEnums(op);
    for (const [field, baseSet] of baseEnums) {
      const headSet = headEnums.get(field);
      if (!headSet) continue;
      const removed = [...baseSet].filter((v) => !headSet.has(v));
      const added = [...headSet].filter((v) => !baseSet.has(v));
      if (removed.length) {
        push('breaking', {
          kind: 'enum-narrowing',
          title: `Enum narrowed for ${field} on ${key}`,
          description: `Removed values: ${removed.join(', ')}`,
          method: op.method,
          path: op.path,
        });
      }
      if (added.length) {
        push('uncertain', {
          kind: 'enum-widening',
          title: `Enum widened for ${field} on ${key}`,
          description: `Added values: ${added.join(', ')}. May break generated clients that exhaustively match enums.`,
          method: op.method,
          path: op.path,
        });
      }
    }

    const baseSec = (baseOp.security ?? [])
      .map((s) => s.name)
      .sort()
      .join(',');
    const headSec = (op.security ?? [])
      .map((s) => s.name)
      .sort()
      .join(',');
    if (baseSec !== headSec) {
      const stricter =
        headSec && (!baseSec || headSec.split(',').length >= baseSec.split(',').length);
      push(stricter ? 'breaking' : 'uncertain', {
        kind: 'security-change',
        title: `Security changed on ${key}`,
        description: `Base: ${baseSec || '(none)'}; Head: ${headSec || '(none)'}`,
        method: op.method,
        path: op.path,
      });
    }
  }

  return {
    baseRef: refs.baseRef,
    headRef: refs.headRef,
    baseHash: base.documentHash,
    headHash: head.documentHash,
    breakingChanges: breaking,
    nonBreakingChanges: nonBreaking,
    uncertainChanges: uncertain,
  };
}
