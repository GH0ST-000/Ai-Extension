import { createHash } from 'node:crypto';

import * as yaml from 'js-yaml';

export function hashOpenApiDocument(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

/**
 * Parse OpenAPI JSON or YAML using safe YAML schema (no custom constructors).
 */
export function parseOpenApiRaw(content: string): { document: unknown; format: 'json' | 'yaml' } {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('EMPTY_DOCUMENT');
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return { document: JSON.parse(trimmed) as unknown, format: 'json' };
  }

  const document = yaml.load(trimmed, {
    schema: yaml.JSON_SCHEMA,
    json: true,
  });
  return { document, format: 'yaml' };
}

export function isOpenApiLikeDocument(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const doc = value as Record<string, unknown>;
  if (typeof doc.openapi === 'string') {
    return doc.openapi.startsWith('3.');
  }
  if (typeof doc.swagger === 'string') {
    return doc.swagger === '2.0';
  }
  return false;
}
