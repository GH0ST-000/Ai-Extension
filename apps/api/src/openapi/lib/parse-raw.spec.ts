import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isOpenApiLikeDocument, parseOpenApiRaw } from './parse-raw';

const fixturesDir = join(__dirname, '../fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

describe('parseOpenApiRaw', () => {
  it('parses JSON', () => {
    const raw = loadFixture('minimal-openapi-3.json');
    const { document, format } = parseOpenApiRaw(raw);
    expect(format).toBe('json');
    expect(isOpenApiLikeDocument(document)).toBe(true);
    if (isOpenApiLikeDocument(document)) {
      expect(document.openapi).toBe('3.0.3');
    }
  });

  it('parses YAML with JSON_SCHEMA', () => {
    const raw = loadFixture('minimal-openapi-3.yaml');
    const { document, format } = parseOpenApiRaw(raw);
    expect(format).toBe('yaml');
    expect(isOpenApiLikeDocument(document)).toBe(true);
    if (isOpenApiLikeDocument(document) && document.info && typeof document.info === 'object') {
      expect((document.info as { title?: string }).title).toBe('Pets API YAML');
    }
  });

  it('does not execute YAML !!js/function or custom tags', () => {
    const malicious = `
openapi: "3.0.3"
info:
  title: !!js/function >
    function () { return 'pwned'; }
  version: "1.0.0"
paths: {}
`;
    expect(() => parseOpenApiRaw(malicious)).toThrow();

    const customTag = `
openapi: "3.0.3"
info:
  title: !python/object/apply:os.system ['echo pwned']
  version: "1.0.0"
paths: {}
`;
    expect(() => parseOpenApiRaw(customTag)).toThrow();
  });

  it('rejects empty and malformed input', () => {
    expect(() => parseOpenApiRaw('')).toThrow(/EMPTY_DOCUMENT/);
    expect(() => parseOpenApiRaw('   ')).toThrow(/EMPTY_DOCUMENT/);
    expect(() => parseOpenApiRaw('{not-json')).toThrow();
    expect(() => parseOpenApiRaw(':\n  - bad yaml: [')).toThrow();
  });
});
