import { describe, expect, it } from 'vitest';

import {
  detectOpenApiPageType,
  parseSwaggerOperationFromDom,
  sanitizeDocumentUrl,
} from './adapters/openapi.adapter';

describe('detectOpenApiPageType', () => {
  it('detects swagger-ui from DOM hint', () => {
    expect(
      detectOpenApiPageType(new URL('https://api.example.com/docs'), { hasSwaggerUi: true }),
    ).toBe('swagger-ui');
  });

  it('detects redoc from DOM hint', () => {
    expect(detectOpenApiPageType(new URL('https://api.example.com/docs'), { hasRedoc: true })).toBe(
      'redoc',
    );
  });

  it('detects openapi-document from path', () => {
    expect(detectOpenApiPageType(new URL('https://api.example.com/openapi.json'), {})).toBe(
      'openapi-document',
    );
    expect(detectOpenApiPageType(new URL('https://api.example.com/v3/api-docs'), {})).toBe(
      'openapi-document',
    );
    expect(detectOpenApiPageType(new URL('https://api.example.com/swagger.yaml'), {})).toBe(
      'openapi-document',
    );
  });

  it('detects openapi-document from body prefix', () => {
    expect(
      detectOpenApiPageType(new URL('https://api.example.com/spec'), {
        bodyPrefix: 'openapi: 3.0.3\ninfo:',
      }),
    ).toBe('openapi-document');
    expect(
      detectOpenApiPageType(new URL('https://api.example.com/spec'), {
        contentType: 'application/json',
        bodyPrefix: '{"openapi":"3.0.0","info":{',
      }),
    ).toBe('openapi-document');
  });

  it('returns unknown for unrelated pages', () => {
    expect(detectOpenApiPageType(new URL('https://example.com/about'), {})).toBe('unknown');
  });
});

describe('sanitizeDocumentUrl', () => {
  it('strips credentials and sensitive query params', () => {
    expect(
      sanitizeDocumentUrl('https://user:pass@api.example.com/openapi.json?token=secret&v=1'),
    ).toBe('https://api.example.com/openapi.json?v=1');
  });
});

describe('parseSwaggerOperationFromDom', () => {
  it('parses method and path from expanded opblock', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="opblock opblock-get is-open" id="operations-Pets-getPet">
        <div class="opblock-summary">
          <span class="opblock-summary-method">GET</span>
          <span class="opblock-summary-path" data-path="/pets/{id}">/pets/{id}</span>
          <span class="opblock-summary-description">Get a pet</span>
        </div>
      </div>
    `;
    expect(parseSwaggerOperationFromDom(root)).toEqual({
      method: 'GET',
      path: '/pets/{id}',
      operationId: 'Pets-getPet',
      summary: 'Get a pet',
    });
  });

  it('returns null when no expanded operation', () => {
    const root = document.createElement('div');
    root.innerHTML = `<div class="opblock opblock-post"><span data-path="/pets"></span></div>`;
    expect(parseSwaggerOperationFromDom(root)).toBeNull();
  });
});
