import { MULTI_REPO_MAX_FILE_BYTES, MULTI_REPO_MAX_HTTP_OPS } from '@project-x/types';

import {
  joinHttpPath,
  normalizeHttpMethod,
  normalizeHttpPath,
  type HttpMethodName,
} from './http-paths';

/**
 * OpenAPI 3 / Swagger 2 operation extraction without a YAML deserializer.
 *
 * JSON documents are parsed with JSON.parse. YAML documents are read line by line: only the
 * top-level `paths:` block (path keys, quoted or not, and their method keys) and the server
 * base path are used, so no YAML tags, anchors or constructors are ever evaluated.
 * Documents that do not declare `openapi:` / `swagger:` at the top level are ignored.
 */

export interface DetectedOpenApiOperation {
  method?: HttpMethodName;
  /** Normalized, including the server / basePath prefix when one is declared. */
  path: string;
  line?: number;
}

export interface OpenApiExtraction {
  recognized: boolean;
  operations: DetectedOpenApiOperation[];
  /** More operations than the budget allowed. */
  truncated: boolean;
}

const METHOD_KEYS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const MAX_LINES = 50_000;
const EMPTY: OpenApiExtraction = { recognized: false, operations: [], truncated: false };

export function looksLikeOpenApiPath(filePath: string): boolean {
  return /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i.test(filePath);
}

function serverPrefix(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  const raw = url.trim();
  const path = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '') || '/'
    : raw;
  const normalized = normalizeHttpPath(path.startsWith('/') ? path : `/${path}`);
  return normalized && normalized !== '/' ? normalized : null;
}

function push(out: OpenApiExtraction, op: DetectedOpenApiOperation): boolean {
  if (out.operations.length >= MULTI_REPO_MAX_HTTP_OPS) {
    out.truncated = true;
    return false;
  }
  if (!out.operations.some((o) => o.method === op.method && o.path === op.path)) {
    out.operations.push(op);
  }
  return true;
}

function fromJson(content: string): OpenApiExtraction {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return EMPTY;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return EMPTY;
  const record = doc as Record<string, unknown>;
  const isOpenApi = typeof record.openapi === 'string' || typeof record.swagger === 'string';
  const paths = record.paths;
  if (!isOpenApi || !paths || typeof paths !== 'object' || Array.isArray(paths)) return EMPTY;
  const servers = Array.isArray(record.servers) ? record.servers : [];
  const firstServer = servers[0] as { url?: unknown } | undefined;
  const prefix = serverPrefix(firstServer?.url) ?? serverPrefix(record.basePath);
  const out: OpenApiExtraction = { recognized: true, operations: [], truncated: false };
  for (const [rawPath, item] of Object.entries(paths as Record<string, unknown>)) {
    const path = rawPath.startsWith('/') ? joinHttpPath(prefix, rawPath) : null;
    if (!path) continue;
    const methods =
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.keys(item).filter((k) => METHOD_KEYS.includes(k.toLowerCase()))
        : [];
    if (methods.length === 0 && !push(out, { path })) break;
    for (const m of methods) {
      if (!push(out, { method: normalizeHttpMethod(m), path })) break;
    }
  }
  return out;
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const isSkippable = (line: string) => {
  const t = line.trim();
  return t === '' || t.startsWith('#');
};
const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

function fromYaml(content: string): OpenApiExtraction {
  if (!/^(openapi|swagger)\s*:/m.test(content)) return EMPTY;
  const lines = content.split(/\r?\n/, MAX_LINES);

  let prefix: string | null = null;
  const basePath = content.match(/^basePath\s*:\s*(.+)$/m);
  if (basePath) prefix = serverPrefix(unquote(basePath[1]!));
  const serversAt = lines.findIndex((l) => /^servers\s*:\s*(#.*)?$/.test(l));
  if (!prefix && serversAt >= 0) {
    for (let i = serversAt + 1; i < Math.min(lines.length, serversAt + 20); i += 1) {
      const line = lines[i]!;
      if (!isSkippable(line) && indentOf(line) === 0) break;
      const url = line.match(/^\s*-?\s*url\s*:\s*(.+?)\s*(#.*)?$/);
      if (url) {
        prefix = serverPrefix(unquote(url[1]!));
        break;
      }
    }
  }

  const pathsAt = lines.findIndex((l) => /^paths\s*:\s*(#.*)?$/.test(l));
  if (pathsAt < 0) return { recognized: true, operations: [], truncated: false };
  const out: OpenApiExtraction = { recognized: true, operations: [], truncated: false };
  let pathIndent = -1;
  let methodIndent = -1;
  let current: { path: string; line: number; methods: number } | null = null;

  const flush = () => {
    if (current && current.methods === 0) push(out, { path: current.path, line: current.line });
  };

  for (let i = pathsAt + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (isSkippable(line)) continue;
    const indent = indentOf(line);
    if (indent === 0) break; // end of the paths block
    if (pathIndent < 0) pathIndent = indent;

    if (indent === pathIndent) {
      flush();
      current = null;
      methodIndent = -1;
      const key = line.match(/^\s*(['"]?)(\/[^'"\s]*?)\1\s*:\s*(.*)$/);
      if (!key) continue;
      const path = joinHttpPath(prefix, key[2]!);
      if (!path) continue;
      current = { path, line: i + 1, methods: 0 };
      // Flow style: `/users: { get: {...}, post: {...} }`
      for (const m of key[3]!.matchAll(/\b(get|put|post|delete|options|head|patch|trace)\s*:/gi)) {
        current.methods += 1;
        if (!push(out, { method: normalizeHttpMethod(m[1]), path, line: i + 1 })) return out;
      }
      continue;
    }

    if (current && indent > pathIndent) {
      if (methodIndent < 0) methodIndent = indent;
      if (indent !== methodIndent) continue;
      const method = line.match(/^\s*(['"]?)([A-Za-z]+)\1\s*:/);
      if (method && METHOD_KEYS.includes(method[2]!.toLowerCase())) {
        current.methods += 1;
        const ok = push(out, {
          method: normalizeHttpMethod(method[2]),
          path: current.path,
          line: i + 1,
        });
        if (!ok) return out;
      }
    }
  }
  flush();
  return out;
}

/** Operations declared by an OpenAPI / Swagger document (JSON or YAML). Never throws. */
export function extractOpenApiOperations(content: string): OpenApiExtraction {
  if (typeof content !== 'string' || content.length > MULTI_REPO_MAX_FILE_BYTES) return EMPTY;
  const trimmed = content.trimStart();
  return trimmed.startsWith('{') ? fromJson(trimmed) : fromYaml(content);
}
