import type { RelationshipConfidence } from '@project-x/types';

import {
  PATH_PARAM,
  normalizeHttpMethod,
  normalizeHttpPath,
  type HttpMethodName,
} from './http-paths';

/**
 * Static detection of outgoing HTTP calls in TypeScript / JavaScript source.
 *
 * Recognizes fetch(url[, init]), axios.<method>(url), axios(config), axios.request(config),
 * http(Client).<method>(url) and new URL(path, base), where the URL is a string, template
 * literal, `+` concatenation or a file-local constant built from those. Nothing is executed
 * or evaluated: unknown expressions become `{param}` or make the call unresolvable. URLs found
 * in code are never requested.
 */

export interface HttpCall {
  method?: HttpMethodName;
  /** Normalized path (`/api/users/{param}`). */
  path: string;
  /**
   * Name of the base-URL source when the URL starts with one (`USER_API_BASE_URL` from
   * `process.env.USER_API_BASE_URL`, a constant, or `config.userApiBaseUrl`).
   */
  baseRef?: string;
  /** Absolute URL to a non-local host: an external API, never matched to a repository. */
  external: boolean;
  line: number;
  confidence: RelationshipConfidence;
  summary: string;
}

const MAX_SOURCE_CHARS = 512_000;
const MAX_ARG_CHARS = 2_000;
const MAX_CALLS = 200;
/** Call-site candidates examined per file, matched or not (bounds hostile/minified input). */
const MAX_CANDIDATES = 1_000;
const MAX_CONSTS = 500;
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)(:\d+)?$/i;

// ── tiny lexer helpers ───────────────────────────────────────────────────────

/** Index just past a string / template literal starting at `start` (bounded). */
function skipString(src: string, start: number, limit: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < limit) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`' && ch === '$' && src[i + 1] === '{') {
      i = skipBalanced(src, i + 1, limit);
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return limit;
}

/** `src[open]` is ( [ or {; returns index just past its matching closer (bounded). */
function skipBalanced(src: string, open: number, limit: number): number {
  const closers: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack = [closers[src[open]!]!];
  let i = open + 1;
  while (i < limit && stack.length > 0) {
    const ch = src[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(src, i, limit);
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? limit : nl;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? limit : end + 2;
      continue;
    }
    if (ch in closers) stack.push(closers[ch]!);
    else if (ch === stack[stack.length - 1]) stack.pop();
    i += 1;
  }
  return i;
}

/** Top-level comma-separated arguments of the call whose `(` is at `open`. */
function readArguments(src: string, open: number): string[] {
  const limit = Math.min(src.length, open + MAX_ARG_CHARS);
  const end = skipBalanced(src, open, limit);
  const inner = src.slice(open + 1, Math.max(open + 1, end - 1));
  return splitTopLevel(inner, ',');
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(text, i, text.length);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (depth === 0 && ch === separator) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
    i += 1;
  }
  const last = text.slice(start).trim();
  if (last || parts.length > 0) parts.push(last);
  return parts.filter((p) => p.length > 0);
}

/** `const NAME = <expr>` definitions in one file (first definition wins). */
function collectConstants(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w$.<>[\]| ]+)?=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null && out.size < MAX_CONSTS) {
    const name = m[1]!;
    if (out.has(name)) continue;
    const start = re.lastIndex;
    let i = start;
    const limit = Math.min(src.length, start + 500);
    while (i < limit) {
      const ch = src[i]!;
      if (ch === "'" || ch === '"' || ch === '`') {
        i = skipString(src, i, limit);
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') {
        i = skipBalanced(src, i, limit);
        continue;
      }
      if (ch === ';' || ch === '\n') break;
      i += 1;
    }
    out.set(name, src.slice(start, i).trim());
  }
  return out;
}

// ── URL expression resolution ────────────────────────────────────────────────

interface Resolved {
  /** Raw path text (may contain `{param}`), or null when not statically known. */
  path: string | null;
  baseRef?: string;
  external: boolean;
  /** Expression is a base URL (env / config / origin) without a path of its own. */
  isBase: boolean;
  /** The URL's path comes from a parameter of the enclosing function (request wrapper). */
  wrapper?: WrapperUrl;
}

const UNKNOWN: Resolved = { path: null, external: false, isBase: false };

/** Static resolution context of one file (or one function body + its file). */
interface Ctx {
  consts: Map<string, string>;
  /** `const MAP = { users: '/api/users', byId: (id) => `/api/users/${id}` }` → prop → expr */
  objects: Map<string, Map<string, string>>;
  /** Parameters of the enclosing request wrapper (name → position). */
  params?: Map<string, number>;
}

/** URL built from a wrapper parameter: prefix + <argument #index> + suffix. */
interface WrapperUrl {
  index: number;
  prefix: string;
  suffix: string;
}

const PARAM_MARK = '\u0001';

function stripWrapping(expr: string): string {
  let e = expr
    .trim()
    .replace(/\s+as\s+[\w$.<>[\]| ]+$/, '')
    .replace(/!$/, '');
  while (e.startsWith('(') && e.endsWith(')')) e = e.slice(1, -1).trim();
  return e;
}

function envName(expr: string): string | undefined {
  const m = expr.match(
    /^(?:process\.env|import\.meta\.env)\s*(?:\.\s*([A-Za-z_]\w*)|\[\s*['"]([A-Za-z_]\w*)['"]\s*\])$/,
  );
  return m?.[1] ?? m?.[2];
}

/** Split on top-level `??` / `||` (outside strings and brackets). */
function splitFallback(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(text, i, text.length);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (
      depth === 0 &&
      ((ch === '?' && text[i + 1] === '?') || (ch === '|' && text[i + 1] === '|'))
    ) {
      parts.push(text.slice(start, i).trim());
      i += 2;
      start = i;
      continue;
    }
    i += 1;
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

/** Top-level ternary `a ? b : c` (not `?.` / `??`). */
function hasTernary(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(text, i, text.length) - 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (
      depth === 0 &&
      ch === '?' &&
      text[i + 1] !== '?' &&
      text[i + 1] !== '.' &&
      text[i - 1] !== '?'
    ) {
      return true;
    }
  }
  return false;
}

/** Absolute URL literal → path (+ whether the host is external). */
function fromLiteral(text: string): Resolved {
  const abs = text.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)(.*)$/i);
  if (abs) {
    const host = abs[1]!;
    return {
      path: abs[2] || null,
      external: !LOCAL_HOSTS.test(host),
      isBase: !abs[2] || abs[2] === '/',
    };
  }
  if (text.startsWith('/')) return { path: text, external: false, isBase: false };
  return UNKNOWN;
}

function resolveExpr(expr: string, ctx: Ctx, depth: number): Resolved {
  if (depth > 3) return UNKNOWN;
  const e = stripWrapping(expr);
  if (!e) return UNKNOWN;

  // new URL(path, base)
  const newUrl = e.match(/^new\s+URL\s*\(/);
  if (newUrl) {
    const args = readArguments(e, e.indexOf('('));
    const target = args[0] ? resolveExpr(args[0], ctx, depth + 1) : UNKNOWN;
    const base = args[1] ? resolveExpr(args[1], ctx, depth + 1) : UNKNOWN;
    if (target.wrapper) return { ...target, baseRef: target.baseRef ?? base.baseRef };
    if (!target.path) return UNKNOWN;
    return {
      ...target,
      baseRef: target.baseRef ?? base.baseRef,
      external: target.external || base.external,
    };
  }

  // a ?? b / a || b → the first operand that resolves (`process.env.X ?? 'http://localhost'`).
  const fallback = splitFallback(e);
  if (fallback.length > 1) {
    for (const option of fallback) {
      const r = resolveExpr(option, ctx, depth + 1);
      if (r.baseRef || r.path) return r;
    }
    return UNKNOWN;
  }
  if (hasTernary(e)) return UNKNOWN;

  // Concatenation
  const parts = splitTopLevel(e, '+');
  if (parts.length > 1)
    return resolveSequence(
      parts.map((p) => ({ kind: 'expr', text: p })),
      ctx,
      depth,
    );

  // Template literal
  if (e.startsWith('`') && e.endsWith('`')) return resolveSequence(templateParts(e), ctx, depth);

  // String literal
  const str = e.match(/^(['"])(.*)\1$/s);
  if (str) return fromLiteral(str[2]!);

  // Environment variable / config member / identifier
  const env = envName(e);
  if (env) return { path: null, baseRef: env, external: false, isBase: true };
  if (/^[A-Za-z_$][\w$]*$/.test(e) && ctx.params?.has(e)) {
    return { ...UNKNOWN, wrapper: { index: ctx.params.get(e)!, prefix: '', suffix: '' } };
  }
  const mapped = endpointMapValue(e, ctx);
  if (mapped !== undefined) return resolveExpr(mapped, ctx, depth + 1);
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    const def = ctx.consts.get(e);
    if (def !== undefined) {
      const inner = resolveExpr(def, ctx, depth + 1);
      if (inner.isBase) return { ...inner, baseRef: inner.baseRef ?? e };
      return inner;
    }
    return /url|uri|base|origin|host|endpoint|api/i.test(e)
      ? { path: null, baseRef: e, external: false, isBase: true }
      : UNKNOWN;
  }
  const member = e.match(/^(?:this\.)?(?:[\w$]+\.)*([\w$]+)$/);
  if (member && /url|uri|base|origin|host|endpoint/i.test(member[1]!)) {
    return { path: null, baseRef: member[1], external: false, isBase: true };
  }
  return UNKNOWN;
}

type Part = { kind: 'text'; text: string } | { kind: 'expr'; text: string };

function templateParts(literal: string): Part[] {
  const body = literal.slice(1, -1);
  const out: Part[] = [];
  let i = 0;
  let text = '';
  while (i < body.length) {
    if (body[i] === '\\') {
      text += body.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (body[i] === '$' && body[i + 1] === '{') {
      const end = skipBalanced(body, i + 1, body.length);
      if (text) out.push({ kind: 'text', text });
      text = '';
      out.push({ kind: 'expr', text: body.slice(i + 2, end - 1) });
      i = end;
      continue;
    }
    text += body[i];
    i += 1;
  }
  if (text) out.push({ kind: 'text', text });
  return out;
}

/** Leading base (env/config/origin), then literal path pieces; later expressions → {param}. */
function resolveSequence(parts: Part[], ctx: Ctx, depth: number): Resolved {
  if (parts.length === 0) return UNKNOWN;
  let baseRef: string | undefined;
  let external = false;
  let path = '';
  parts.forEach((part, index) => {
    if (part.kind === 'text') {
      if (index === 0) {
        const lit = fromLiteral(part.text);
        external = lit.external;
        path += lit.path ?? (part.text.startsWith('/') ? part.text : '');
        if (!lit.path && !part.text.startsWith('/') && !/^[a-z]+:\/\//i.test(part.text)) {
          path = '\u0000'; // relative / unknown prefix → unresolvable
        }
      } else {
        path += part.text;
      }
      return;
    }
    // Expression part
    const quoted = part.text.trim().match(/^(['"])(.*)\1$/s);
    if (quoted && index > 0) {
      path += quoted[2];
      return;
    }
    if (index === 0) {
      const base = resolveExpr(part.text, ctx, depth + 1);
      baseRef = base.baseRef;
      external = base.external;
      if (base.path) path += base.path;
      else if (!base.isBase) path = '\u0000';
      return;
    }
    // A wrapper parameter (`${this.baseUrl}${path}`): remember where the argument goes.
    const name = part.text.trim();
    if (ctx.params?.has(name)) {
      // After a `/` the parameter is one segment (`/users/${id}`); otherwise it supplies the
      // rest of the path (`${base}${path}`, `${base}/v1${path}`) — a request wrapper.
      path += path.endsWith('/') ? PATH_PARAM : `${PARAM_MARK}${ctx.params.get(name)}${PARAM_MARK}`;
      return;
    }
    // A later constant holding a literal path (`${BASE}${USERS_PATH}`) keeps its value.
    const def = /^[A-Za-z_$][\w$]*$/.test(name) ? ctx.consts.get(name) : undefined;
    const literal = def !== undefined ? resolveExpr(def, ctx, depth + 1) : UNKNOWN;
    path += literal.path && !literal.isBase && !literal.baseRef ? literal.path : PATH_PARAM;
  });
  if (path.includes(PARAM_MARK) && !path.includes('\u0000')) {
    // Exactly one parameter: [prefix, index, suffix].
    const pieces = path.split(PARAM_MARK);
    const [prefix, index, suffix] = pieces;
    if (pieces.length === 3 && /^\d+$/.test(index!) && (prefix === '' || prefix!.startsWith('/'))) {
      return {
        path: null,
        baseRef,
        external,
        isBase: false,
        wrapper: { index: Number(index), prefix: prefix!, suffix: suffix! },
      };
    }
    return { path: null, baseRef, external, isBase: false };
  }
  if (path.includes('\u0000') || !path.startsWith('/')) {
    return {
      path: null,
      baseRef,
      external,
      isBase: !path || path === '\u0000' ? !!baseRef : false,
    };
  }
  return { path, baseRef, external, isBase: false };
}

// ── endpoint maps & functions ────────────────────────────────────────────────

/** `const MAP = { users: '/api/users', byId: (id) => `/api/users/${id}` }` (top-level props). */
function collectObjects(src: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w$.<>[\]| ]+)?=\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null && out.size < 100) {
    const open = re.lastIndex - 1;
    const end = skipBalanced(src, open, Math.min(src.length, open + 20_000));
    const props = new Map<string, string>();
    for (const entry of splitTopLevel(src.slice(open + 1, end - 1), ',')) {
      const kv = entry.match(/^(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+)$/);
      if (kv) props.set((kv[2] ?? kv[3])!, kv[4]!.trim());
    }
    if (props.size > 0) out.set(m[1]!, props);
  }
  return out;
}

/** `MAP.users` → its value; `MAP.byId(x)` → the arrow function's expression body. */
function endpointMapValue(expr: string, ctx: Ctx): string | undefined {
  const m = expr.match(/^([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*(\([\s\S]*\))?$/);
  if (!m) return undefined;
  const value = ctx.objects.get(m[1]!)?.get(m[2]!);
  if (value === undefined) return undefined;
  if (m[3] === undefined) return value;
  const arrow = value.match(
    /^(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>\s*([\s\S]+)$/,
  );
  const body = arrow?.[1]?.trim();
  return body && !body.startsWith('{') ? body : undefined;
}

interface FunctionScope {
  name: string;
  /** Parameter names by position (null for destructured / unsupported). */
  params: Array<string | null>;
  /** Where the declaration's name is (to tell declarations from calls). */
  nameIndex: number;
  bodyStart: number;
  bodyEnd: number;
}

const NOT_FUNCTIONS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'typeof',
  'await',
  'new',
  'do',
  'else',
  'try',
  'with',
  'super',
  'import',
  'export',
  'constructor',
  'void',
  'delete',
]);
const MAX_FUNCTIONS = 300;
/**
 * Characters the function collector may scan while matching parentheses, across all
 * candidates. Real code has short argument lists and stays far below this; hostile input
 * (e.g. thousands of nested `f(`) would otherwise cost candidates × MAX_ARG_CHARS.
 */
const MAX_FUNCTION_SCAN_CHARS = 4_000_000;

function paramNames(text: string): Array<string | null> {
  return splitTopLevel(text, ',').map((p) => {
    const m = p.match(/^(?:\.\.\.)?([A-Za-z_$][\w$]*)/);
    return m ? m[1]! : null;
  });
}

/** Function declarations, methods and arrow functions with a braced or expression body. */
function collectFunctions(src: string): FunctionScope[] {
  const out: FunctionScope[] = [];
  const nameRe = /([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g;
  let scanned = 0;
  let m: RegExpExecArray | null;
  while (
    scanned < MAX_FUNCTION_SCAN_CHARS &&
    (m = nameRe.exec(src)) !== null &&
    out.length < MAX_FUNCTIONS
  ) {
    const name = m[1]!;
    if (NOT_FUNCTIONS.has(name)) continue;
    const open = m.index + m[0].length - 1;
    const close = skipBalanced(src, open, Math.min(src.length, open + MAX_ARG_CHARS));
    scanned += close - open;
    const after = src.slice(close, close + 200);
    // `name(params) [: Type] {` — function declaration or method.
    const decl = after.match(/^\s*(?::\s*[^{};=()]*)?\{/);
    if (decl) {
      const bodyStart = close + decl[0].length - 1;
      const bodyEnd = skipBalanced(
        src,
        bodyStart,
        Math.min(src.length, bodyStart + MAX_SOURCE_CHARS),
      );
      out.push({
        name,
        params: paramNames(src.slice(open + 1, close - 1)),
        nameIndex: m.index,
        bodyStart,
        bodyEnd,
      });
    }
  }
  // `name = [async] (params) [: T] => body` (variables and class properties)
  const arrowRe = /\b([A-Za-z_$][\w$]*)\s*(?::[^=;{}()]{0,200})?=\s*(?:async\s*)?\(/g;
  scanned = 0;
  while (
    scanned < MAX_FUNCTION_SCAN_CHARS &&
    (m = arrowRe.exec(src)) !== null &&
    out.length < MAX_FUNCTIONS
  ) {
    const open = m.index + m[0].length - 1;
    const close = skipBalanced(src, open, Math.min(src.length, open + MAX_ARG_CHARS));
    scanned += close - open;
    const arrow = src.slice(close, close + 200).match(/^\s*(?::\s*[^=;{}()]*)?=>\s*/);
    if (!arrow) continue;
    const bodyStart = close + arrow[0].length;
    let bodyEnd: number;
    if (src[bodyStart] === '{') {
      bodyEnd = skipBalanced(src, bodyStart, Math.min(src.length, bodyStart + MAX_SOURCE_CHARS));
    } else {
      bodyEnd = bodyStart;
      const limit = Math.min(src.length, bodyStart + 2_000);
      while (bodyEnd < limit) {
        const ch = src[bodyEnd]!;
        if (ch === "'" || ch === '"' || ch === '`') bodyEnd = skipString(src, bodyEnd, limit);
        else if (ch === '(' || ch === '[' || ch === '{')
          bodyEnd = skipBalanced(src, bodyEnd, limit);
        else if (ch === ';' || ch === '\n' || ch === ',' || ch === ')') break;
        else bodyEnd += 1;
      }
    }
    out.push({
      name: m[1]!,
      params: paramNames(src.slice(open + 1, close - 1)),
      nameIndex: m.index,
      bodyStart,
      bodyEnd,
    });
  }
  return out;
}

/** Innermost function whose body contains `index` (expression bodies start AT the call). */
function innermost(functions: FunctionScope[], index: number): FunctionScope | undefined {
  let best: FunctionScope | undefined;
  for (const f of functions) {
    if (index >= f.bodyStart && index < f.bodyEnd && (!best || f.bodyStart > best.bodyStart))
      best = f;
  }
  return best;
}

/** Context for code inside `fn`: its local constants first, then the file's. */
function scopeCtx(src: string, file: Ctx, fn: FunctionScope | undefined, withParams: boolean): Ctx {
  if (!fn) return file;
  const consts = new Map(file.consts);
  for (const [k, v] of collectConstants(src.slice(fn.bodyStart, fn.bodyEnd))) consts.set(k, v);
  const params = new Map<string, number>();
  if (withParams) fn.params.forEach((p, i) => p && params.set(p, i));
  return { consts, objects: file.objects, ...(withParams ? { params } : {}) };
}

// ── call sites ───────────────────────────────────────────────────────────────

/**
 * fetch (also an injected fetch: `this.fetchImpl`, `this.fetch`, `globalThis.fetch`),
 * axios, axios.<method>, axios.request, http(Client).<method>.
 */
const CALL_RE =
  /(?:\b(?:(this|window|globalThis|self)\s*\.\s*)?(fetch|fetchImpl|fetchFn|fetcher|httpFetch|doFetch)|\b(axios)(?:\s*\.\s*(get|post|put|patch|delete|head|options|request))?|\b(?:this\s*\.\s*)?(?:http|httpClient)\s*\.\s*(get|post|put|patch|delete|head|options))\s*(?:<[^<>()]*>)?\s*\(/g;

function objectProp(objectLiteral: string, prop: string): string | undefined {
  const o = stripWrapping(objectLiteral);
  if (!o.startsWith('{') || !o.endsWith('}')) return undefined;
  for (const entry of splitTopLevel(o.slice(1, -1), ',')) {
    const kv = entry.match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/);
    if (kv && kv[1] === prop) return kv[2]!.trim();
    if (entry.trim() === prop) return prop; // shorthand `{ url }`
  }
  return undefined;
}

function literalMethod(expr: string | undefined): HttpMethodName | undefined {
  const m = expr?.trim().match(/^(['"`])([A-Za-z]+)\1$/);
  return m ? normalizeHttpMethod(m[2]) : undefined;
}

const lineAt = (src: string, index: number) => src.slice(0, index).split('\n').length;

interface Wrapper {
  fn: FunctionScope;
  url: WrapperUrl;
  method?: HttpMethodName;
  /** Method taken from a wrapper parameter, e.g. request(method, path). */
  methodIndex?: number;
  baseRef?: string;
  callee: string;
}

const MAX_WRAPPERS = 20;
const MAX_WRAPPER_CALLS = 50;

function makeCall(
  method: HttpMethodName | undefined,
  path: string,
  baseRef: string | undefined,
  external: boolean,
  line: number,
  summary: string,
): HttpCall {
  const segments = path.split('/').filter(Boolean).length;
  return {
    ...(method ? { method } : {}),
    path,
    ...(baseRef ? { baseRef } : {}),
    external,
    line,
    confidence: method && (baseRef || segments >= 2) ? 'medium' : 'low',
    summary,
  };
}

export function detectHttpCalls(content: string, _filePath?: string): HttpCall[] {
  if (typeof content !== 'string' || content.length > MAX_SOURCE_CHARS) return [];
  if (!/fetch|axios|http/i.test(content)) return [];
  const file: Ctx = { consts: collectConstants(content), objects: collectObjects(content) };
  const functions = collectFunctions(content);
  const calls: HttpCall[] = [];
  const wrappers: Wrapper[] = [];
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let candidates = 0;
  while (
    calls.length < MAX_CALLS &&
    candidates++ < MAX_CANDIDATES &&
    (m = CALL_RE.exec(content)) !== null
  ) {
    const receiver = m[1];
    const fetchName = m[2];
    const before = content.slice(Math.max(0, m.index - 16), m.index);
    if (fetchName) {
      if (/function\s*$/.test(before)) continue; // `function fetch(`
      if (!receiver && /\.\s*$/.test(before)) continue; // `client.fetch(` — someone else's method
      if (fetchName !== 'fetch' && receiver !== 'this') continue; // only injected `this.fetchImpl`
    }
    const open = m.index + m[0].length - 1;
    const args = readArguments(content, open);
    const callee = m[0].replace(/\s*(?:<[^<>()]*>)?\s*\($/, '').replace(/\s+/g, '');
    const fn = innermost(functions, m.index);
    const ctx = scopeCtx(content, file, fn, true);
    let urlExpr: string | undefined;
    let methodExpr: string | undefined;
    let method: HttpMethodName | undefined;

    if (fetchName) {
      urlExpr = args[0];
      if (!args[1]) method = 'GET';
      else if (stripWrapping(args[1]).startsWith('{')) {
        methodExpr = objectProp(args[1], 'method');
        method = methodExpr ? literalMethod(methodExpr) : 'GET';
      }
    } else if (m[3] && (!m[4] || m[4] === 'request')) {
      if (args[0] && stripWrapping(args[0]).startsWith('{')) {
        urlExpr = objectProp(args[0], 'url');
        methodExpr = objectProp(args[0], 'method');
      } else {
        urlExpr = args[0];
        methodExpr = args[1] ? objectProp(args[1], 'method') : undefined;
      }
      method = methodExpr ? literalMethod(methodExpr) : 'GET';
    } else {
      urlExpr = args[0];
      method = normalizeHttpMethod(m[4] ?? m[5]);
    }
    if (!urlExpr) continue;

    const resolved = resolveExpr(urlExpr, ctx, 0);
    if (resolved.wrapper && fn && wrappers.length < MAX_WRAPPERS) {
      const methodParam = methodExpr?.trim();
      wrappers.push({
        fn,
        url: resolved.wrapper,
        ...(method ? { method } : {}),
        ...(methodParam && ctx.params?.has(methodParam)
          ? { methodIndex: ctx.params.get(methodParam)! }
          : {}),
        ...(resolved.baseRef ? { baseRef: resolved.baseRef } : {}),
        callee,
      });
      continue;
    }
    const path = normalizeHttpPath(resolved.path);
    if (!path) continue;
    calls.push(
      makeCall(
        method,
        path,
        resolved.baseRef,
        resolved.external,
        lineAt(content, m.index),
        `${callee}(${method ?? '?'} ${path})${resolved.baseRef ? ` via ${resolved.baseRef}` : ''}`,
      ),
    );
  }

  // One level of request wrappers in the same file: `getJson(path)` → `this.getJson(MAP.users)`.
  for (const w of wrappers) {
    const name = w.fn.name.replace(/\$/g, '\\$');
    const siteRe = new RegExp(
      `(?:\\bthis\\s*\\.\\s*|(?<![\\w$.]))${name}\\s*(?:<[^<>()]*>)?\\s*\\(`,
      'g',
    );
    let site: RegExpExecArray | null;
    let found = 0;
    while (
      (site = siteRe.exec(content)) !== null &&
      found < MAX_WRAPPER_CALLS &&
      calls.length < MAX_CALLS
    ) {
      const nameAt = site.index + site[0].lastIndexOf(w.fn.name);
      if (nameAt === w.fn.nameIndex) continue; // the declaration itself
      if (site.index > w.fn.bodyStart && site.index < w.fn.bodyEnd) continue; // recursion
      const args = readArguments(content, site.index + site[0].length - 1);
      const argExpr = args[w.url.index];
      if (!argExpr) continue;
      const callerCtx = scopeCtx(content, file, innermost(functions, site.index), false);
      const arg = resolveExpr(argExpr, callerCtx, 0);
      if (!arg.path || arg.baseRef || arg.external) continue; // the argument must be a path
      const path = normalizeHttpPath(`${w.url.prefix}${arg.path}${w.url.suffix}`);
      if (!path) continue;
      const method =
        w.method ?? (w.methodIndex !== undefined ? literalMethod(args[w.methodIndex]) : undefined);
      found += 1;
      calls.push(
        makeCall(
          method,
          path,
          w.baseRef,
          false,
          lineAt(content, site.index),
          `${w.fn.name}(${method ?? '?'} ${path}) → ${w.callee}${w.baseRef ? ` via ${w.baseRef}` : ''}`,
        ),
      );
    }
  }
  return calls;
}
