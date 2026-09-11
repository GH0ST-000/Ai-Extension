import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import {
  isPrivateOrReservedIp,
  sanitizeOpenApiDocumentUrl,
  validateOpenApiFetchUrl,
} from '@project-x/shared';
import {
  OPENAPI_FETCH_TIMEOUT_MS,
  OPENAPI_MAX_DOCUMENT_BYTES,
  OPENAPI_MAX_REDIRECTS,
} from '@project-x/types';

import { OpenApiErrorNormalizer } from './openapi-error-normalizer';

/** Soft content-type gate — missing type is allowed; binary media is rejected. */
function isLikelyOpenApiContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (!ct) {
    return true;
  }
  if (
    ct.startsWith('image/') ||
    ct.startsWith('audio/') ||
    ct.startsWith('video/') ||
    ct.startsWith('font/') ||
    ct === 'application/octet-stream' ||
    ct === 'application/pdf' ||
    ct === 'application/zip'
  ) {
    return false;
  }
  return (
    ct.includes('json') ||
    ct.includes('yaml') ||
    ct.includes('yml') ||
    ct.startsWith('text/') ||
    ct === 'application/openapi+json' ||
    ct === 'application/vnd.oai.openapi' ||
    ct === 'application/vnd.oai.openapi+json'
  );
}

async function assertResolvedPublic(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new Error('PRIVATE_IP');
    }
    return;
  }
  const records = await lookup(host, { all: true, verbatim: true });
  if (!records.length) {
    throw new Error('DNS');
  }
  for (const record of records) {
    if (isPrivateOrReservedIp(record.address)) {
      throw new Error('PRIVATE_IP');
    }
  }
}

/**
 * Fetch a public OpenAPI document with SSRF protections.
 * Not a generic URL proxy — OpenAPI acquisition only.
 */
export class OpenApiFetchService {
  constructor(private readonly errors: OpenApiErrorNormalizer) {}

  async fetchDocument(rawUrl: string): Promise<{ content: string; sanitizedUrl: string }> {
    const validated = validateOpenApiFetchUrl(rawUrl);
    if (!validated.ok) {
      throw this.errors.toHttpException(
        'API_DOC_FETCH_BLOCKED',
        'This API definition URL cannot be fetched safely.',
      );
    }

    let current = validated.url;
    let redirects = 0;

    while (redirects <= OPENAPI_MAX_REDIRECTS) {
      try {
        await assertResolvedPublic(current.hostname);
      } catch (err) {
        const code = err instanceof Error ? err.message : '';
        throw this.errors.toHttpException(
          code === 'PRIVATE_IP' ? 'API_DOC_FETCH_BLOCKED' : 'API_DOC_FETCH_FAILED',
          code === 'PRIVATE_IP'
            ? 'This API definition URL cannot be fetched safely.'
            : 'Unable to resolve the OpenAPI document host.',
        );
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OPENAPI_FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(current.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            Accept: 'application/json, application/yaml, text/yaml, text/plain, */*',
            'User-Agent': 'Project-X-OpenAPI',
          },
        });
      } catch {
        throw this.errors.toHttpException(
          'API_DOC_FETCH_FAILED',
          'Unable to fetch the OpenAPI document.',
        );
      } finally {
        clearTimeout(timer);
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          throw this.errors.toHttpException(
            'API_DOC_REDIRECT_BLOCKED',
            'OpenAPI document redirect was missing a Location header.',
          );
        }
        redirects += 1;
        if (redirects > OPENAPI_MAX_REDIRECTS) {
          throw this.errors.toHttpException(
            'API_DOC_REDIRECT_BLOCKED',
            'Too many redirects while fetching the OpenAPI document.',
          );
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw this.errors.toHttpException(
            'API_DOC_REDIRECT_BLOCKED',
            'OpenAPI document redirect target was invalid.',
          );
        }
        const nextValidated = validateOpenApiFetchUrl(next.toString());
        if (!nextValidated.ok) {
          throw this.errors.toHttpException(
            'API_DOC_REDIRECT_BLOCKED',
            'OpenAPI document redirected to a blocked destination.',
          );
        }
        current = nextValidated.url;
        continue;
      }

      if (!response.ok) {
        throw this.errors.toHttpException(
          response.status === 404 ? 'API_DOC_NOT_FOUND' : 'API_DOC_FETCH_FAILED',
          response.status === 404
            ? 'Project X could not find an OpenAPI document for this URL.'
            : 'Unable to fetch the OpenAPI document.',
        );
      }

      const contentType = response.headers.get('content-type');
      if (contentType && !isLikelyOpenApiContentType(contentType)) {
        throw this.errors.toHttpException(
          'API_DOC_INVALID',
          'The fetched resource does not look like an OpenAPI document.',
        );
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > OPENAPI_MAX_DOCUMENT_BYTES) {
        throw this.errors.toHttpException(
          'API_DOC_TOO_LARGE',
          'This OpenAPI document is too large to analyze safely.',
        );
      }
      return {
        content: buffer.toString('utf8'),
        sanitizedUrl: sanitizeOpenApiDocumentUrl(current.toString()),
      };
    }

    throw this.errors.toHttpException(
      'API_DOC_REDIRECT_BLOCKED',
      'Too many redirects while fetching the OpenAPI document.',
    );
  }
}
