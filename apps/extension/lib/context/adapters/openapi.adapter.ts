import type { ApiDocPageType, HttpMethod, PageContext, PageContextOpenApi } from '@project-x/types';
import { HTTP_METHODS, OPENAPI_MAX_DOCUMENT_BYTES } from '@project-x/types';

import { MAX_TITLE_CHARS, MAX_URL_CHARS } from '../constants';
import type { PageAdapter } from '../page-adapter';
import { truncateText } from '../dom-context';

const OPENAPI_PATH_RE =
  /(?:^|\/)(?:openapi|swagger)(?:\.(?:json|ya?ml)|$)|(?:^|\/)(?:api-docs|v3\/api-docs)(?:\.json)?$/i;

const HTTP_METHOD_SET = new Set<string>(HTTP_METHODS);

export type OpenApiPageHints = {
  hasSwaggerUi?: boolean;
  hasRedoc?: boolean;
  contentType?: string;
  /** Bounded document prefix (never full body scrape). */
  bodyPrefix?: string;
  path?: string;
};

/**
 * Detect OpenAPI/Swagger page type from URL + safe hints. Pure for unit tests.
 */
export function detectOpenApiPageType(url: URL, hints: OpenApiPageHints = {}): ApiDocPageType {
  if (hints.hasSwaggerUi) {
    return 'swagger-ui';
  }
  if (hints.hasRedoc) {
    return 'redoc';
  }

  const path = hints.path ?? url.pathname;
  const contentType = (hints.contentType ?? '').toLowerCase();
  const prefix = (hints.bodyPrefix ?? '').trimStart().slice(0, 64).toLowerCase();

  const looksLikeDocumentPath = OPENAPI_PATH_RE.test(path);
  const looksLikeDocContentType =
    contentType.includes('json') ||
    contentType.includes('yaml') ||
    contentType.includes('yml') ||
    contentType.includes('openapi');
  const looksLikeDocPrefix =
    prefix.startsWith('openapi:') ||
    prefix.startsWith('swagger:') ||
    (prefix.startsWith('{') && (prefix.includes('"openapi"') || prefix.includes('"swagger"')));

  if (
    looksLikeDocumentPath ||
    (looksLikeDocContentType && looksLikeDocPrefix) ||
    looksLikeDocPrefix
  ) {
    return 'openapi-document';
  }

  return 'unknown';
}

function isHttpMethod(value: string): value is HttpMethod {
  return HTTP_METHOD_SET.has(value.toUpperCase());
}

/**
 * Parse expanded Swagger UI operation from a DOM subtree.
 * Looks for `[data-path]` + method class (`opblock-get`) or aria labels.
 */
export function parseSwaggerOperationFromDom(root: ParentNode = document): {
  method: HttpMethod;
  path: string;
  operationId?: string;
  summary?: string;
} | null {
  const expanded =
    root.querySelector('.opblock.is-open, .opblock.opblock-open, .opblock[aria-expanded="true"]') ??
    root.querySelector('.opblock.is-open .opblock-summary, [data-path].is-open');

  const block =
    expanded?.closest('.opblock') ??
    (expanded instanceof Element ? expanded : null) ??
    root.querySelector('.opblock.is-open');

  if (!block) {
    return null;
  }

  const pathEl =
    block.querySelector('[data-path]') ??
    block.querySelector('.opblock-summary-path, .opblock-summary-path__path');
  const pathAttr =
    pathEl?.getAttribute('data-path')?.trim() ||
    pathEl?.textContent?.replace(/\s+/g, ' ').trim() ||
    '';
  if (!pathAttr.startsWith('/')) {
    return null;
  }

  let method: HttpMethod | null = null;
  const classList = block.className?.toString() ?? '';
  const classMatch = classList.match(/opblock-(get|post|put|patch|delete|head|options|trace)\b/i);
  if (classMatch?.[1] && isHttpMethod(classMatch[1])) {
    method = classMatch[1].toUpperCase() as HttpMethod;
  }

  if (!method) {
    const methodEl = block.querySelector(
      '.opblock-summary-method, [data-method], .opblock-summary span',
    );
    const methodText =
      methodEl?.getAttribute('data-method')?.trim() ||
      methodEl?.textContent?.replace(/\s+/g, ' ').trim() ||
      '';
    if (methodText && isHttpMethod(methodText)) {
      method = methodText.toUpperCase() as HttpMethod;
    }
  }

  if (!method) {
    const aria = block.getAttribute('aria-label') ?? '';
    const ariaMatch = aria.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\b/i);
    if (ariaMatch?.[1] && isHttpMethod(ariaMatch[1])) {
      method = ariaMatch[1].toUpperCase() as HttpMethod;
    }
  }

  if (!method) {
    return null;
  }

  const summaryEl = block.querySelector(
    '.opblock-summary-description, .opblock-summary-operation-id',
  );
  const summary = summaryEl?.textContent?.replace(/\s+/g, ' ').trim() || undefined;
  const operationId =
    block.getAttribute('id')?.replace(/^operations-/, '') ||
    block.querySelector('[data-operation-id]')?.getAttribute('data-operation-id') ||
    undefined;

  return {
    method,
    path: pathAttr,
    operationId: operationId || undefined,
    summary,
  };
}

/** Strip userinfo and sensitive query tokens — never forward credentials. */
export function sanitizeDocumentUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(token|key|secret|password|auth|sig|signature|access)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return raw.split('?')[0] ?? raw;
  }
}

function hasSwaggerUiDom(): boolean {
  return Boolean(document.querySelector('#swagger-ui, .swagger-ui'));
}

function hasRedocDom(): boolean {
  return Boolean(
    document.querySelector('redoc, .redoc-wrap, .redoc-container, #redoc') ||
    document.querySelector('[id*="redoc"], [class*="redoc"]'),
  );
}

function readBoundedBodyPrefix(max = 96): string {
  const pre = document.querySelector('pre, code, body > pre');
  const text = (pre?.textContent ?? document.body?.textContent ?? '').trimStart();
  return text.slice(0, max);
}

/**
 * Discover OpenAPI document URL from Swagger UI without eval.
 * Checks link[rel], input#select, anchors, and nearby `url:` text in #swagger-ui.
 */
export function discoverOpenApiDocumentUrl(pageUrl: URL): string | undefined {
  const linkCandidates = Array.from(
    document.querySelectorAll<HTMLLinkElement>(
      'link[rel="describedby"], link[rel="service"], link[rel="openapi"], link[href*="openapi"], link[href*="swagger"]',
    ),
  );
  for (const link of linkCandidates) {
    const href = link.getAttribute('href')?.trim();
    if (href) {
      return sanitizeDocumentUrl(resolveMaybeRelative(href, pageUrl));
    }
  }

  const select = document.querySelector<HTMLInputElement | HTMLSelectElement>(
    '#select, input#select, select#select, .download-url-input input, input[aria-label*="url" i]',
  );
  const selectVal = select && 'value' in select ? select.value?.trim() : undefined;
  if (selectVal && /^https?:\/\//i.test(selectVal)) {
    return sanitizeDocumentUrl(selectVal);
  }
  if (selectVal && selectVal.startsWith('/')) {
    return sanitizeDocumentUrl(resolveMaybeRelative(selectVal, pageUrl));
  }

  const openapiLinks = Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href*="openapi"], a[href*="swagger"]'),
  );
  for (const anchor of openapiLinks) {
    const href = anchor.getAttribute('href')?.trim();
    if (href && !href.startsWith('javascript:')) {
      return sanitizeDocumentUrl(resolveMaybeRelative(href, pageUrl));
    }
  }

  const swaggerRoot = document.querySelector('#swagger-ui, .swagger-ui');
  if (swaggerRoot) {
    const nearby = swaggerRoot.textContent?.slice(0, 4_000) ?? '';
    const urlMatch = nearby.match(/\burl\s*[:=]\s*["']([^"']+)["']/i);
    if (urlMatch?.[1]) {
      return sanitizeDocumentUrl(resolveMaybeRelative(urlMatch[1], pageUrl));
    }
  }

  // Script tags: look for static config string patterns only (no eval).
  for (const script of Array.from(document.querySelectorAll('script:not([src])'))) {
    const text = script.textContent?.slice(0, 8_000) ?? '';
    if (!/swagger|openapi/i.test(text)) {
      continue;
    }
    const match =
      text.match(/url\s*:\s*["']([^"']+)["']/i) ||
      text.match(/["']url["']\s*:\s*["']([^"']+)["']/i);
    if (match?.[1] && !/\$\{/.test(match[1])) {
      return sanitizeDocumentUrl(resolveMaybeRelative(match[1], pageUrl));
    }
  }

  return undefined;
}

function resolveMaybeRelative(href: string, pageUrl: URL): string {
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return href;
  }
}

/**
 * Bounded extraction of raw OpenAPI document text from the page itself.
 * Prefer pre/code; never bulk-scrape via innerText on the body element.
 */
export function extractOpenApiDocumentText(maxBytes = OPENAPI_MAX_DOCUMENT_BYTES): string | null {
  const pre = document.querySelector('pre, body > pre, code');
  const raw = (pre?.textContent ?? document.body?.textContent ?? '').trim();
  if (!raw) {
    return null;
  }
  const prefix = raw.slice(0, 32).toLowerCase();
  const looksLike =
    prefix.startsWith('openapi:') ||
    prefix.startsWith('swagger:') ||
    (prefix.startsWith('{') && (raw.includes('"openapi"') || raw.includes('"swagger"')));
  if (!looksLike) {
    return null;
  }
  if (raw.length > maxBytes) {
    return raw.slice(0, maxBytes);
  }
  return raw;
}

function collectHints(url: URL): OpenApiPageHints {
  return {
    hasSwaggerUi: hasSwaggerUiDom(),
    hasRedoc: hasRedocDom(),
    contentType: typeof document.contentType === 'string' ? document.contentType : undefined,
    bodyPrefix: readBoundedBodyPrefix(),
    path: url.pathname,
  };
}

export const openapiPageAdapter: PageAdapter = {
  matches(url) {
    const hints = collectHints(url);
    if (hints.hasSwaggerUi || hints.hasRedoc) {
      return true;
    }
    const pageType = detectOpenApiPageType(url, hints);
    return pageType === 'openapi-document';
  },

  extract(url): PageContext {
    const hints = collectHints(url);
    const pageType = detectOpenApiPageType(url, hints);
    const documentUrl =
      pageType === 'openapi-document'
        ? sanitizeDocumentUrl(url.toString())
        : discoverOpenApiDocumentUrl(url);

    const openapi: PageContextOpenApi = {
      pageType,
      origin: url.origin,
      documentUrl,
    };

    if (pageType === 'swagger-ui' || hints.hasSwaggerUi) {
      const selected = parseSwaggerOperationFromDom(document);
      if (selected) {
        openapi.selectedOperation = selected;
      }
    }

    return {
      type: 'openapi',
      url: truncateText(url.toString(), MAX_URL_CHARS),
      title: truncateText(document.title || 'API documentation', MAX_TITLE_CHARS),
      openapi,
    };
  },
};
