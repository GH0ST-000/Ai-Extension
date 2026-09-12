import type { RelationshipConfidence } from '@project-x/types';

export interface HttpPathEvidence {
  method?: string;
  path: string;
  kind: 'provider' | 'consumer';
  confidence: RelationshipConfidence;
  summary: string;
  line?: number;
  excerpt?: string;
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

function excerptAround(content: string, index: number, length = 120): string {
  const start = Math.max(0, index - 20);
  return content
    .slice(start, start + length)
    .replace(/\s+/g, ' ')
    .trim();
}

function pushUnique(out: HttpPathEvidence[], item: HttpPathEvidence): void {
  const key = `${item.kind}|${item.method ?? ''}|${item.path}|${item.line ?? ''}`;
  if (out.some((e) => `${e.kind}|${e.method ?? ''}|${e.path}|${e.line ?? ''}` === key)) {
    return;
  }
  out.push(item);
}

/** Detect NestJS / Express-style route providers and OpenAPI path literals. */
export function detectHttpProviderPaths(content: string, path: string): HttpPathEvidence[] {
  const out: HttpPathEvidence[] = [];
  const isLikelyRouteFile =
    /\.(ts|js|tsx|jsx)$/i.test(path) ||
    /controller|route|openapi|swagger/i.test(path) ||
    /\.(ya?ml|json)$/i.test(path);

  if (!isLikelyRouteFile && !content.includes('@Controller') && !content.includes('paths:')) {
    return out;
  }

  const decoratorRe = /@(Get|Post|Put|Patch|Delete|Head|Options)\(\s*(['"`])(\/[^'"`]*?)\2\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = decoratorRe.exec(content)) !== null) {
    const method = match[1]?.toUpperCase();
    const routePath = match[3];
    if (!method || !routePath) continue;
    pushUnique(out, {
      method,
      path: routePath,
      kind: 'provider',
      confidence: 'high',
      summary: `Route decorator ${method} ${routePath}`,
      line: lineNumberAt(content, match.index),
      excerpt: excerptAround(content, match.index),
    });
  }

  const expressRe = /\.(get|post|put|patch|delete|head|options)\(\s*(['"`])(\/[^'"`]*?)\2/gi;
  while ((match = expressRe.exec(content)) !== null) {
    const method = match[1]?.toUpperCase();
    const routePath = match[3];
    if (!method || !routePath) continue;
    pushUnique(out, {
      method,
      path: routePath,
      kind: 'provider',
      confidence: 'medium',
      summary: `Express-style ${method} ${routePath}`,
      line: lineNumberAt(content, match.index),
      excerpt: excerptAround(content, match.index),
    });
  }

  // OpenAPI paths map keys: "/payments/{id}/retry":
  const openApiPathRe = /^\s*(['"`])(\/[A-Za-z0-9_{}\-./]+)\1\s*:/gm;
  while ((match = openApiPathRe.exec(content)) !== null) {
    const routePath = match[2];
    if (!routePath) continue;
    pushUnique(out, {
      path: routePath,
      kind: 'provider',
      confidence: /\.(ya?ml|json)$/i.test(path) ? 'high' : 'medium',
      summary: `OpenAPI-style path ${routePath}`,
      line: lineNumberAt(content, match.index),
      excerpt: excerptAround(content, match.index),
    });
  }

  return out;
}

/** Detect fetch/axios/client call sites that reference HTTP path strings. */
export function detectHttpConsumerPaths(content: string, path: string): HttpPathEvidence[] {
  const out: HttpPathEvidence[] = [];
  if (!/\.(ts|js|tsx|jsx)$/i.test(path) && !/client|api|sdk|service/i.test(path)) {
    // Still scan if fetch/axios present
    if (!/\bfetch\s*\(|axios\.|request\s*\(/.test(content)) {
      return out;
    }
  }

  const methodPathRe = new RegExp(
    `\\b(?:method\\s*:\\s*)?(['"\`])(${HTTP_METHODS.join('|')})\\1\\s*,?\\s*(?:url\\s*:\\s*)?(['"\`])(\\/[^'"\`]*)\\3`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = methodPathRe.exec(content)) !== null) {
    const method = match[2]?.toUpperCase();
    const routePath = match[4];
    if (!method || !routePath) continue;
    pushUnique(out, {
      method,
      path: routePath,
      kind: 'consumer',
      confidence: 'medium',
      summary: `HTTP client ${method} ${routePath}`,
      line: lineNumberAt(content, match.index),
      excerpt: excerptAround(content, match.index),
    });
  }

  const fetchRe =
    /\b(?:fetch|axios\.(?:get|post|put|patch|delete)|axios)\(\s*(['"`])(\/[^'"`]+)\1/gi;
  while ((match = fetchRe.exec(content)) !== null) {
    const routePath = match[2];
    if (!routePath) continue;
    const callee = match[0]?.split('(')[0]?.trim() ?? 'fetch';
    let method: string | undefined;
    const lower = callee.toLowerCase();
    for (const m of HTTP_METHODS) {
      if (lower.includes(`.${m.toLowerCase()}`)) {
        method = m;
        break;
      }
    }
    pushUnique(out, {
      method,
      path: routePath,
      kind: 'consumer',
      confidence: method ? 'medium' : 'low',
      summary: `Call site ${callee} → ${routePath}`,
      line: lineNumberAt(content, match.index),
      excerpt: excerptAround(content, match.index),
    });
  }

  // Template literals with API path fragments: `/payments/${id}/retry`
  const templatePathRe = /`(\/[A-Za-z0-9_{}\-./${}]+)`/g;
  while ((match = templatePathRe.exec(content)) !== null) {
    const routePath = match[1];
    if (!routePath || !routePath.includes('/')) continue;
    // Only keep paths that look like API routes (at least 2 segments)
    const staticShape = routePath.replace(/\$\{[^}]+\}/g, '{param}');
    if (staticShape.split('/').filter(Boolean).length < 2) continue;
    // Prefer surrounding consumer context
    const window = content.slice(Math.max(0, match.index - 40), match.index + 80);
    if (!/fetch|axios|request|api|client|http/i.test(window)) continue;
    pushUnique(out, {
      path: staticShape,
      kind: 'consumer',
      confidence: 'low',
      summary: `Path string ${staticShape}`,
      line: lineNumberAt(content, match.index),
      excerpt: excerptAround(content, match.index),
    });
  }

  return out;
}
