import type {
  ApiContractChange,
  ApiContractDiff,
  NormalizedApiContract,
  NormalizedApiOperation,
  NormalizedApiSchema,
} from '@project-x/types';
import { normalizeHttpPath } from '@project-x/shared';

/**
 * Canonical operation identity: method + normalized path, so `/users/{id}` and
 * `/users/{userId}` (a parameter rename) are the same operation, while `/users` and
 * `/users/settings` stay distinct.
 */
function opKey(op: NormalizedApiOperation): string {
  return `${op.method} ${normalizeHttpPath(op.path) ?? op.path}`;
}

/** Label for messages: method + the path as written. */
function opLabel(op: NormalizedApiOperation): string {
  return `${op.method} ${op.path}`;
}

function schemaFieldType(schema: NormalizedApiSchema | undefined): string {
  if (!schema) return 'unknown';
  if (schema.truncated || schema.unresolvedRef) return 'unknown';
  if (schema.type) return schema.format ? `${schema.type}:${schema.format}` : schema.type;
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  return 'unknown';
}

/** Position of `{name}` among the path's segments (path parameters are positional). */
function pathParamPosition(path: string, name: string): number {
  return path.split('/').findIndex((segment) => segment === `{${name}}` || segment === `:${name}`);
}

function collectRequiredRequestFields(op: NormalizedApiOperation): Set<string> {
  const fields = new Set<string>();
  for (const p of op.parameters) {
    if (!p.required) continue;
    if (p.in === 'path') {
      // Renaming a path parameter does not change what a client sends.
      const position = pathParamPosition(op.path, p.name);
      fields.add(position >= 0 ? `path:#${position}` : `path:${p.name}`);
    } else {
      fields.add(`${p.in}:${p.name}`);
    }
  }
  const required = op.requestBody?.schema?.required ?? [];
  for (const name of required) {
    fields.add(`body:${name}`);
  }
  return fields;
}

// ── nested response fields ───────────────────────────────────────────────────

interface FieldInfo {
  type: string;
  required: boolean;
  nullable: boolean;
  enumValues?: Set<string>;
}

/** Normalized schemas are trees (refs inlined, cycles cut), but traversal stays bounded. */
const MAX_FIELD_DEPTH = 12;
const MAX_FIELDS = 2_000;

/** Properties + required of a schema, including `allOf` members (composition). */
function objectShape(schema: NormalizedApiSchema): {
  properties: Record<string, NormalizedApiSchema>;
  required: Set<string>;
} {
  const properties: Record<string, NormalizedApiSchema> = { ...(schema.properties ?? {}) };
  const required = new Set(schema.required ?? []);
  for (const member of schema.allOf ?? []) {
    Object.assign(properties, member.properties ?? {});
    for (const name of member.required ?? []) required.add(name);
  }
  return { properties, required };
}

/**
 * Every field of a response schema by stable path: `users[].name`, `user.address.city`,
 * `[].id` (top-level array). oneOf/anyOf branches are not expanded (no single shape).
 */
function flattenFields(schema: NormalizedApiSchema | undefined): Map<string, FieldInfo> {
  const out = new Map<string, FieldInfo>();
  const visit = (node: NormalizedApiSchema | undefined, prefix: string, depth: number) => {
    if (!node || depth > MAX_FIELD_DEPTH || out.size >= MAX_FIELDS) return;
    if (node.truncated || node.unresolvedRef) return;
    if (node.items) {
      visit(node.items, `${prefix}[]`, depth + 1);
      return;
    }
    const { properties, required } = objectShape(node);
    for (const [name, child] of Object.entries(properties)) {
      if (out.size >= MAX_FIELDS) return;
      const path = prefix ? `${prefix}.${name}` : name;
      out.set(path, {
        type: schemaFieldType(child),
        required: required.has(name),
        nullable: child?.nullable === true,
        ...(child?.enum ? { enumValues: new Set(child.enum.map((v) => String(v))) } : {}),
      });
      visit(child, path, depth + 1);
    }
  };
  visit(schema, '', 0);
  return out;
}

/** `users[].name` is inside `users` and `users[]`. */
function isWithin(path: string, ancestor: string): boolean {
  return path.startsWith(`${ancestor}.`) || path.startsWith(`${ancestor}[]`);
}

function collectEnums(op: NormalizedApiOperation): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const visit = (prefix: string, schema: NormalizedApiSchema | undefined, depth = 0) => {
    if (!schema || depth > MAX_FIELD_DEPTH) return;
    if (schema.enum) {
      map.set(prefix, new Set(schema.enum.map((v) => String(v))));
    }
    for (const [k, v] of Object.entries(schema.properties ?? {})) {
      visit(`${prefix}.${k}`, v, depth + 1);
    }
    if (schema.items) visit(`${prefix}[]`, schema.items, depth + 1);
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

  // First operation wins when a document repeats an equivalent path.
  const index = (ops: NormalizedApiOperation[]) => {
    const map = new Map<string, NormalizedApiOperation>();
    for (const op of ops) if (!map.has(opKey(op))) map.set(opKey(op), op);
    return map;
  };
  const baseOps = index(base.operations);
  const headOps = index(head.operations);

  for (const [key, op] of baseOps) {
    if (!headOps.has(key)) {
      const label = opLabel(op);
      push('breaking', {
        kind: 'removed-endpoint',
        title: `Removed ${label}`,
        description: `Endpoint ${label} exists in base but not in head.`,
        method: op.method,
        path: op.path,
      });
    }
  }

  for (const [key, op] of headOps) {
    const label = opLabel(op);
    if (!baseOps.has(key)) {
      push('non-breaking', {
        kind: 'added-endpoint',
        title: `Added ${label}`,
        description: `Endpoint ${label} was added.`,
        method: op.method,
        path: op.path,
      });
      continue;
    }
    const baseOp = baseOps.get(key)!;
    const at = { method: op.method, path: op.path };

    const baseRequired = collectRequiredRequestFields(baseOp);
    const headRequired = collectRequiredRequestFields(op);
    for (const field of headRequired) {
      if (!baseRequired.has(field)) {
        push('breaking', {
          kind: 'new-required-request-field',
          title: `New required field ${field} on ${label}`,
          description: `Head requires ${field}, which was not required in base.`,
          ...at,
        });
      }
    }

    const baseStatuses = new Set(baseOp.responses.map((r) => r.statusCode));
    const headStatuses = new Set(op.responses.map((r) => r.statusCode));
    for (const status of baseStatuses) {
      if (!headStatuses.has(status)) {
        push('breaking', {
          kind: 'removed-response',
          title: `Removed response ${status} on ${label}`,
          description: `Response ${status} was removed from the contract.`,
          statusCode: status,
          ...at,
        });
      }
    }
    for (const status of headStatuses) {
      if (!baseStatuses.has(status)) {
        push('non-breaking', {
          kind: 'added-response',
          title: `Added response ${status} on ${label}`,
          description: `Response ${status} was added.`,
          statusCode: status,
          ...at,
        });
      }
    }

    for (const status of baseStatuses) {
      if (!headStatuses.has(status)) continue;
      const baseFields = flattenFields(
        baseOp.responses.find((r) => r.statusCode === status)?.schema,
      );
      const headFields = flattenFields(op.responses.find((r) => r.statusCode === status)?.schema);
      const reported: string[] = [];
      const covered = (path: string) => reported.some((r) => isWithin(path, r));

      for (const [path, before] of baseFields) {
        if (covered(path)) continue;
        const after = headFields.get(path);
        const field = { ...at, statusCode: status, fieldPath: path };
        if (!after) {
          reported.push(path);
          push('breaking', {
            kind: 'removed-response-field',
            title: `Removed response field ${path} (${status}) on ${label}`,
            description: `Field ${path} was removed from response ${status}.`,
            ...field,
          });
          continue;
        }
        if (before.type !== after.type && before.type !== 'unknown' && after.type !== 'unknown') {
          reported.push(path);
          push('breaking', {
            kind: 'type-change',
            title: `Type change for ${path} (${status}) on ${label}`,
            description: `${path} changed from ${before.type} to ${after.type}.`,
            ...field,
          });
          continue;
        }
        if (before.required && !after.required) {
          push('uncertain', {
            kind: 'other',
            title: `Response field ${path} (${status}) on ${label} is no longer required`,
            description: `${path} may now be absent; clients that rely on it may fail.`,
            ...field,
          });
        }
        if (!before.nullable && after.nullable) {
          push('uncertain', {
            kind: 'other',
            title: `Response field ${path} (${status}) on ${label} became nullable`,
            description: `${path} may now be null; strict clients may fail.`,
            ...field,
          });
        }
        if (before.enumValues && after.enumValues) {
          const added = [...after.enumValues].filter((v) => !before.enumValues!.has(v));
          const removed = [...before.enumValues].filter((v) => !after.enumValues!.has(v));
          if (added.length) {
            push('uncertain', {
              kind: 'enum-widening',
              title: `Response enum widened for ${path} (${status}) on ${label}`,
              description: `New values: ${added.join(', ')}. Clients matching values exhaustively may fail.`,
              ...field,
            });
          }
          if (removed.length) {
            // A server returning fewer values cannot surprise a client.
            push('non-breaking', {
              kind: 'enum-narrowing',
              title: `Response enum narrowed for ${path} (${status}) on ${label}`,
              description: `No longer returned: ${removed.join(', ')}.`,
              ...field,
            });
          }
        }
      }

      const added: string[] = [];
      for (const path of headFields.keys()) {
        if (baseFields.has(path) || added.some((a) => isWithin(path, a)) || covered(path)) continue;
        added.push(path);
        push('non-breaking', {
          kind: 'added-response-field',
          title: `Added response field ${path} (${status}) on ${label}`,
          description: `Field ${path} was added to response ${status}. Additive changes are non-breaking.`,
          ...at,
          statusCode: status,
          fieldPath: path,
        });
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
          title: `Enum narrowed for ${field} on ${label}`,
          description: `Removed values: ${removed.join(', ')}`,
          ...at,
        });
      }
      if (added.length) {
        push('uncertain', {
          kind: 'enum-widening',
          title: `Enum widened for ${field} on ${label}`,
          description: `Added values: ${added.join(', ')}. May break generated clients that exhaustively match enums.`,
          ...at,
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
        title: `Security changed on ${label}`,
        description: `Base: ${baseSec || '(none)'}; Head: ${headSec || '(none)'}`,
        ...at,
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
