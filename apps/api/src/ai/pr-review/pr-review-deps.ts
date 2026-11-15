/**
 * Bounded, import-aware dependency resolution for PR review verification.
 *
 * Starting from the calls in a finding's code window, resolves helper implementations across
 * files — including files the PR did not change — and returns them as read-only context.
 *
 * Security properties:
 * - every source read goes through the review's authorized file provider, which is pinned to
 *   the validated PR head SHA and uses the acting workspace's GitHub credentials;
 * - paths come only from import specifiers in fetched source (never from model output), are
 *   normalized, must stay inside the repository, and must pass a source allowlist and
 *   exclusion list before any fetch;
 * - fetched source is size-limited and secret-redacted; a function containing a private key
 *   is never included;
 * - nothing here logs source content or credentials.
 *
 * Bounds: depth ≤ 2 by default; depth 3 only for security / data-integrity findings along a
 * chain whose every call is authorization behavior (its result guards a denial, scopes the
 * tenant, is returned, or the call is a statement that can only throw) — decided from the
 * code, not from function names. ≤ 6 functions per verification, ≤ 16 dependency files per
 * review (review-scoped cache, separate from the batch context budget), cycle detection.
 */
import { redactSensitiveString, escapeRegExp } from '@project-x/shared';

import { type CodeLine, type CodeSection, type FileContentProvider } from './pr-review-context';
import { executionPathRanks } from './pr-review-site';

export const DEP_MAX_DEPTH = 2;
/** Depth allowed only along an authorization chain of a security / data-integrity finding. */
export const DEP_MAX_SECURITY_DEPTH = 3;
export const DEP_MAX_FUNCTIONS = 6;
export const DEP_MAX_FILES_PER_REVIEW = 16;
/** tsconfig.json / package.json reads (alias + scope config, cached per project). */
export const DEP_MAX_CONFIG_READS = 6;
/** Paths that turned out not to exist (extension / index probes, missing files). */
export const DEP_MAX_MISSING_PROBES = 8;
/** Hard cap on GitHub contents requests per review for dependency resolution. */
export const DEP_MAX_REQUESTS_PER_REVIEW =
  DEP_MAX_FILES_PER_REVIEW + DEP_MAX_CONFIG_READS + DEP_MAX_MISSING_PROBES;
export const DEP_MAX_FILE_CHARS = 200_000;
/** Functions longer than this are shown as a PARTIAL guard slice. */
export const DEP_MAX_FUNCTION_LINES = 60;
/** Same-file constants a function reads (e.g. a role → permission table), at most this many lines. */
export const DEP_MAX_CONSTANT_LINES = 50;

/** A line that denies access: throw / reject / 401-403-404 / return null|false. */
/**
 * Bare words such as `Forbidden` or `ACCESS_DENIED` do not deny: a log line or a metric name
 * may contain them. A denial throws, rejects, constructs a 401/403/404 error (e.g. passed to
 * `next(...)`), answers with such a status, or returns null/false/undefined.
 */
export const DENY_RE =
  /\bthrow\b|\breject\s*\(|\bnew\s+[\w$.]*(?:Forbidden|Unauthori[sz]ed|NotFound|AccessDenied)[\w$]*\s*\(|\breturn\s+(?:null|false|undefined)\b|status\(\s*40[134]\s*\)/;
/** A query scoped to the acting tenant/owner: rows of others are never returned or changed. */
export const SCOPE_RE =
  /\bwhere\s*:\s*\{[^}]*\b(?:workspaceId|tenantId|orgId|organizationId|ownerId|accountId|userId)\b/;

/**
 * What a call's result does in its caller — the behavior that makes it part of an
 * authorization path (or not):
 * - guard: the call, or a variable assigned from it, is in a condition whose branch denies;
 * - scope: its result becomes the tenant / workspace scope of later code;
 * - return: the caller returns its result (the decision propagates);
 * - effect: a bare statement — its only observable outcome is throwing (assert-style);
 * - other: none of the above (logging, formatting, data fetching).
 */
export type EdgeKind = 'guard' | 'scope' | 'return' | 'effect' | 'other';
const AUTH_EDGES: ReadonlySet<EdgeKind> = new Set(['guard', 'scope', 'return', 'effect']);

export type UnresolvedReason =
  | 'outside_repository'
  | 'external_package'
  | 'unsafe_path'
  | 'unsafe_content'
  | 'not_found_or_inaccessible'
  | 'definition_not_found'
  | 'depth_limit'
  | 'function_limit'
  | 'file_budget'
  | 'context_budget'
  | 'cancelled';

export type CallSite = { path: string; line: number; indent: number; text: string };

export type ResolvedDependency = {
  /** e.g. `GithubAccessService.resolveApiToken` or `resolveWorkspaceIdForUser`. */
  name: string;
  path: string;
  start: number;
  end: number;
  depth: number;
  /** Names from the finding's call (depth 1) down to this function. */
  chain: string[];
  /** Where the depth-1 ancestor of this chain is called from the finding's window. */
  rootCallSite: CallSite;
  /** Where this function is called from its caller (the previous link of `chain`). */
  callSite: CallSite;
  /** What the caller does with this call's result. */
  edge: EdgeKind;
  /** Every link from the finding's call down to this one is authorization behavior. */
  authPath: boolean;
  /**
   * Execution-path relevance of the chain's root call to the finding (0 failure statement,
   * 1 earlier/enclosing on its path or named by the claim, 2 same function, 3 elsewhere).
   */
  pathRank: number;
  /** True when lines were omitted (guard slice): control flow is not fully shown. */
  partial: boolean;
  section: CodeSection;
};

export type UnresolvedDependency = {
  name: string;
  reason: UnresolvedReason;
  /** path:line of the call that could not be followed. */
  calledFrom: string;
  depth: number;
  securityRelevant: boolean;
  /** What the caller does with this call's result. */
  edge: EdgeKind;
  /** Execution-path relevance of the chain's root (see ResolvedDependency.pathRank). */
  pathRank: number;
  /** Depth-1 call site in the finding's window this dependency hangs off. */
  rootCallSite: CallSite;
  /** Chain of resolved functions leading to this call (empty for depth 1). */
  chain: string[];
};

export type DependencyResult = {
  sections: CodeSection[];
  resolved: ResolvedDependency[];
  unresolved: UnresolvedDependency[];
  /**
   * Full text of the files the resolved functions live in (PR head). Used only for local
   * structural checks of the verdict; never sent to the model or logged.
   */
  texts?: Map<string, string>;
};

// ── path safety ───────────────────────────────────────────────────────────

const SOURCE_EXT_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const EXCLUDED_PATH_RE =
  /(?:^|\/)(?:\.env[^/]*|node_modules|dist|build|coverage|\.git|vendor)(?:\/|$)|\.(?:pem|key|p12|pfx|crt|cer|der|jks|keystore)$|(?:^|\/)[^/]*(?:secret|credential|passwd|password|private[-_]?key)[^/]*$/i;

/** Normalize a repository-relative path; null if it escapes the repo or is malformed. */
export function normalizeRepoPath(path: string): string | null {
  if (!path || path.length > 500 || path.includes('\0') || path.includes('\\')) return null;
  if (path.startsWith('/') || /^[a-z]+:/i.test(path)) return null;
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null; // would escape the repository root
      out.pop();
      continue;
    }
    if (!/^[\w.@+-]+$/.test(seg)) return null;
    out.push(seg);
  }
  return out.length ? out.join('/') : null;
}

/** Only allowlisted source files outside excluded locations may be fetched as dependencies. */
export function isSafeSourcePath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  return (
    normalized === path &&
    SOURCE_EXT_RE.test(path) &&
    !/\.d\.ts$/.test(path) &&
    !EXCLUDED_PATH_RE.test(path)
  );
}

const CONFIG_FILE_RE = /(?:^|\/)(?:tsconfig|package)\.json$/;

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}

// ── review-scoped cache ───────────────────────────────────────────────────

/**
 * Per-review cache of dependency source reads. Counts every distinct path attempted
 * (including 404s) against the review's dependency file budget.
 */
export class DependencyCache {
  private readonly files = new Map<string, Promise<string | null>>();
  private readonly aliases = new Map<string, Promise<AliasConfig | null>>();
  /** Existing source files fetched — the only reads charged to the source budget (`maxFiles`). */
  sourceFiles = 0;
  /** tsconfig / package.json reads (own cap). */
  configReads = 0;
  /** Reads that found nothing (probes / missing files; own cap). */
  probes = 0;
  /** Provider (GitHub) requests made, of any kind (hard cap). */
  requests = 0;
  /** Reads served from this review's cache (no provider call). */
  hits = 0;
  /** Reads refused: a budget or cap spent, unsafe path, or file too large. */
  refused = 0;
  private inflightSources = 0;

  constructor(
    private readonly provider: FileContentProvider,
    readonly maxFiles: number = DEP_MAX_FILES_PER_REVIEW,
    readonly caps: { config: number; probes: number; requests: number } = {
      config: DEP_MAX_CONFIG_READS,
      probes: DEP_MAX_MISSING_PROBES,
      requests: DEP_MAX_REQUESTS_PER_REVIEW,
    },
  ) {}

  /** Distinct provider requests (kept for callers that report "files fetched"). */
  get attempted(): number {
    return this.requests;
  }

  /** Fetched paths that did not exist (same as `probes`). */
  get missing(): number {
    return this.probes;
  }

  /**
   * Returns text, or a reason the file cannot be used. `speculative` marks a guess among
   * several candidate paths (`x.ts`, `x.tsx`, `x/index.ts`): guesses stop once the probe cap
   * is spent, so a noisy resolution cannot eat the source budget or the network cap.
   */
  async read(
    path: string,
    signal?: AbortSignal,
    opts: { speculative?: boolean } = {},
  ): Promise<{ text: string } | { reason: UnresolvedReason }> {
    if (!isSafeSourcePath(path) && !CONFIG_FILE_RE.test(path)) {
      this.refused += 1;
      return { reason: 'unsafe_path' };
    }
    if (signal?.aborted) return { reason: 'cancelled' };
    let pending = this.files.get(path);
    if (pending) {
      this.hits += 1;
    } else {
      const isConfig = CONFIG_FILE_RE.test(path);
      const refuse = () => {
        this.refused += 1;
        return { reason: 'file_budget' as const };
      };
      if (this.requests >= this.caps.requests) return refuse();
      if (isConfig) {
        if (this.configReads >= this.caps.config) return refuse();
        this.configReads += 1;
      } else {
        if (this.sourceFiles + this.inflightSources >= this.maxFiles) return refuse();
        if (opts.speculative && this.probes >= this.caps.probes) return refuse();
        this.inflightSources += 1;
      }
      this.requests += 1;
      pending = this.provider(path, signal)
        .catch(() => null)
        .then((text) => {
          if (!isConfig) {
            this.inflightSources -= 1;
            if (text == null) this.probes += 1;
            else this.sourceFiles += 1;
          }
          return text;
        });
      this.files.set(path, pending);
    }
    const text = await pending;
    if (signal?.aborted) return { reason: 'cancelled' };
    if (text == null) return { reason: 'not_found_or_inaccessible' };
    if (text.length > DEP_MAX_FILE_CHARS) {
      this.refused += 1;
      return { reason: 'unsafe_content' };
    }
    return { text };
  }

  /** tsconfig `paths` aliases for the project containing `fromPath` (cached per project). */
  aliasConfig(fromPath: string, signal?: AbortSignal): Promise<AliasConfig | null> {
    const segs = fromPath.split('/');
    const projectRoot =
      segs.length > 2 && (segs[0] === 'apps' || segs[0] === 'packages')
        ? join(segs[0], segs[1]!)
        : '';
    let pending = this.aliases.get(projectRoot);
    if (!pending) {
      pending = (async () => {
        const res = await this.read(join(projectRoot, 'tsconfig.json'), signal);
        const config = 'text' in res ? parseAliasConfig(res.text, projectRoot) : null;
        const pkg = await this.read(join(projectRoot, 'package.json'), signal);
        let scope: string | null = null;
        if ('text' in pkg) {
          try {
            const name = (JSON.parse(pkg.text) as { name?: unknown }).name;
            scope = typeof name === 'string' ? (/^(@[\w.-]+)\//.exec(name)?.[1] ?? null) : null;
          } catch {
            scope = null;
          }
        }
        return config ? { ...config, scope } : { projectRoot, baseUrl: '.', paths: [], scope };
      })();
      this.aliases.set(projectRoot, pending);
    }
    return pending;
  }
}

type AliasConfig = {
  projectRoot: string;
  baseUrl: string;
  paths: [string, string[]][];
  /** npm scope of this repository's own packages (from the project package.json), e.g. @project-x. */
  scope: string | null;
};

/** Remove line and block comments outside strings, and trailing commas (tsconfig is JSONC). */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function parseAliasConfig(text: string, projectRoot: string): AliasConfig | null {
  try {
    const json = JSON.parse(stripJsonComments(text)) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    const paths = Object.entries(json.compilerOptions?.paths ?? {}).filter(
      (e): e is [string, string[]] => Array.isArray(e[1]),
    );
    return { projectRoot, baseUrl: json.compilerOptions?.baseUrl ?? '.', paths, scope: null };
  } catch {
    return null;
  }
}

/** Candidate repository files for an import specifier, or a reason it cannot be followed. */
async function resolveSpecifier(
  specifier: string,
  fromPath: string,
  cache: DependencyCache,
  signal?: AbortSignal,
): Promise<{ bases: string[] } | { reason: UnresolvedReason }> {
  if (specifier.startsWith('.')) {
    const base = normalizeRepoPath(join(dirname(fromPath), specifier));
    return base ? { bases: [base] } : { reason: 'outside_repository' };
  }
  const aliases = await cache.aliasConfig(fromPath, signal);
  for (const [pattern, targets] of aliases?.paths ?? []) {
    const prefix = pattern.replace(/\*$/, '');
    if (pattern.endsWith('*') ? specifier.startsWith(prefix) : specifier === pattern) {
      const rest = pattern.endsWith('*') ? specifier.slice(prefix.length) : '';
      const bases = targets
        .map((t) =>
          normalizeRepoPath(join(aliases!.projectRoot, aliases!.baseUrl, t.replace(/\*$/, rest))),
        )
        .filter((b): b is string => Boolean(b));
      return bases.length ? { bases } : { reason: 'outside_repository' };
    }
  }
  // This repository's own workspace package (@scope/name[/sub]) → packages/name/src[/sub].
  // Other scopes (@nestjs/…, @prisma/…) are external and never mapped into the repo.
  const ws = /^(@[\w.-]+)\/([\w.-]+)(?:\/(.+))?$/.exec(specifier);
  if (ws && aliases?.scope && ws[1] === aliases.scope) {
    const base = normalizeRepoPath(join('packages', ws[2]!, 'src', ws[3] ?? 'index'));
    return base ? { bases: [base] } : { reason: 'outside_repository' };
  }
  return { reason: 'external_package' };
}

async function readModule(
  base: string,
  cache: DependencyCache,
  signal?: AbortSignal,
): Promise<{ path: string; text: string } | { reason: UnresolvedReason }> {
  const candidates = SOURCE_EXT_RE.test(base)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  let last: UnresolvedReason = 'not_found_or_inaccessible';
  for (const path of candidates) {
    const res = await cache.read(path, signal, { speculative: candidates.length > 1 });
    if ('text' in res) return { path, text: res.text };
    last = res.reason;
    if (res.reason === 'file_budget' || res.reason === 'cancelled' || res.reason === 'unsafe_path')
      break;
  }
  return { reason: last };
}

// ── source analysis ───────────────────────────────────────────────────────

const SECURITY_NAME_RE =
  /authori[sz]|assert|require|ensure|check|verify|guard|permission|access|allow|deny|forbid|member|role|owner|admin|tenant|workspace|token|credential|secret|session|auth|install/i;

/** Names whose result decides whether access is allowed (narrower than SECURITY_NAME_RE). */
export const DECISION_NAME_RE =
  /authori[sz]|assert|permission|allow|deny|forbid|check|verify|guard|role|^can[A-Z]|^has[A-Z]|^is(?:Allowed|Member|Owner|Admin|Authorized|Permitted)/i;

export function isSecurityRelevantName(name: string): boolean {
  return SECURITY_NAME_RE.test(name);
}

const NOT_CALLS = new Set([
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
  'super',
  'async',
  'constructor',
  'import',
  'require',
  'Promise',
  'Array',
  'Object',
  'String',
  'Number',
  'Boolean',
  'JSON',
  'Math',
  'Date',
  'Error',
  'Set',
  'Map',
  'Symbol',
  'BigInt',
  'RegExp',
  'expect',
  'describe',
  'it',
  'test',
  'vi',
  'console',
  'setTimeout',
  'clearTimeout',
  'encodeURIComponent',
  'decodeURIComponent',
  'parseInt',
  'parseFloat',
  'isNaN',
  'fetch',
  'structuredClone',
]);

const DECLARATION_PREFIX_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|static|readonly|override|async|get|set|declare|abstract)\s+)*(?:function\s*\*?\s*)?$/;

type Call =
  | { kind: 'self'; name: string; site: CallSite }
  | { kind: 'field'; field: string; name: string; site: CallSite }
  | { kind: 'fn'; name: string; site: CallSite };

function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

/** Code without line comments and with string contents blanked. */
function stripCode(text: string): string {
  return text.replace(/\/\/.*$/, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
}

function escapeRe(name: string): string {
  return escapeRegExp(name);
}

type NumberedLine = { n: number | null; text: string };

/**
 * If line `idx` is inside an `if (...)` condition, the condition's line range and whether the
 * branch it guards denies access (throw / reject / 40x / return null|false).
 */
export function conditionAt(
  lines: NumberedLine[],
  idx: number,
): { start: number; end: number; denies: boolean; lines: NumberedLine[] } | null {
  let start = -1;
  for (let i = idx; i >= Math.max(0, idx - 3); i -= 1) {
    const code = stripCode(lines[i]!.text);
    if (/\bif\s*\(/.test(code)) {
      start = i;
      break;
    }
    if (i < idx && /[{};]\s*$/.test(code.trimEnd())) return null;
  }
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  let endCol = 0;
  let rest = '';
  for (let i = start; i < Math.min(lines.length, start + 8) && end < 0; i += 1) {
    const code = stripCode(lines[i]!.text);
    const from = i === start ? code.search(/\bif\s*\(/) : 0;
    for (let c = from; c < code.length; c += 1) {
      if (code[c] === '(') depth += 1;
      else if (code[c] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          endCol = c + 1;
          rest = code.slice(c + 1);
          break;
        }
      }
    }
  }
  if (end < idx) return null; // the call is in the branch body, not the condition
  const ifIndent = indentOf(lines[start]!.text);
  let denies = DENY_RE.test(rest.replace(/^\s*\{/, ''));
  for (let i = end + 1; !denies && i < Math.min(lines.length, end + 9); i += 1) {
    const text = lines[i]!.text;
    if (text.trim() === '') continue;
    if (indentOf(text) <= ifIndent) break;
    if (DENY_RE.test(stripCode(text))) denies = true;
  }
  const condLines = lines.slice(start, end + 1).map((l, i, arr) => {
    const code = stripCode(l.text);
    return { n: l.n, text: i === arr.length - 1 ? code.slice(0, endCol) : code };
  });
  return { start, end, denies, lines: condLines };
}

/**
 * Everything that decides whether line `idx` runs: the condition of the `if` guarding it, the
 * conditions of every enclosing `if`, and the assignments of the variables those conditions
 * read (one step: `const m = await find(…); if (!m) throw …` → `find(…)` decides the denial).
 */
export function decidingLines(lines: NumberedLine[], idx: number): NumberedLine[] {
  const out: NumberedLine[] = [];
  let indent = indentOf(lines[idx]!.text) + 1;
  // An `else` branch is decided by the `if` it belongs to (same indent, above it).
  let elseIndent: number | null = null;
  for (let i = idx; i >= 0; i -= 1) {
    const text = lines[i]!.text;
    if (text.trim() === '') continue;
    const here = indentOf(text);
    const code = stripCode(text);
    if (elseIndent != null && here === elseIndent && /\bif\s*\(/.test(code)) {
      const c = conditionAt(lines, i);
      if (c) out.push(...c.lines);
      if (!/^\s*\}?\s*else\b/.test(code)) elseIndent = null;
      continue;
    }
    if (i !== idx && here >= indent) continue;
    if (/\bif\s*\(/.test(code)) {
      const c = conditionAt(lines, i);
      if (c) out.push(...c.lines);
    }
    if (/^\s*\}?\s*else\b/.test(code)) elseIndent = here;
    if (i !== idx) indent = here;
    if (here === 0) break;
  }
  const assigned: NumberedLine[] = [];
  const idents = new Set(
    out.flatMap((l) =>
      [...l.text.matchAll(/(?<![.\w$])([a-z_$][\w$]*)\b(?!\s*\()/g)].map((m) => m[1]!),
    ),
  );
  for (const name of idents) {
    const def = new RegExp(
      String.raw`^\s*(?:(?:const|let|var)\s+)?(?:\{[^}]*\b${escapeRe(name)}\b[^}]*\}|${escapeRe(name)})\s*(?::[^=]+)?=(?![=>])`,
    );
    for (let i = idx; i >= 0; i -= 1) {
      if (def.test(stripCode(lines[i]!.text))) {
        assigned.push({ n: lines[i]!.n, text: stripCode(lines[i]!.text) });
        break;
      }
    }
  }
  return [...out, ...assigned];
}

const TENANT_VAR_RE = /(?:workspace|tenant|org|organization|owner|account)(?:Id)?$/i;

/** What the caller does with the result of the call on line `idx` (see {@link EdgeKind}). */
export function edgeKind(lines: NumberedLine[], idx: number, callName: string): EdgeKind {
  const code = stripCode(lines[idx]!.text);
  if (/^\s*return\b/.test(code)) return 'return';
  const cond = conditionAt(lines, idx);
  if (cond?.denies) return 'guard';

  const assign =
    /^\s*(?:(?:const|let|var)\s+)?(\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=(?![=>])/.exec(
      code,
    );
  if (assign) {
    const names = assign[1]!
      .replace(/[{}[\]]/g, '')
      .split(',')
      .map((p) => p.split(':').pop()!.split('=')[0]!.trim())
      .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
    let kind: EdgeKind = 'other';
    for (const name of names) {
      const word = new RegExp(String.raw`\b${escapeRe(name)}\b`);
      for (let j = idx + 1; j < lines.length; j += 1) {
        const later = stripCode(lines[j]!.text);
        if (!word.test(later)) continue;
        const c = conditionAt(lines, j);
        if (c?.denies) return 'guard';
        if (SCOPE_RE.test(later) || /\bwhere\s*:/.test(later)) kind = 'scope';
        else if (/^\s*return\b/.test(later) && kind === 'other') kind = 'return';
      }
      if (TENANT_VAR_RE.test(name)) kind = 'scope';
    }
    return kind;
  }
  const bare = new RegExp(
    String.raw`^\s*(?:await\s+)?(?:this\.)?(?:[\w$]+\.)*${escapeRe(callName)}\s*(?:<[^>]*>)?\(`,
  );
  return bare.test(code) ? 'effect' : 'other';
}

/** Calls on executable lines: `this.m(`, `this.f.m(`, `fn(` (not `obj.m(` on locals). */
const METHOD_SIGNATURE_RE =
  /^(?:readonly\s+)?[A-Za-z_$][\w$]*\??\s*(?:<[^>]*>)?\s*\(.*\)\s*:\s*[^;{}=]+;?$/;

export function extractCalls(path: string, lines: { n: number | null; text: string }[]): Call[] {
  const calls: Call[] = [];
  for (const { n, text } of lines) {
    if (n == null) continue;
    const code = stripCode(text);
    // A method signature in a type / interface (`lock<R>(key: string): Promise<R>;`) declares
    // a member; nothing is called. Reporting it as an unresolved call told verifiers that
    // code was missing when the whole execution path was shown.
    if (METHOD_SIGNATURE_RE.test(code.trim())) continue;
    const site: CallSite = { path, line: n, indent: indentOf(text), text: text.trim() };
    for (const m of code.matchAll(
      /\bthis\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/g,
    )) {
      calls.push({ kind: 'field', field: m[1]!, name: m[2]!, site });
    }
    for (const m of code.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/g)) {
      calls.push({ kind: 'self', name: m[1]!, site });
    }
    for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/g)) {
      const name = m[1]!;
      // A declaration (`async foo(`, `function foo(`, `private foo(`) is not a call.
      const prefix = code.slice(0, m.index);
      if (
        DECLARATION_PREFIX_RE.test(prefix) &&
        (prefix.trim().length > 0 || /\)\s*(?::[^;{]+)?\{\s*$/.test(code.trimEnd()))
      ) {
        continue;
      }
      if (!NOT_CALLS.has(name) && !/^[A-Z][A-Z0-9_]*$/.test(name))
        calls.push({ kind: 'fn', name, site });
    }
  }
  return calls;
}

function importsOf(text: string): Map<string, { specifier: string; imported: string }> {
  const map = new Map<string, { specifier: string; imported: string }>();
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g)) {
    for (const part of m[1]!.split(',')) {
      const [imported, local] = part
        .replace(/\btype\s+/, '')
        .split(/\s+as\s+/)
        .map((s) => s.trim());
      if (imported) map.set(local || imported, { specifier: m[2]!, imported });
    }
  }
  for (const m of text.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g)) {
    map.set(m[1]!, { specifier: m[2]!, imported: 'default' });
  }
  return map;
}

function fieldType(text: string, field: string): string | null {
  const esc = escapeRegExp(field);
  const m = new RegExp(
    String.raw`(?:private|public|protected|readonly)\s+(?:readonly\s+)?${esc}\s*[?!]?\s*:\s*([A-Z][\w$]*)`,
  ).exec(text);
  return m?.[1] ?? null;
}

/**
 * End line of a function whose declaration starts at `startIdx` (0-based): skips the
 * parameter list (which may span lines and contain `{}` object types), then matches the
 * body's braces, ignoring strings and comments. Null if no body end is found within limits.
 */
export function functionEnd(lines: string[], startIdx: number, maxLines = 400): number | null {
  let paren = 0;
  let seenParen = false;
  let brace = 0;
  let inBody = false;
  let quote: string | null = null;
  let blockComment = false;
  for (let li = startIdx; li < Math.min(lines.length, startIdx + maxLines); li += 1) {
    const text = lines[li]!;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i]!;
      if (blockComment) {
        if (c === '*' && text[i + 1] === '/') {
          blockComment = false;
          i += 1;
        }
        continue;
      }
      if (quote) {
        if (c === '\\') i += 1;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '/' && text[i + 1] === '/') break;
      if (c === '/' && text[i + 1] === '*') {
        blockComment = true;
        i += 1;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        continue;
      }
      if (!inBody) {
        if (c === '(') {
          paren += 1;
          seenParen = true;
        } else if (c === ')') paren -= 1;
        else if (c === '{' && seenParen && paren === 0) {
          inBody = true;
          brace = 1;
        }
        continue;
      }
      if (c === '{') brace += 1;
      else if (c === '}') {
        brace -= 1;
        if (brace === 0) return li + 1;
      }
    }
    // Expression-bodied arrow / one-liner without a block body.
    if (!inBody && seenParen && paren === 0 && /;\s*$/.test(text)) return li + 1;
  }
  return null;
}

/** 1-based line range of `name`'s definition (method / function / arrow const), full length. */
/**
 * A bare `name(` line is a method definition only if its parameter list closes into a body
 * (`) {` / `): T {`), not a call continued on the next lines (`  assertCanEdit(\n user,\n);`).
 */
function opensBody(lines: string[], i: number): boolean {
  let acc = '';
  for (let k = i; k < Math.min(lines.length, i + 12); k += 1) {
    acc += ` ${lines[k]!.trim()}`;
    const t = acc.trimEnd();
    if (/\)\s*(?::\s*[^;{}=]+)?\{\s*(?:\}\s*)?$/.test(t)) return true;
    if (/;\s*$/.test(t) || /\)\s*[,)\]]\s*$/.test(t) || /=>\s*/.test(lines[k]!)) return false;
  }
  return false;
}

/** Lines [start, end) of `class Name { … }` in a module, when declared there. */
function classBody(lines: string[], name: string): { from: number; to: number } | null {
  const esc = escapeRegExp(name);
  const decl = new RegExp(
    String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+${esc}\b`,
  );
  const at = lines.findIndex((l) => decl.test(l));
  if (at < 0) return null;
  // Brace depth from the class line (strings and comments are rare in class headers; a miss
  // only widens the search back to the whole module).
  let depth = 0;
  let opened = false;
  for (let k = at; k < lines.length; k += 1) {
    const code = lines[k]!.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '').replace(/\/\/.*$/, '');
    for (const c of code) {
      if (c === '{') {
        depth += 1;
        opened = true;
      } else if (c === '}') {
        depth -= 1;
      }
    }
    if (opened && depth <= 0) return { from: at, to: k + 1 };
  }
  return null;
}

function definitionRange(
  lines: string[],
  name: string,
  /** Class whose method is wanted: search only its body when the class is declared here. */
  owner?: string,
): { start: number; end: number; complete: boolean } | null {
  const esc = escapeRegExp(name);
  const def = new RegExp(
    String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|static|readonly|override|async)\s+)*(?:function\s*\*?\s*)?${esc}\s*(?:<[^>]*>)?\s*\(|^\s*(?:export\s+)?(?:const|let)\s+${esc}\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)`,
  );
  const scope = owner ? classBody(lines, owner) : null;
  const from = scope?.from ?? 0;
  const to = scope?.to ?? lines.length;
  for (let i = from; i < to; i += 1) {
    const t = lines[i]!;
    if (/^\s*(?:this\.|await\b|return\b|\.|\/\/|\*)/.test(t) || /;\s*$/.test(t.trim())) continue;
    const declared = /\bfunction\b/.test(t) || /^\s*(?:export\s+)?(?:const|let)\s/.test(t);
    if (def.test(t) && (declared || opensBody(lines, i))) {
      const end = functionEnd(lines, i);
      return end != null
        ? { start: i + 1, end, complete: true }
        : // Body end not found: show a bounded slice, explicitly marked partial.
          {
            start: i + 1,
            end: Math.min(lines.length, i + DEP_MAX_FUNCTION_LINES),
            complete: false,
          };
    }
  }
  return null;
}

/** Re-export targets for `name` in a barrel module. */
function reexportSpecifiers(text: string, name: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/export\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g)) {
    if (
      m[1]!.split(',').some(
        (p) =>
          p
            .split(/\s+as\s+/)
            .pop()!
            .trim() === name,
      )
    )
      out.push(m[2]!);
  }
  for (const m of text.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)) out.push(m[1]!);
  return out.slice(0, 6);
}

const GUARD_LINE_RE =
  /\b(?:if|else|throw|return|catch|assert\w*|reject|deny|forbid\w*|unauthori[sz]ed|permission|await|for|while|switch|case)\b/i;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** End (1-based) of a `const` statement starting at 0-based `i`, by bracket balance. */
function statementEnd(fileLines: string[], i: number, maxLines = 80): number | null {
  let depth = 0;
  for (let li = i; li < Math.min(fileLines.length, i + maxLines); li += 1) {
    const code = stripCode(fileLines[li]!);
    for (const c of code) {
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') depth -= 1;
    }
    if (depth <= 0 && (/;\s*$/.test(code.trimEnd()) || li > i)) return li + 1;
  }
  return null;
}

/**
 * Same-file constants a function reads (transitively, e.g. ROLE_PERMISSIONS → ALL): a decision
 * like `TABLE[role].includes(permission)` is only inspectable with its table. Constants that
 * are imported or too long are reported as not shown.
 */
function referencedConstants(
  fileLines: string[],
  range: { start: number; end: number },
): { ranges: { name: string; start: number; end: number }[]; notShown: string[] } {
  const ranges: { name: string; start: number; end: number }[] = [];
  const notShown: string[] = [];
  const seen = new Set<string>();
  let budget = DEP_MAX_CONSTANT_LINES;
  const scan = (from: number, to: number) => {
    const names: string[] = [];
    for (let n = from; n <= to; n += 1) {
      for (const m of stripCode(fileLines[n - 1] ?? '').matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
        if (!seen.has(m[1]!)) {
          seen.add(m[1]!);
          names.push(m[1]!);
        }
      }
    }
    return names;
  };
  const queue = scan(range.start, range.end);
  while (queue.length > 0 && ranges.length + notShown.length < 6) {
    const name = queue.shift()!;
    const def = new RegExp(String.raw`^\s*(?:export\s+)?const\s+${escapeRe(name)}\b`);
    const i = fileLines.findIndex((t) => def.test(t));
    if (i < 0) {
      if (importsOf(fileLines.join('\n')).has(name)) notShown.push(name);
      continue;
    }
    if (i + 1 >= range.start && i + 1 <= range.end) continue;
    const end = statementEnd(fileLines, i);
    if (end == null || end - i > budget) {
      notShown.push(name);
      continue;
    }
    budget -= end - i;
    ranges.push({ name, start: i + 1, end });
    queue.push(...scan(i + 1, end));
  }
  return { ranges, notShown };
}

function sectionFor(
  path: string,
  fileLines: string[],
  range: { start: number; end: number; complete: boolean },
  label: string,
  strictConstants: boolean,
): { section: CodeSection; partial: boolean } {
  const all = Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i);
  const sliced = all.length > DEP_MAX_FUNCTION_LINES || !range.complete;
  const keep = sliced
    ? all.filter((n, i) => i < 2 || n === range.end || GUARD_LINE_RE.test(fileLines[n - 1] ?? ''))
    : all;
  const constants = referencedConstants(fileLines, range);
  const constantLines = constants.ranges.flatMap((r) =>
    Array.from({ length: r.end - r.start + 1 }, (_, i) => r.start + i),
  );
  // On an authorization path, a constant the decision reads but that cannot be shown leaves
  // the decision uninspectable: the function counts as partial context.
  const missingConstants = strictConstants ? constants.notShown : [];
  const partial = sliced || missingConstants.length > 0;
  const lines: CodeLine[] = [...new Set([...constantLines, ...keep])]
    .sort((a, b) => a - b)
    .map((n) => ({
      tag: 'HEAD',
      n,
      old: null,
      text: redactSensitiveString(fileLines[n - 1] ?? ''),
    }));
  const withConstants = constants.ranges.length
    ? ` (+ constants ${constants.ranges.map((r) => r.name).join(', ')})`
    : '';
  return {
    partial,
    section: {
      path,
      label: !range.complete
        ? `${label} — PARTIAL (end of function not found; control flow is not fully shown)`
        : sliced
          ? `${label} — PARTIAL guard slice (${keep.length} of ${all.length} lines; omitted lines may change control flow)`
          : missingConstants.length
            ? `${label}${withConstants} — PARTIAL (constants not shown: ${missingConstants.join(', ')}; the decision they feed is not inspectable)`
            : `${label}${withConstants} — complete`,
      lines,
      focus: 0,
    },
  };
}

// ── resolver ──────────────────────────────────────────────────────────────

type QueueItem = {
  call: Call;
  fromPath: string;
  fromText: string;
  depth: number;
  chain: string[];
  rootCallSite: CallSite;
  edge: EdgeKind;
  authPath: boolean;
  /** Best edge rank on the chain below the finding's call (guards / tenant scope win). */
  strength: number;
  pathRank: number;
};

/**
 * Denial behavior first (a guarded branch, or an assert-style statement), then tenant-scope
 * decisions, then returned results (which take their caller's rank), then everything else.
 */
function edgeRank(e: EdgeKind): number {
  return e === 'guard' || e === 'effect' ? 0 : e === 'scope' ? 1 : e === 'return' ? 2 : 3;
}

/**
 * The call builds the error a visible `throw` raises (`throw forbidden(…)`, `throw new
 * HttpError(…)`, or anything on a line starting with `throw`): the throw already establishes
 * the denial; the factory only formats it.
 */
function buildsThrownError(call: Call): boolean {
  if (/^throw\b/.test(call.site.text)) return true;
  const esc = escapeRegExp(call.name);
  return new RegExp(String.raw`\bthrow\s+(?:new\s+)?(?:[\w$]+\.)*${esc}\s*[<(]`).test(
    stripCode(call.site.text),
  );
}

function callLabel(call: Call): string {
  return call.kind === 'field'
    ? `this.${call.field}.${call.name}`
    : call.kind === 'self'
      ? `this.${call.name}`
      : call.name;
}

/**
 * Resolve the helpers called from a finding's window (executable lines only): depth ≤ 2, or
 * ≤ 3 along an authorization chain when `securityFinding` is set. `windowLines` must exclude
 * deleted lines; `originText` is the origin file at PR head.
 */
export async function resolveDependencies(input: {
  originPath: string;
  originText: string | null;
  windowLines: { n: number | null; text: string }[];
  focusLine: number | null;
  cache: DependencyCache;
  maxChars: number;
  signal?: AbortSignal;
  maxFunctions?: number;
  /** Finding category is security / data integrity: authorization chains may go to depth 3. */
  securityFinding?: boolean;
  /** Claim text (title, explanation, trigger, failure path): helpers it names rank higher. */
  claimText?: string;
}): Promise<DependencyResult> {
  const maxFunctions = Math.min(input.maxFunctions ?? DEP_MAX_FUNCTIONS, DEP_MAX_FUNCTIONS);
  const resolved: ResolvedDependency[] = [];
  const unresolved: UnresolvedDependency[] = [];
  const sections: CodeSection[] = [];
  const texts = new Map<string, string>();
  let left = input.maxChars;
  const visited = new Set<string>();
  const unresolvedKeys = new Set<string>();

  const markUnresolved = (item: QueueItem, reason: UnresolvedReason) => {
    const key = `${item.fromPath}:${item.call.site.line}:${callLabel(item.call)}:${reason}`;
    if (unresolvedKeys.has(key)) return;
    unresolvedKeys.add(key);
    unresolved.push({
      name: callLabel(item.call),
      reason,
      calledFrom: `${item.call.site.path}:${item.call.site.line}`,
      depth: item.depth,
      securityRelevant: SECURITY_NAME_RE.test(item.call.name) || item.edge === 'guard',
      edge: item.edge,
      pathRank: item.pathRank,
      rootCallSite: item.rootCallSite,
      chain: item.chain,
    });
  };

  if (input.originText == null) {
    // The finding's own file could not be read: no guard around it can be inspected.
    const line = Math.max(0, (input.focusLine ?? 1) - 1);
    unresolved.push({
      name: input.originPath,
      reason: 'not_found_or_inaccessible',
      calledFrom: `${input.originPath}:${line}`,
      depth: 1,
      securityRelevant: true,
      edge: 'guard',
      pathRank: 0,
      rootCallSite: { path: input.originPath, line, indent: 0, text: '' },
      chain: [],
    } as UnresolvedDependency);
    return { sections, resolved, unresolved, texts };
  }

  // Depth-1 calls, most relevant first: security-sounding names, then nearest to the finding.
  const focus = input.focusLine ?? 0;
  const seenCall = new Set<string>();
  const ranks =
    input.focusLine != null
      ? executionPathRanks(input.originPath, input.originText, input.focusLine)
      : null;
  // Calls the claim names (e.g. the helper it says misbehaves) are directly relevant.
  const named = new Set(
    (input.claimText ?? '')
      .match(/[A-Za-z_$][\w$]{3,}/g)
      ?.filter((w) => /[a-z][A-Z]|^[a-z]+$/.test(w)) ?? [],
  );
  const pathRankOf = (c: Call) => {
    const r = ranks ? ranks.rankOf(c.site.line) : 3;
    return named.has(c.name) ? Math.min(r, 1) : r;
  };
  const first = extractCalls(input.originPath, input.windowLines)
    // A visible `throw factory(…)` already establishes the denial: the factory that formats
    // the exception decides nothing.
    .filter((c) => !buildsThrownError(c))
    .filter((c) => {
      const key = `${callLabel(c)}@${c.site.line}`;
      if (seenCall.has(key)) return false;
      seenCall.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        Number(SECURITY_NAME_RE.test(b.name)) - Number(SECURITY_NAME_RE.test(a.name)) ||
        Math.abs(a.site.line - focus) - Math.abs(b.site.line - focus),
    );
  // Authorization chains first (decided by behavior: guards, tenant scope, returned decisions,
  // assert-style statements), then the subject call's chain, then guards / denial branches
  // before other helpers; names only break ties; shallower first, nearer first.
  // Execution path first (the failure statement, then what runs before it on its path, then
  // the rest of its function, then other code in the window); then authorization chains of
  // security findings; then breadth-first by depth; then behavior; names only break ties.
  const rank = (q: QueueItem) => [
    q.pathRank,
    q.authPath ? 0 : 1,
    q.depth,
    q.strength,
    DECISION_NAME_RE.test(q.call.name) ? 0 : 1,
    SECURITY_NAME_RE.test(q.call.name) ? 0 : 1,
    Math.abs(q.rootCallSite.line - focus),
  ];
  const byPriority = (a: QueueItem, b: QueueItem) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
    return 0;
  };
  const windowIdx = new Map(input.windowLines.map((l, i) => [l.n, i]));
  const queue: QueueItem[] = first
    .map((call) => {
      const idx = windowIdx.get(call.site.line);
      const edge = idx == null ? 'other' : edgeKind(input.windowLines, idx, call.name);
      // The chain is on the vulnerable path when it starts at the finding's own call, or at
      // an authorization call that runs before it.
      const onPath =
        input.focusLine != null &&
        (call.site.line === input.focusLine ||
          (AUTH_EDGES.has(edge) && call.site.line < input.focusLine));
      return {
        call,
        fromPath: input.originPath,
        fromText: input.originText!,
        depth: 1,
        chain: [] as string[],
        rootCallSite: call.site,
        edge,
        authPath: Boolean(input.securityFinding) && onPath,
        strength: edgeRank(edge),
        pathRank: pathRankOf(call),
      };
    })
    .sort(byPriority);

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (input.signal?.aborted) {
      markUnresolved(item, 'cancelled');
      continue;
    }
    if (resolved.length >= maxFunctions) {
      if (SECURITY_NAME_RE.test(item.call.name) || item.authPath || item.edge === 'guard')
        markUnresolved(item, 'function_limit');
      continue;
    }

    const target = await locate(item, input.cache, input.signal);
    if ('reason' in target) {
      // Report every unresolved method/field call (that is where guards live) and every
      // security-relevant plain function. Other unresolved plain functions are local or
      // library helpers (e.g. framework calls) and would only add noise.
      const relevant =
        item.edge === 'guard' ||
        (item.authPath && item.edge !== 'other') ||
        SECURITY_NAME_RE.test(item.call.name) ||
        (item.call.kind === 'field' && SECURITY_NAME_RE.test(item.call.field)) ||
        (item.call.kind === 'self' && target.reason !== 'definition_not_found') ||
        // A project module that exists in imports but cannot be read (missing helper
        // implementation): its behaviour is unknown, which must stay visible.
        target.reason === 'not_found_or_inaccessible';
      if (relevant) markUnresolved(item, target.reason);
      continue;
    }
    const key = `${target.path}#${target.qualified}`;
    if (visited.has(key)) continue; // cycle or already shown
    visited.add(key);

    const fileLines = target.text.split('\n');
    const body = fileLines.slice(target.range.start - 1, target.range.end).join('\n');
    if (PRIVATE_KEY_RE.test(body)) {
      markUnresolved(item, 'unsafe_content');
      continue;
    }
    const chain = [...item.chain, target.qualified];
    const { section, partial } = sectionFor(
      target.path,
      fileLines,
      target.range,
      `dependency ${chain.join(' → ')}()`,
      item.authPath,
    );
    const size = section.lines.reduce(
      (n, l) => n + l.text.length + 16,
      section.label.length + target.path.length + 8,
    );
    if (size > left) {
      markUnresolved(item, 'context_budget');
      continue;
    }
    left -= size;
    sections.push(section);
    texts.set(target.path, target.text);
    resolved.push({
      name: target.qualified,
      path: target.path,
      start: target.range.start,
      end: target.range.end,
      depth: item.depth,
      chain,
      rootCallSite: item.rootCallSite,
      callSite: item.call.site,
      edge: item.edge,
      authPath: item.authPath,
      pathRank: item.pathRank,
      partial,
      section,
    });

    const bodyLines = fileLines
      .slice(target.range.start, target.range.end)
      .map((text, i) => ({ n: target.range.start + 1 + i, text }));
    // Calls that build the thrown error (`throw forbidden(…)`) do not decide anything.
    const callees = extractCalls(target.path, bodyLines).filter((c) => !buildsThrownError(c));
    for (const call of callees) {
      const edge = edgeKind(bodyLines, call.site.line - target.range.start - 1, call.name);
      const next: QueueItem = {
        call,
        fromPath: target.path,
        fromText: target.text,
        depth: item.depth + 1,
        chain,
        rootCallSite: item.rootCallSite,
        edge,
        authPath: item.authPath && AUTH_EDGES.has(edge),
        pathRank: item.pathRank,
        // A returned result is its caller's decision: it ranks like the caller's own link.
        strength: edge === 'return' && item.depth > 1 ? item.strength : edgeRank(edge),
      };
      const maxDepth = next.authPath ? DEP_MAX_SECURITY_DEPTH : DEP_MAX_DEPTH;
      if (next.depth > maxDepth) {
        if (SECURITY_NAME_RE.test(call.name) || next.authPath || edge === 'guard')
          markUnresolved(next, 'depth_limit');
        continue;
      }
      queue.push(next);
    }
    queue.sort(byPriority);
  }
  return { sections, resolved, unresolved, texts };
}

const BARREL_LEVELS = 2;

async function locate(
  item: QueueItem,
  cache: DependencyCache,
  signal?: AbortSignal,
): Promise<
  | {
      path: string;
      text: string;
      range: { start: number; end: number; complete: boolean };
      qualified: string;
    }
  | { reason: UnresolvedReason }
> {
  const { call, fromPath, fromText } = item;
  const inFile = (path: string, text: string, qualifier?: string) => {
    const range = definitionRange(text.split('\n'), call.name, qualifier);
    return range
      ? { path, text, range, qualified: qualifier ? `${qualifier}.${call.name}` : call.name }
      : null;
  };

  if (call.kind === 'self') {
    return inFile(fromPath, fromText) ?? { reason: 'definition_not_found' };
  }

  let typeOrName: string;
  if (call.kind === 'field') {
    const type = fieldType(fromText, call.field);
    if (!type) return { reason: 'definition_not_found' };
    typeOrName = type;
  } else {
    const local = inFile(fromPath, fromText);
    if (local) return local;
    typeOrName = call.name;
  }

  const imp = importsOf(fromText).get(typeOrName);
  if (!imp) {
    // Same-file class (field typed with a class declared here).
    if (call.kind === 'field') {
      return inFile(fromPath, fromText, typeOrName) ?? { reason: 'definition_not_found' };
    }
    return { reason: 'definition_not_found' };
  }
  const spec = await resolveSpecifier(imp.specifier, fromPath, cache, signal);
  if ('reason' in spec) return spec;
  for (const base of spec.bases) {
    const mod = await readModule(base, cache, signal);
    if ('reason' in mod) return mod;
    const qualifier = call.kind === 'field' ? typeOrName : undefined;
    const exported = call.kind === 'field' ? typeOrName : imp.imported;
    const found = await findInModule(mod, exported, qualifier, BARREL_LEVELS);
    if (found) return found;
  }
  return { reason: 'definition_not_found' };

  // Barrel modules (`export { x } from './y'`, `export * from`): followed up to two levels,
  // e.g. packages/shared/src/index.ts → workspace/index.ts → workspace/permissions.ts.
  async function findInModule(
    mod: { path: string; text: string },
    exported: string,
    qualifier: string | undefined,
    levels: number,
  ): Promise<
    | {
        path: string;
        text: string;
        range: { start: number; end: number; complete: boolean };
        qualified: string;
      }
    | { reason: UnresolvedReason }
    | null
  > {
    const direct = inFile(mod.path, mod.text, qualifier);
    if (direct) return direct;
    if (levels === 0) return null;
    for (const re of reexportSpecifiers(mod.text, exported)) {
      const reSpec = await resolveSpecifier(re, mod.path, cache, signal);
      if ('reason' in reSpec) continue;
      for (const reBase of reSpec.bases) {
        const reMod = await readModule(reBase, cache, signal);
        if ('reason' in reMod) {
          if (reMod.reason === 'file_budget' || reMod.reason === 'cancelled') return reMod;
          continue;
        }
        const found = await findInModule(reMod, exported, qualifier, levels - 1);
        if (found) return found;
      }
    }
    return null;
  }
}

/** Prompt section listing every dependency that could not be shown, with its reason. */
export function renderUnresolved(unresolved: UnresolvedDependency[]): string {
  if (unresolved.length === 0) return '';
  const rows = unresolved
    .slice(0, 20)
    .map(
      (u) => `- ${u.name}() called at ${u.calledFrom} — NOT SHOWN: ${u.reason.replace(/_/g, ' ')}`,
    );
  return `## Dependencies not shown (their behavior is unknown)\n${rows.join('\n')}`;
}
