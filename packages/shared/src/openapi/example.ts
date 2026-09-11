import type {
  ApiGeneratedExample,
  HttpMethod,
  NormalizedApiOperation,
  NormalizedApiSchema,
} from '@project-x/types';

function sampleForSchema(schema: NormalizedApiSchema | undefined, depth = 0): unknown {
  if (!schema || depth > 6) {
    return null;
  }
  if (schema.example !== undefined) {
    return schema.example;
  }
  if (schema.default !== undefined) {
    return schema.default;
  }
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[0];
  }

  if (schema.allOf?.length) {
    const merged: Record<string, unknown> = {};
    for (const part of schema.allOf) {
      const value = sampleForSchema(part, depth + 1);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(merged, value);
      }
    }
    return Object.keys(merged).length ? merged : sampleForSchema(schema.allOf[0], depth + 1);
  }
  if (schema.oneOf?.length) {
    return sampleForSchema(schema.oneOf[0], depth + 1);
  }
  if (schema.anyOf?.length) {
    return sampleForSchema(schema.anyOf[0], depth + 1);
  }

  const type = schema.type ?? (schema.properties ? 'object' : schema.items ? 'array' : 'string');
  switch (type) {
    case 'string': {
      if (schema.format === 'uuid') return '123e4567-e89b-12d3-a456-426614174000';
      if (schema.format === 'email') return 'user@example.com';
      if (schema.format === 'date-time') return '2026-01-15T12:00:00.000Z';
      if (schema.format === 'date') return '2026-01-15';
      if (schema.format === 'uri' || schema.format === 'url') return 'https://example.com';
      return 'string';
    }
    case 'integer':
    case 'number':
      return schema.minimum ?? 1;
    case 'boolean':
      return true;
    case 'array':
      return [sampleForSchema(schema.items, depth + 1)];
    case 'object': {
      const obj: Record<string, unknown> = {};
      const required = new Set(schema.required ?? []);
      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        if (required.has(key) || Object.keys(obj).length < 6) {
          obj[key] = sampleForSchema(prop, depth + 1);
        }
      }
      return obj;
    }
    default:
      return null;
  }
}

function fillPath(path: string, operation: NormalizedApiOperation): string {
  let result = path;
  for (const param of operation.parameters.filter((p) => p.in === 'path')) {
    const value = sampleForSchema(param.schema);
    const encoded = encodeURIComponent(String(value ?? param.name));
    result = result.replace(`{${param.name}}`, encoded);
  }
  return result;
}

function queryString(operation: NormalizedApiOperation): string {
  const parts: string[] = [];
  for (const param of operation.parameters.filter((p) => p.in === 'query')) {
    if (!param.required && parts.length >= 3) continue;
    const value = sampleForSchema(param.schema);
    parts.push(`${encodeURIComponent(param.name)}=${encodeURIComponent(String(value ?? 'value'))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * Deterministic schema-driven example generator. Never executes requests.
 * Auth is always a placeholder — never real credentials.
 */
export function generateApiExample(operation: NormalizedApiOperation): ApiGeneratedExample {
  const notes: string[] = ['Generated Example — not an actual request.'];
  const path = `${fillPath(operation.path, operation)}${queryString(operation)}`;
  const headers: Record<string, string> = {};

  if (operation.requestBody?.contentType) {
    headers['Content-Type'] = operation.requestBody.contentType;
  } else if (operation.requestBody) {
    headers['Content-Type'] = 'application/json';
  }

  const needsAuth = Boolean(operation.security?.length);
  if (needsAuth) {
    headers.Authorization = 'Bearer <token>';
    notes.push('Authorization uses a placeholder. Do not paste real credentials.');
  } else {
    notes.push('No security scheme is defined on this operation.');
  }

  const body = operation.requestBody?.schema
    ? sampleForSchema(operation.requestBody.schema)
    : undefined;

  const method = operation.method as HttpMethod;
  const headerLines = Object.entries(headers)
    .map(([k, v]) => `  -H '${k}: ${v}'`)
    .join(' \\\n');
  const bodyLine = body !== undefined ? ` \\\n  -d '${JSON.stringify(body)}'` : '';

  const curl = [
    `curl -X ${method} 'https://example.com${path}'`,
    headerLines ? ` \\\n${headerLines}` : '',
    bodyLine,
  ].join('');

  return {
    method,
    path,
    curl,
    headers,
    body,
    notes,
  };
}
