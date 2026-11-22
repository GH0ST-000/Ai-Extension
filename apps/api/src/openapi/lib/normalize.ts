import type {
  HttpMethod,
  NormalizedApiContract,
  NormalizedApiOperation,
  NormalizedApiParameter,
  NormalizedApiResponse,
  NormalizedApiSchema,
  NormalizedRequestBody,
  NormalizedSecurityRequirement,
} from '@project-x/types';
import {
  HTTP_METHODS,
  OPENAPI_MAX_DESCRIPTION_CHARS,
  OPENAPI_MAX_OPERATIONS,
  OPENAPI_MAX_PROPERTIES,
  OPENAPI_MAX_SCHEMA_DEPTH,
  OPENAPI_MAX_SCHEMA_NODES,
  OPENAPI_MAX_SCHEMAS,
} from '@project-x/types';

import { hashOpenApiDocument, isOpenApiLikeDocument } from './parse-raw';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function truncateText(value: unknown, max = OPENAPI_MAX_DESCRIPTION_CHARS): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function normalizeMethod(raw: string): HttpMethod | null {
  const upper = raw.toUpperCase() as HttpMethod;
  return (HTTP_METHODS as readonly string[]).includes(upper) ? upper : null;
}

function operationIdFor(method: HttpMethod, path: string, operationId?: string): string {
  if (operationId?.trim()) {
    return operationId.trim();
  }
  return `${method}:${path}`;
}

function resolveLocalRef(
  root: Record<string, unknown>,
  ref: string,
  stack: string[],
  maxDepth: number,
): unknown {
  if (!ref.startsWith('#/')) {
    return { __externalRef: ref };
  }
  if (stack.includes(ref) || stack.length >= maxDepth) {
    return { __circular: ref };
  }
  // Callers refuse refs longer than MAX_REF_CHARS before this point (bounded split).
  const parts = ref
    .slice(2)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = root;
  for (const part of parts) {
    const rec = asRecord(current);
    if (!rec || !(part in rec)) {
      return { __unresolved: ref };
    }
    current = rec[part];
  }
  return current;
}

/**
 * F-01: one budget for the whole document. Depth and per-node property caps alone leave the
 * work exponential (`properties ^ depth`) because a `$ref` is re-expanded at every use; the
 * budget bounds the total number of schema nodes visited, so normalization is linear in the
 * budget no matter how references fan out. Past the budget every further node is a constant-
 * time `truncated` stub and the contract is reported as partial.
 */
type NormalizeContext = {
  warnings: string[];
  remainingNodes: number;
  budgetExhausted: boolean;
  /** JSON size of `default` / `example` values, measured once per distinct object. */
  valueSizes: WeakMap<object, number>;
};

const BUDGET_WARNING = 'Schema expansion budget reached; remaining schemas are truncated.';

/**
 * Per-node bounds. The node budget alone is not enough: a node is re-visited at every `$ref`
 * that reaches it, so anything proportional to the SIZE of a node (a 400k-item `enum`, a
 * megabyte-long `$ref` or `example`, a 100k-key `properties` or security object) would be
 * multiplied by the budget. Every such input is cut to a constant here BEFORE it is copied,
 * and what is retained is charged to the same budget, so both the work and the size of the
 * normalized contract are linear in OPENAPI_MAX_SCHEMA_NODES.
 */
const MAX_REF_CHARS = 512;
const MAX_ENUM_ITEMS = 200;
const MAX_ENUM_ITEM_CHARS = 200;
const MAX_REQUIRED_ITEMS = 100;
const MAX_KEY_CHARS = 200;
const MAX_VALUE_JSON_CHARS = 2_000;
const MAX_SECURITY_SCHEMES = 20;
const MAX_WARNINGS = 200;
/** Retained characters that cost one budget unit. */
const CHARS_PER_UNIT = 64;

function warn(ctx: NormalizeContext, message: string): void {
  if (ctx.warnings.length < MAX_WARNINGS) ctx.warnings.push(message);
}

/** Charge retained text to the budget; false when it no longer fits (the text is dropped). */
function chargeChars(ctx: NormalizeContext, chars: number): boolean {
  const units = Math.ceil(chars / CHARS_PER_UNIT);
  if (units === 0) return true;
  if (ctx.remainingNodes < units) {
    ctx.remainingNodes = 0;
    return false;
  }
  ctx.remainingNodes -= units;
  return true;
}

/** `description`, bounded and charged. */
function boundedText(ctx: NormalizeContext, value: unknown): string | undefined {
  const text = truncateText(value);
  return text !== undefined && chargeChars(ctx, text.length) ? text : undefined;
}

/**
 * `default` / `example`: kept only when small. The size of an object is measured once per
 * distinct object (not once per expansion) and anything above the cap is dropped.
 */
function boundedValue(ctx: NormalizeContext, value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length <= MAX_VALUE_JSON_CHARS && chargeChars(ctx, value.length)
      ? value
      : undefined;
  }
  if (typeof value !== 'object') return undefined;
  let size = ctx.valueSizes.get(value);
  if (size === undefined) {
    try {
      size = JSON.stringify(value)?.length ?? Number.POSITIVE_INFINITY;
    } catch {
      size = Number.POSITIVE_INFINITY;
    }
    ctx.valueSizes.set(value, size);
  }
  return size <= MAX_VALUE_JSON_CHARS && chargeChars(ctx, size) ? value : undefined;
}

/** At most `max` own keys of `record`, without materializing all of them. */
function firstKeys(
  record: Record<string, unknown>,
  max: number,
): { keys: string[]; more: boolean } {
  const keys: string[] = [];
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    if (keys.length >= max) return { keys, more: true };
    keys.push(key);
  }
  return { keys, more: false };
}

function shortRef(ref: string): string {
  return ref.length > 120 ? `${ref.slice(0, 120)}…` : ref;
}

function normalizeSchema(
  root: Record<string, unknown>,
  value: unknown,
  depth: number,
  stack: string[],
  ctx: NormalizeContext,
): NormalizedApiSchema {
  if (ctx.remainingNodes <= 0) {
    if (!ctx.budgetExhausted) {
      ctx.budgetExhausted = true;
      ctx.warnings.push(BUDGET_WARNING);
    }
    return { truncated: true, description: 'Schema expansion budget reached' };
  }
  ctx.remainingNodes -= 1;
  if (depth > OPENAPI_MAX_SCHEMA_DEPTH) {
    return { truncated: true, description: 'Schema depth limit reached' };
  }

  const rec = asRecord(value);
  if (!rec) {
    return { type: 'object', truncated: true };
  }

  if (typeof rec.$ref === 'string') {
    const ref = rec.$ref;
    if (ref.length > MAX_REF_CHARS) {
      warn(ctx, 'Reference too long; not resolved');
      return { unresolvedRef: shortRef(ref), truncated: true };
    }
    if (!ref.startsWith('#/')) {
      warn(ctx, `External $ref not resolved: ${shortRef(ref)}`);
      return { unresolvedRef: ref, truncated: true };
    }
    const resolved = resolveLocalRef(root, ref, stack, OPENAPI_MAX_SCHEMA_DEPTH);
    const resolvedRec = asRecord(resolved);
    if (resolvedRec?.__circular || resolvedRec?.__unresolved || resolvedRec?.__externalRef) {
      warn(ctx, `Reference limit/unresolved: ${shortRef(ref)}`);
      return { unresolvedRef: ref, truncated: true };
    }
    const name = ref.split('/').pop();
    const nested = normalizeSchema(root, resolved, depth + 1, [...stack, ref], ctx);
    return { ...nested, name: nested.name ?? name };
  }

  const schema: NormalizedApiSchema = {
    type: typeof rec.type === 'string' ? rec.type : undefined,
    format: typeof rec.format === 'string' ? rec.format : undefined,
    description: boundedText(ctx, rec.description),
    nullable: typeof rec.nullable === 'boolean' ? rec.nullable : undefined,
    enum: normalizeEnum(ctx, rec.enum),
    default: boundedValue(ctx, rec.default),
    example: boundedValue(ctx, rec.example),
    minimum: typeof rec.minimum === 'number' ? rec.minimum : undefined,
    maximum: typeof rec.maximum === 'number' ? rec.maximum : undefined,
    minLength: typeof rec.minLength === 'number' ? rec.minLength : undefined,
    maxLength: typeof rec.maxLength === 'number' ? rec.maxLength : undefined,
  };

  if (Array.isArray(rec.required)) {
    // Slice BEFORE filtering: the input array may be huge and this node is visited many times.
    const required = rec.required
      .slice(0, MAX_REQUIRED_ITEMS)
      .filter((v): v is string => typeof v === 'string' && v.length <= MAX_KEY_CHARS);
    if (
      chargeChars(
        ctx,
        required.reduce((n, v) => n + v.length, 0),
      )
    ) {
      schema.required = required;
    }
  }

  const props = asRecord(rec.properties);
  if (props) {
    const { keys, more } = firstKeys(props, OPENAPI_MAX_PROPERTIES);
    schema.properties = {};
    for (const key of keys) {
      if (key.length > MAX_KEY_CHARS || !chargeChars(ctx, key.length)) {
        schema.truncated = true;
        continue;
      }
      schema.properties[key] = normalizeSchema(root, props[key], depth + 1, stack, ctx);
    }
    if (more) {
      schema.truncated = true;
      warn(ctx, 'Schema property count truncated');
    }
  }

  if (rec.items) {
    schema.items = normalizeSchema(root, rec.items, depth + 1, stack, ctx);
  }

  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const list = rec[key];
    if (Array.isArray(list)) {
      schema[key] = list
        .slice(0, 8)
        .map((item) => normalizeSchema(root, item, depth + 1, stack, ctx));
    }
  }

  if (typeof rec.additionalProperties === 'boolean') {
    schema.additionalProperties = rec.additionalProperties;
  } else if (rec.additionalProperties) {
    schema.additionalProperties = normalizeSchema(
      root,
      rec.additionalProperties,
      depth + 1,
      stack,
      ctx,
    );
  }

  return schema;
}

function normalizeParameters(
  root: Record<string, unknown>,
  value: unknown,
  ctx: NormalizeContext,
): NormalizedApiParameter[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: NormalizedApiParameter[] = [];
  for (const item of value.slice(0, 40)) {
    const rec = asRecord(item);
    if (!rec || typeof rec.name !== 'string') {
      continue;
    }
    const location = typeof rec.in === 'string' ? rec.in : 'query';
    if (!['path', 'query', 'header', 'cookie'].includes(location)) {
      continue;
    }
    out.push({
      name: rec.name,
      in: location as NormalizedApiParameter['in'],
      required: Boolean(rec.required) || location === 'path',
      description: truncateText(rec.description),
      deprecated: Boolean(rec.deprecated),
      schema: rec.schema ? normalizeSchema(root, rec.schema, 0, [], ctx) : undefined,
    });
  }
  return out;
}

function normalizeRequestBody(
  root: Record<string, unknown>,
  value: unknown,
  ctx: NormalizeContext,
): NormalizedRequestBody | undefined {
  const rec = asRecord(value);
  if (!rec) {
    return undefined;
  }
  const content = asRecord(rec.content);
  let contentType: string | undefined;
  let schema: NormalizedApiSchema | undefined;
  if (content) {
    const preferred = (content['application/json'] as unknown) ?? Object.values(content)[0];
    contentType =
      content['application/json'] != null
        ? 'application/json'
        : typeof Object.keys(content)[0] === 'string'
          ? Object.keys(content)[0]
          : undefined;
    const media = asRecord(preferred);
    if (media?.schema) {
      schema = normalizeSchema(root, media.schema, 0, [], ctx);
    }
  }
  return {
    required: Boolean(rec.required),
    description: truncateText(rec.description),
    contentType,
    schema,
  };
}

function normalizeResponses(
  root: Record<string, unknown>,
  value: unknown,
  ctx: NormalizeContext,
): NormalizedApiResponse[] {
  const rec = asRecord(value);
  if (!rec) {
    return [];
  }
  const out: NormalizedApiResponse[] = [];
  for (const statusCode of firstKeys(rec, 30).keys) {
    const responseValue = rec[statusCode];
    const response = asRecord(responseValue);
    if (!response) {
      continue;
    }
    const content = asRecord(response.content);
    let contentType: string | undefined;
    let schema: NormalizedApiSchema | undefined;
    if (content) {
      const preferred = (content['application/json'] as unknown) ?? Object.values(content)[0];
      contentType =
        content['application/json'] != null ? 'application/json' : Object.keys(content)[0];
      const media = asRecord(preferred);
      if (media?.schema) {
        schema = normalizeSchema(root, media.schema, 0, [], ctx);
      }
    }
    out.push({
      statusCode,
      description: truncateText(response.description),
      contentType,
      schema,
    });
  }
  return out;
}

function normalizeEnum(
  ctx: NormalizeContext,
  value: unknown,
): Array<string | number | boolean | null> | undefined {
  if (!Array.isArray(value)) return undefined;
  // Slice BEFORE filtering (see the per-node bounds above).
  const items = value
    .slice(0, MAX_ENUM_ITEMS)
    .filter(
      (v): v is string | number | boolean | null =>
        v === null ||
        typeof v === 'number' ||
        typeof v === 'boolean' ||
        (typeof v === 'string' && v.length <= MAX_ENUM_ITEM_CHARS),
    );
  const chars = items.reduce<number>((n, v) => n + (typeof v === 'string' ? v.length : 4), 0);
  return chargeChars(ctx, chars) ? items : undefined;
}

/** Bounded per requirement object and per scope list; computed once per distinct input. */
function normalizeSecurity(value: unknown): NormalizedSecurityRequirement[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const out: NormalizedSecurityRequirement[] = [];
  for (const item of value.slice(0, 10)) {
    const rec = asRecord(item);
    if (!rec) continue;
    for (const name of firstKeys(rec, MAX_SECURITY_SCHEMES).keys) {
      if (name.length > MAX_KEY_CHARS) continue;
      const scopes = rec[name];
      out.push({
        name,
        scopes: Array.isArray(scopes)
          ? scopes
              .slice(0, 20)
              .filter((s): s is string => typeof s === 'string' && s.length <= MAX_KEY_CHARS)
          : undefined,
      });
    }
  }
  return out.length ? out : undefined;
}

/**
 * Normalize OpenAPI 3.x (preferred) or Swagger 2.0 (best-effort) into a typed contract.
 */
export function normalizeOpenApiDocument(
  document: unknown,
  source: { type: 'url' | 'page'; documentUrl?: string },
  rawForHash: string,
): NormalizedApiContract {
  if (!isOpenApiLikeDocument(document)) {
    throw new Error('UNSUPPORTED_OR_INVALID');
  }

  const root = document;
  const warnings: string[] = [];
  const ctx: NormalizeContext = {
    warnings,
    remainingNodes: OPENAPI_MAX_SCHEMA_NODES,
    budgetExhausted: false,
    valueSizes: new WeakMap(),
  };
  // The document-level security requirement applies to every operation without its own:
  // normalized once and shared, not once per operation.
  const rootSecurity = normalizeSecurity(root.security);
  const openapiVersion =
    typeof root.openapi === 'string'
      ? root.openapi
      : typeof root.swagger === 'string'
        ? root.swagger
        : 'unknown';

  if (typeof root.swagger === 'string' && root.swagger === '2.0') {
    warnings.push('Swagger 2.0 support is best-effort; prefer OpenAPI 3.x.');
  } else if (typeof root.openapi === 'string' && !root.openapi.startsWith('3.')) {
    throw new Error('UNSUPPORTED_VERSION');
  }

  const info = asRecord(root.info) ?? {};
  const paths = asRecord(root.paths) ?? {};
  const components = asRecord(root.components) ?? {};
  const componentSchemas = asRecord(components.schemas) ?? asRecord(root.definitions) ?? {};

  const schemas: Record<string, NormalizedApiSchema> = {};
  let schemaCount = 0;
  const schemaRefPrefix =
    typeof root.swagger === 'string' ? '#/definitions/' : '#/components/schemas/';
  for (const [name, schema] of Object.entries(componentSchemas)) {
    if (schemaCount >= OPENAPI_MAX_SCHEMAS) {
      warnings.push(`Schema catalog truncated at ${OPENAPI_MAX_SCHEMAS}`);
      break;
    }
    // Seed stack with this schema's own $ref so self-references truncate immediately.
    schemas[name] = {
      ...normalizeSchema(root, schema, 0, [`${schemaRefPrefix}${name}`], ctx),
      name,
    };
    schemaCount += 1;
  }

  const operations: NormalizedApiOperation[] = [];
  let totalOps = 0;
  for (const [path, pathItemValue] of Object.entries(paths)) {
    const pathItem = asRecord(pathItemValue);
    if (!pathItem) continue;
    for (const [methodRaw, operationValue] of Object.entries(pathItem)) {
      const method = normalizeMethod(methodRaw);
      if (!method) continue;
      totalOps += 1;
      if (operations.length >= OPENAPI_MAX_OPERATIONS) {
        continue;
      }
      const op = asRecord(operationValue);
      if (!op) continue;

      // Swagger 2.0 request body often uses body parameter
      let requestBody = normalizeRequestBody(root, op.requestBody, ctx);
      const parameters = normalizeParameters(root, op.parameters, ctx);
      if (!requestBody) {
        const bodyParam = parameters.find((p) => p.in === 'path' && false);
        void bodyParam;
        const swaggerBody = Array.isArray(op.parameters)
          ? (op.parameters as unknown[]).map(asRecord).find((p) => p?.in === 'body')
          : null;
        if (swaggerBody?.schema) {
          requestBody = {
            required: Boolean(swaggerBody.required),
            description: truncateText(swaggerBody.description),
            contentType: 'application/json',
            schema: normalizeSchema(root, swaggerBody.schema, 0, [], ctx),
          };
        }
      }

      const operationId = typeof op.operationId === 'string' ? op.operationId : undefined;
      operations.push({
        id: operationIdFor(method, path, operationId),
        method,
        path,
        operationId,
        summary: truncateText(op.summary, 240),
        description: truncateText(op.description),
        tags: Array.isArray(op.tags)
          ? op.tags.filter((t): t is string => typeof t === 'string').slice(0, 20)
          : undefined,
        deprecated: Boolean(op.deprecated),
        parameters: parameters.filter((p) => p.in !== 'path' || true),
        requestBody,
        responses: normalizeResponses(root, op.responses, ctx),
        security: op.security !== undefined ? normalizeSecurity(op.security) : rootSecurity,
      });
    }
  }

  if (totalOps > OPENAPI_MAX_OPERATIONS) {
    warnings.push(`Parsed ${OPENAPI_MAX_OPERATIONS} of ${totalOps} operations.`);
  }

  const serversRaw = Array.isArray(root.servers) ? root.servers : [];
  const servers = serversRaw
    .map(asRecord)
    .filter((s): s is Record<string, unknown> => Boolean(s))
    .map((s) => ({
      url: typeof s.url === 'string' ? s.url : '',
      description: truncateText(s.description, 200),
    }))
    .filter((s) => s.url)
    .slice(0, 20);

  // Swagger 2 host/basePath → synthetic server (documentation only — never fetched)
  if (!servers.length && typeof root.host === 'string') {
    const scheme =
      Array.isArray(root.schemes) && typeof root.schemes[0] === 'string'
        ? root.schemes[0]
        : 'https';
    const basePath = typeof root.basePath === 'string' ? root.basePath : '';
    servers.push({
      url: `${scheme}://${root.host}${basePath}`,
      description: undefined,
    });
  }

  const tagsRaw = Array.isArray(root.tags) ? root.tags : [];
  const tags = tagsRaw
    .map(asRecord)
    .filter((t): t is Record<string, unknown> => t != null && typeof t.name === 'string')
    .map((t) => ({
      name: String(t.name),
      description: truncateText(t.description, 400),
    }))
    .slice(0, 50);

  return {
    version: openapiVersion,
    title: truncateText(info.title, 200),
    description: truncateText(info.description),
    servers,
    tags,
    operations,
    schemas,
    source,
    documentHash: hashOpenApiDocument(rawForHash),
    partial:
      totalOps > OPENAPI_MAX_OPERATIONS ||
      schemaCount >= OPENAPI_MAX_SCHEMAS ||
      ctx.budgetExhausted ||
      undefined,
    warnings: warnings.length ? [...new Set(warnings)].slice(0, 40) : undefined,
    operationCountTotal: totalOps,
    operationCountIncluded: operations.length,
    fetchedAt: new Date().toISOString(),
  };
}
