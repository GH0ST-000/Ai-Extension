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

function normalizeSchema(
  root: Record<string, unknown>,
  value: unknown,
  depth: number,
  stack: string[],
  warnings: string[],
): NormalizedApiSchema {
  if (depth > OPENAPI_MAX_SCHEMA_DEPTH) {
    return { truncated: true, description: 'Schema depth limit reached' };
  }

  const rec = asRecord(value);
  if (!rec) {
    return { type: 'object', truncated: true };
  }

  if (typeof rec.$ref === 'string') {
    const ref = rec.$ref;
    if (!ref.startsWith('#/')) {
      warnings.push(`External $ref not resolved: ${ref}`);
      return { unresolvedRef: ref, truncated: true };
    }
    const resolved = resolveLocalRef(root, ref, stack, OPENAPI_MAX_SCHEMA_DEPTH);
    const resolvedRec = asRecord(resolved);
    if (resolvedRec?.__circular || resolvedRec?.__unresolved || resolvedRec?.__externalRef) {
      warnings.push(`Reference limit/unresolved: ${ref}`);
      return { unresolvedRef: ref, truncated: true };
    }
    const name = ref.split('/').pop();
    const nested = normalizeSchema(root, resolved, depth + 1, [...stack, ref], warnings);
    return { ...nested, name: nested.name ?? name };
  }

  const schema: NormalizedApiSchema = {
    type: typeof rec.type === 'string' ? rec.type : undefined,
    format: typeof rec.format === 'string' ? rec.format : undefined,
    description: truncateText(rec.description),
    nullable: typeof rec.nullable === 'boolean' ? rec.nullable : undefined,
    enum: Array.isArray(rec.enum)
      ? (rec.enum.filter(
          (v) =>
            v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
        ) as Array<string | number | boolean | null>)
      : undefined,
    default: rec.default,
    example: rec.example,
    minimum: typeof rec.minimum === 'number' ? rec.minimum : undefined,
    maximum: typeof rec.maximum === 'number' ? rec.maximum : undefined,
    minLength: typeof rec.minLength === 'number' ? rec.minLength : undefined,
    maxLength: typeof rec.maxLength === 'number' ? rec.maxLength : undefined,
  };

  if (Array.isArray(rec.required)) {
    schema.required = rec.required.filter((v): v is string => typeof v === 'string').slice(0, 100);
  }

  const props = asRecord(rec.properties);
  if (props) {
    const entries = Object.entries(props).slice(0, OPENAPI_MAX_PROPERTIES);
    schema.properties = {};
    for (const [key, prop] of entries) {
      schema.properties[key] = normalizeSchema(root, prop, depth + 1, stack, warnings);
    }
    if (Object.keys(props).length > OPENAPI_MAX_PROPERTIES) {
      schema.truncated = true;
      warnings.push('Schema property count truncated');
    }
  }

  if (rec.items) {
    schema.items = normalizeSchema(root, rec.items, depth + 1, stack, warnings);
  }

  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const list = rec[key];
    if (Array.isArray(list)) {
      schema[key] = list
        .slice(0, 8)
        .map((item) => normalizeSchema(root, item, depth + 1, stack, warnings));
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
      warnings,
    );
  }

  return schema;
}

function normalizeParameters(
  root: Record<string, unknown>,
  value: unknown,
  warnings: string[],
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
      schema: rec.schema ? normalizeSchema(root, rec.schema, 0, [], warnings) : undefined,
    });
  }
  return out;
}

function normalizeRequestBody(
  root: Record<string, unknown>,
  value: unknown,
  warnings: string[],
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
      schema = normalizeSchema(root, media.schema, 0, [], warnings);
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
  warnings: string[],
): NormalizedApiResponse[] {
  const rec = asRecord(value);
  if (!rec) {
    return [];
  }
  const out: NormalizedApiResponse[] = [];
  for (const [statusCode, responseValue] of Object.entries(rec).slice(0, 30)) {
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
        schema = normalizeSchema(root, media.schema, 0, [], warnings);
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

function normalizeSecurity(value: unknown): NormalizedSecurityRequirement[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const out: NormalizedSecurityRequirement[] = [];
  for (const item of value.slice(0, 10)) {
    const rec = asRecord(item);
    if (!rec) continue;
    for (const [name, scopes] of Object.entries(rec)) {
      out.push({
        name,
        scopes: Array.isArray(scopes)
          ? scopes.filter((s): s is string => typeof s === 'string').slice(0, 20)
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
      ...normalizeSchema(root, schema, 0, [`${schemaRefPrefix}${name}`], warnings),
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
      let requestBody = normalizeRequestBody(root, op.requestBody, warnings);
      const parameters = normalizeParameters(root, op.parameters, warnings);
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
            schema: normalizeSchema(root, swaggerBody.schema, 0, [], warnings),
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
        responses: normalizeResponses(root, op.responses, warnings),
        security: normalizeSecurity(op.security ?? root.security),
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
    partial: totalOps > OPENAPI_MAX_OPERATIONS || schemaCount >= OPENAPI_MAX_SCHEMAS || undefined,
    warnings: warnings.length ? [...new Set(warnings)].slice(0, 40) : undefined,
    operationCountTotal: totalOps,
    operationCountIncluded: operations.length,
    fetchedAt: new Date().toISOString(),
  };
}
