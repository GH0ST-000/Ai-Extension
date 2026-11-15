/**
 * TypeScript-AST analysis of a verifier's failure site, independent of the model:
 *
 * - `classifySiteLine`: is the line an executable statement, or only a closing brace, blank
 *   line, comment, import, or type-only declaration (which cannot fail at runtime)?
 * - `guardsBeforeSite`: every check that runs before the failure site on its own execution
 *   path and could stop it — a conditional exit (throw / return) in a preceding statement of
 *   an enclosing block, or a preceding call (decided against resolved dependencies by the
 *   caller). Guards nested inside unrelated branches, and code after the site, are not on the
 *   path.
 *
 * Works on full file text at the PR head when available; otherwise on the lines that were
 * shown, and then only when every line from the enclosing function's start to the site is
 * present (so execution order can be established).
 */
import { escapeRegExp } from '@project-x/shared';
import ts from 'typescript';

export type SiteKind = 'executable' | 'closing' | 'blank' | 'comment' | 'import' | 'type_only';

const CLOSERS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.SemicolonToken,
  ts.SyntaxKind.CommaToken,
]);

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

// Parsed files are reused across the checks of one verdict (and between verdicts on the same
// file); small and bounded.
const parsed = new Map<string, ts.SourceFile>();
function parse(path: string, text: string): ts.SourceFile {
  const key = `${path}\u0000${text.length}\u0000${text.slice(0, 64)}\u0000${text.slice(-64)}`;
  const hit = parsed.get(key);
  if (hit && hit.text === text) return hit;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  if (parsed.size >= 16) parsed.delete(parsed.keys().next().value!);
  parsed.set(key, sf);
  return sf;
}

function lineRange(sf: ts.SourceFile, line: number): { start: number; end: number } | null {
  const starts = sf.getLineStarts();
  if (line < 1 || line > starts.length) return null;
  const start = starts[line - 1]!;
  const end = line < starts.length ? starts[line]! - 1 : sf.text.length;
  return { start, end };
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** Leaf tokens (no comments) whose start lies in [start, end). */
function tokensIn(sf: ts.SourceFile, start: number, end: number): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (node.end <= start || node.getStart(sf) >= end) return;
    const children = node.getChildren(sf);
    if (children.length === 0) {
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) out.push(node);
      return;
    }
    for (const c of children) visit(c);
  };
  visit(sf);
  return out.filter((t) => t.getStart(sf) >= start && t.getStart(sf) < end);
}

/** A token spanning the line (multi-line string / template): the line is part of it. */
function spansLine(sf: ts.SourceFile, start: number, end: number): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found || node.end <= start || node.getStart(sf) >= end) return;
    const children = node.getChildren(sf);
    if (children.length === 0) {
      if (node.getStart(sf) < start && node.end > start) found = true;
      return;
    }
    for (const c of children) visit(c);
  };
  visit(sf);
  return found;
}

function hasAncestor(node: ts.Node, test: (n: ts.Node) => boolean): boolean {
  for (let n: ts.Node | undefined = node; n; n = n.parent) if (test(n)) return true;
  return false;
}

const isImportLike = (n: ts.Node) =>
  ts.isImportDeclaration(n) ||
  ts.isImportEqualsDeclaration(n) ||
  (ts.isExportDeclaration(n) && n.moduleSpecifier != null && !n.isTypeOnly);

const isTypeLevel = (n: ts.Node) =>
  ts.isTypeNode(n) ||
  ts.isTypeElement(n) ||
  ts.isTypeAliasDeclaration(n) ||
  ts.isInterfaceDeclaration(n) ||
  ts.isTypeParameterDeclaration(n) ||
  (ts.isExportDeclaration(n) && n.isTypeOnly) ||
  (ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword));

/** Classify the failure-site line of `text` (1-based `line`). */
export function classifySiteLine(path: string, text: string, line: number): SiteKind {
  try {
    const sf = parse(path, text);
    const range = lineRange(sf, line);
    if (!range) return 'blank';
    if (sf.text.slice(range.start, range.end).trim() === '') return 'blank';
    const tokens = tokensIn(sf, range.start, range.end);
    if (tokens.length === 0) {
      return spansLine(sf, range.start, range.end) ? 'executable' : 'comment';
    }
    const meaningful = tokens.filter((t) => !CLOSERS.has(t.kind));
    if (meaningful.length === 0) {
      // A line of closers that ends a multi-line token (`});` after a template) is still
      // punctuation only: nothing on it can fail.
      return 'closing';
    }
    if (meaningful.some((t) => hasAncestor(t, isImportLike))) return 'import';
    if (meaningful.every((t) => hasAncestor(t, isTypeLevel))) return 'type_only';
    return 'executable';
  } catch {
    return classifySiteText(text.split('\n')[line - 1] ?? '');
  }
}

/** Text fallback when no parseable source is available. */
export function classifySiteText(raw: string): SiteKind {
  const t = raw.trim();
  if (t === '') return 'blank';
  if (/^[}\]);,\s]+$/.test(t)) return 'closing';
  if (/^(?:\/\/|\/\*|\*)/.test(t)) return 'comment';
  if (/^import\b|^export\s+(?:\*|\{[^}]*\})\s+from\b/.test(t)) return 'import';
  if (/^(?:export\s+)?(?:declare\s+)?(?:type|interface)\s+[A-Za-z_$]|^export\s+type\s*\{/.test(t)) {
    return 'type_only';
  }
  return 'executable';
}

// ── guards on the path to the site ───────────────────────────────────────

export type PathGuard =
  | {
      kind: 'exit';
      /** The `if (…)` line (or the exit itself for an unconditional exit). */
      conditionLine: number;
      /** The throw / return line. */
      exitLine: number;
      lines: [number, number];
    }
  | {
      kind: 'call';
      /** A preceding call; whether it is a guard is decided against its definition. */
      name: string;
      callLine: number;
      lines: [number, number];
    };

export type GuardScan =
  | { status: 'ok'; guards: PathGuard[]; functionStart: number | null }
  | { status: 'order_unknown'; detail: string };

const isFunctionLike = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isConstructorDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n);

const isStatementList = (n: ts.Node) =>
  ts.isBlock(n) ||
  ts.isSourceFile(n) ||
  ts.isModuleBlock(n) ||
  ts.isCaseClause(n) ||
  ts.isDefaultClause(n);

function deepestAt(sf: ts.SourceFile, pos: number): ts.Node {
  let node: ts.Node = sf;
  for (;;) {
    const next = node
      .getChildren(sf)
      .find((c) => c.getStart(sf) <= pos && pos < c.end && c.kind !== ts.SyntaxKind.SyntaxList);
    const viaList = node
      .getChildren(sf)
      .filter((c) => c.kind === ts.SyntaxKind.SyntaxList)
      .flatMap((l) => l.getChildren(sf))
      .find((c) => c.getStart(sf) <= pos && pos < c.end);
    const child = next ?? viaList;
    if (!child) return node;
    node = child;
  }
}

/** A branch that always leaves: `throw` / `return`, directly or as the block's statement. */
function exitsDirectly(stmt: ts.Statement | undefined): ts.Statement | null {
  if (!stmt) return null;
  if (ts.isThrowStatement(stmt) || ts.isReturnStatement(stmt)) return stmt;
  if (ts.isBlock(stmt)) {
    return stmt.statements.find((s) => ts.isThrowStatement(s) || ts.isReturnStatement(s)) ?? null;
  }
  return null;
}

function callsIn(sf: ts.SourceFile, node: ts.Node): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  const visit = (n: ts.Node) => {
    if (isFunctionLike(n)) return; // callbacks defined here do not run here
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      const name = ts.isIdentifier(e)
        ? e.text
        : ts.isPropertyAccessExpression(e)
          ? e.name.text
          : null;
      if (name) out.push({ name, line: lineOf(sf, n.getStart(sf)) });
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** A try statement whose failures reach the caller: no catch, or a catch that rethrows. */
function catchPropagates(stmt: ts.TryStatement): boolean {
  const handler = stmt.catchClause;
  if (!handler) return true;
  let rethrows = false;
  const visit = (n: ts.Node) => {
    if (rethrows || isFunctionLike(n)) return;
    if (ts.isThrowStatement(n)) rethrows = true;
    else ts.forEachChild(n, visit);
  };
  visit(handler.block);
  return rethrows;
}

/** An expression whose failure is discarded: `void f()`, `f().catch(…)`, `f().then(a, b)`. */
function discardsFailure(expr: ts.Expression): boolean {
  let e = expr;
  while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isVoidExpression(e)) return true;
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const name = e.expression.name.text;
    return name === 'catch' || (name === 'then' && e.arguments.length >= 2);
  }
  return false;
}

function guardsOf(sf: ts.SourceFile, stmt: ts.Statement): PathGuard[] {
  const span: [number, number] = [lineOf(sf, stmt.getStart(sf)), lineOf(sf, stmt.end)];
  if (ts.isIfStatement(stmt)) {
    const out: PathGuard[] = [];
    // Each branch of an if / else-if chain that exits directly is a guard; deeper nesting is
    // an unrelated branch.
    for (let s: ts.Statement | undefined = stmt; s && ts.isIfStatement(s);) {
      const cond = lineOf(sf, s.getStart(sf));
      const thenExit = exitsDirectly(s.thenStatement);
      if (thenExit) {
        out.push({
          kind: 'exit',
          conditionLine: cond,
          exitLine: lineOf(sf, thenExit.getStart(sf)),
          lines: span,
        });
      }
      const elseStmt: ts.Statement | undefined = s.elseStatement;
      if (elseStmt && !ts.isIfStatement(elseStmt)) {
        const elseExit = exitsDirectly(elseStmt);
        if (elseExit) {
          out.push({
            kind: 'exit',
            conditionLine: cond,
            exitLine: lineOf(sf, elseExit.getStart(sf)),
            lines: span,
          });
        }
      }
      // Calls in the condition run before the site too (e.g. `if (!(await canAccess()))`).
      for (const c of callsIn(sf, s.expression)) {
        out.push({ kind: 'call', name: c.name, callLine: c.line, lines: span });
      }
      s = elseStmt;
    }
    return out;
  }
  if (ts.isTryStatement(stmt)) {
    // `try { …; return x; } catch { … }` before the site: the site runs only if the try
    // block throws first — a conditional exit like an if-branch.
    const exit = exitsDirectly(stmt.tryBlock);
    const out: PathGuard[] = exit
      ? [
          {
            kind: 'exit',
            conditionLine: span[0],
            exitLine: lineOf(sf, exit.getStart(sf)),
            lines: span,
          },
        ]
      : [];
    // A denial inside the try only stops the site when the catch lets it propagate; a
    // swallowing catch turns every throw in the try block into "carry on".
    if (catchPropagates(stmt)) {
      for (const inner of stmt.tryBlock.statements) out.push(...guardsOf(sf, inner));
    }
    return out;
  }
  if (ts.isThrowStatement(stmt) || ts.isReturnStatement(stmt)) {
    // Unconditional exit before the site: the site is unreachable from here.
    return [{ kind: 'exit', conditionLine: span[0], exitLine: span[0], lines: span }];
  }
  if (ts.isExpressionStatement(stmt) && discardsFailure(stmt.expression)) {
    // `void check()` / `check().catch(() => …)`: a failure of the call cannot stop the site.
    return [];
  }
  if (ts.isExpressionStatement(stmt) || ts.isVariableStatement(stmt)) {
    return callsIn(sf, stmt).map((c) => ({
      kind: 'call' as const,
      name: c.name,
      callLine: c.line,
      lines: span,
    }));
  }
  return [];
}

/**
 * Guards on the path to `siteLine` within its enclosing function (or module), in order.
 * `knownLines` (when the text is reconstructed from shown lines) must cover every line from
 * the function start to the site, or the order cannot be established.
 */
export function guardsBeforeSite(
  path: string,
  text: string,
  siteLine: number,
  knownLines?: ReadonlySet<number>,
): GuardScan {
  const scan = scanGuards(path, text, siteLine, knownLines);
  if (scan.status === 'ok' || !knownLines) return scan;
  // Shown lines of a class method parse as a method only inside a class: retry wrapped,
  // keeping every line number (the wrapper shares line 1 and the last line).
  const lines = text.split('\n');
  lines[0] = `class __Shown { ${lines[0] ?? ''}`;
  lines[lines.length - 1] = `${lines[lines.length - 1] ?? ''} }`;
  const wrapped = scanGuards(path, lines.join('\n'), siteLine, knownLines);
  return wrapped.status === 'ok' ? wrapped : scan;
}

function scanGuards(
  path: string,
  text: string,
  siteLine: number,
  knownLines?: ReadonlySet<number>,
): GuardScan {
  let sf: ts.SourceFile;
  try {
    sf = parse(path, text);
  } catch {
    return { status: 'order_unknown', detail: 'the source could not be parsed' };
  }
  const range = lineRange(sf, siteLine);
  if (!range) return { status: 'order_unknown', detail: 'the failure site is outside the file' };
  const firstChar = sf.text.slice(range.start, range.end).search(/\S/);
  const pos = range.start + Math.max(0, firstChar);
  let node = deepestAt(sf, pos);

  // The statement containing the site.
  while (node.parent && !isStatementList(node.parent)) node = node.parent;
  const guards: PathGuard[] = [];
  let functionStart: number | null = null;
  let current: ts.Node = node;
  for (;;) {
    const list = current.parent;
    if (!list) break;
    if (isStatementList(list)) {
      const statements = (list as ts.Block | ts.SourceFile | ts.CaseClause).statements;
      for (const s of statements) {
        if (s === current) break;
        guards.push(...guardsOf(sf, s));
      }
    }
    if (ts.isSourceFile(list)) break;
    // Climb to the next statement that owns this list (if / for / try / function body …).
    let owner: ts.Node | undefined = list.parent;
    while (owner && !isFunctionLike(owner) && !(owner.parent && isStatementList(owner.parent))) {
      owner = owner.parent;
    }
    if (!owner) break;
    if (isFunctionLike(owner)) {
      functionStart = lineOf(sf, owner.getStart(sf));
      break;
    }
    current = owner;
  }

  if (knownLines) {
    // Module-level code runs from the top of the file; otherwise from the function start.
    const from = functionStart ?? 1;
    for (let n = from; n <= siteLine; n += 1) {
      if (!knownLines.has(n)) {
        return {
          status: 'order_unknown',
          detail: `line ${n} between the ${functionStart != null ? 'function start' : 'top of the file'} and the failure site was not shown`,
        };
      }
    }
  }
  return { status: 'ok', guards, functionStart };
}

/** Text of a line (for matching a verifier's quotes against detected guards). */
export function lineText(text: string, line: number): string {
  return text.split('\n')[line - 1] ?? '';
}

// ── execution-path relevance (dependency priority) ─────────────────────────

export type PathRanks = {
  /** 0 failure statement · 1 earlier / enclosing on its path · 2 same function · 3 elsewhere. */
  rankOf(line: number): number;
  /** Name of the function containing the focus line (for caller lookup), when named. */
  functionName: string | null;
  functionRange: [number, number] | null;
};

const NO_RANKS: PathRanks = { rankOf: () => 3, functionName: null, functionRange: null };

function functionNameOf(fn: ts.FunctionLikeDeclaration): string | null {
  if (fn.name && (ts.isIdentifier(fn.name) || ts.isPrivateIdentifier(fn.name))) {
    return fn.name.text;
  }
  // const name = (…) => { … } / const name = function (…) { … }
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return null;
}

/**
 * Rank lines by how directly they lie on the failure path of `focusLine`: the statement at
 * the focus, statements that run before it in its function (earlier siblings in every
 * enclosing block, plus enclosing conditions), the rest of that function, then everything
 * else (other functions that merely share the context window).
 */
export function executionPathRanks(path: string, text: string, focusLine: number): PathRanks {
  let sf: ts.SourceFile;
  try {
    sf = parse(path, text);
  } catch {
    return NO_RANKS;
  }
  const range = lineRange(sf, focusLine);
  if (!range) return NO_RANKS;
  const firstChar = sf.text.slice(range.start, range.end).search(/\S/);
  let node = deepestAt(sf, range.start + Math.max(0, firstChar));
  while (node.parent && !isStatementList(node.parent)) node = node.parent;
  const span = (n: ts.Node): [number, number] => [lineOf(sf, n.getStart(sf)), lineOf(sf, n.end)];

  const focus = span(node);
  const onPath: [number, number][] = [];
  let fn: ts.FunctionLikeDeclaration | null = null;
  let current: ts.Node = node;
  for (;;) {
    const list = current.parent;
    if (!list) break;
    if (isStatementList(list)) {
      for (const s of (list as ts.Block | ts.SourceFile | ts.CaseClause).statements) {
        if (s === current) break;
        onPath.push(span(s));
      }
    }
    if (ts.isSourceFile(list)) break;
    let owner: ts.Node | undefined = list.parent;
    while (owner && !isFunctionLike(owner) && !(owner.parent && isStatementList(owner.parent))) {
      owner = owner.parent;
    }
    if (!owner) break;
    if (isFunctionLike(owner)) {
      fn = owner;
      break;
    }
    // The owner's own condition / header runs before the focus (if, for, while, switch).
    const header =
      ts.isIfStatement(owner) || ts.isWhileStatement(owner) || ts.isSwitchStatement(owner)
        ? owner.expression
        : ts.isForStatement(owner) || ts.isForOfStatement(owner) || ts.isForInStatement(owner)
          ? owner
          : null;
    if (header) onPath.push([lineOf(sf, header.getStart(sf)), lineOf(sf, header.getStart(sf))]);
    current = owner;
  }
  const fnRange = fn ? span(fn) : null;
  const within = (line: number, [a, b]: [number, number]) => line >= a && line <= b;
  return {
    rankOf(line) {
      if (within(line, focus)) return 0;
      if (onPath.some((r) => within(line, r))) return 1;
      if (fnRange && within(line, fnRange)) return 2;
      return 3;
    },
    functionName: fn ? functionNameOf(fn) : null,
    functionRange: fnRange,
  };
}

// ── guard-as-evidence ───────────────────────────────────────────────────────

export type FocusGuard = {
  /** Lines of the `if (…)` condition. */
  condition: [number, number];
  /** Line ranges of denial statements that are DIRECT children of the guard's branch. */
  denials: [number, number][];
};

const DENY_STATEMENT_RE =
  /^\s*(?:throw\b|return\s+(?:null|false|undefined)\b|return\s+(?:res|response)\.status\(\s*40[134]\s*\))/;

/**
 * The `if` guard whose condition starts on `focusLine` and the denials its branch performs
 * directly (a throw, `return null/false/undefined`, or a 40x response — not ones nested in a
 * further condition, and not code after the guard). Null when the focus is not such a guard.
 */
export function focusGuard(path: string, text: string, focusLine: number): FocusGuard | null {
  let sf: ts.SourceFile;
  try {
    sf = parse(path, text);
  } catch {
    return null;
  }
  let found: ts.IfStatement | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isIfStatement(n) && lineOf(sf, n.getStart(sf)) === focusLine) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!found) return null;
  const guard: ts.IfStatement = found;
  const branch = guard.thenStatement;
  const direct = ts.isBlock(branch) ? [...branch.statements] : [branch];
  const denials = direct
    .filter((s) => DENY_STATEMENT_RE.test(s.getText(sf)))
    .map((s) => [lineOf(sf, s.getStart(sf)), lineOf(sf, s.end)] as [number, number]);
  return {
    condition: [lineOf(sf, guard.expression.getStart(sf)), lineOf(sf, guard.expression.end)],
    denials,
  };
}

// ── requester identity binding of Prisma-style `where` clauses ─────────────

/** Names that denote the authenticated requesting user's id. */
export const IDENTITY_NAME_RE =
  /^(?:userId|actorId|requesterId|requestingUserId|currentUserId|callerId|authUserId|sessionUserId|viewerId|principalId)$/;
const IDENTITY_FIELD_RE = /^(?:id|userId|actorId|uid|sub)$/;
/** Server-populated principals whose id is the requester (`currentUser.id`, `input.userId`). */
const PRINCIPAL_ROOT_RE = /^(?:user|currentUser|actor|session|auth|principal|caller|requester|me)$/;
/** Segments whose `.id` is a user's id (`session.id` is the session's, `auth.id` unknown). */
const USER_SEGMENT_RE = /^(?:user|currentUser|actor|principal|caller|requester|me)$/;
/** Request / framework contexts: trusted only through their principal (`req.user.id`). */
const REQUEST_ROOT_RE = /^(?:req|request|ctx|context|event)$/;
const PRINCIPAL_SEGMENT_RE = /^(?:user|currentUser|principal|session|auth|state|locals)$/;
/** Client-controlled request input: never the authenticated requester (`req.body.userId`). */
const CLIENT_INPUT_RE =
  /^(?:body|query|params|param|headers|cookies|payload|dto|args|form|formData|searchParams|data)$/;

/**
 * `root.….field` is the authenticated requester's id: a principal root (or a request context
 * reached through its principal) and an identity field, with no client-controlled segment.
 */
function isTrustedIdentityPath(segments: string[]): boolean {
  if (segments.length < 2) return false;
  const root = segments[0]!;
  const field = segments[segments.length - 1]!;
  const middle = segments.slice(1, -1);
  if (!IDENTITY_FIELD_RE.test(field)) return false;
  if ([root, ...middle].some((s) => CLIENT_INPUT_RE.test(s))) return false;
  if (field === 'id' && !USER_SEGMENT_RE.test(segments[segments.length - 2]!)) return false;
  if (PRINCIPAL_ROOT_RE.test(root)) return middle.every((s) => PRINCIPAL_SEGMENT_RE.test(s));
  if (REQUEST_ROOT_RE.test(root)) {
    return middle.length > 0 && middle.every((s) => PRINCIPAL_SEGMENT_RE.test(s));
  }
  return false;
}
/** `where` keys that bind a row to a user. */
const USER_KEY_RE =
  /^(?:userId|ownerId|authorId|actorId|createdById|creatorId|requesterId|memberUserId)$/;
const TENANT_KEY_RE = /^(?:workspaceId|tenantId|orgId|organizationId|accountId)$/;

export type UserBinding =
  | { kind: 'direct' }
  | { kind: 'param'; index: number; name: string; identityNamed: boolean }
  | { kind: 'other' };

export type WhereBinding = {
  /** A `where: { … }` object exists in the statement. */
  found: boolean;
  /** A tenant key (workspaceId, tenantId, …) is filtered. */
  tenant: boolean;
  /** How each user key in the where is bound. */
  users: { key: string; binding: UserBinding }[];
  /** Local names that tenant keys are filtered by (`where: { workspaceId }` → workspaceId). */
  tenantValues: string[];
};

/** Framework decorators that fill a parameter from client-controlled request input. */
const CLIENT_DECORATOR_RE =
  /^(?:Body|Query|Param|Params|Headers|Header|Cookies|Cookie|Req|Request)$/;

function clientDecorated(param: ts.ParameterDeclaration): boolean {
  const decorators = ts.canHaveDecorators(param) ? (ts.getDecorators(param) ?? []) : [];
  return decorators.some((d) => {
    const e = d.expression;
    const callee = ts.isCallExpression(e) ? e.expression : e;
    return ts.isIdentifier(callee) && CLIENT_DECORATOR_RE.test(callee.text);
  });
}

/** `name = …` (or `name += …`) anywhere in the function after its declaration. */
function reassigned(fn: ts.Node, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(n.left) &&
      n.left.text === name
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return found;
}

function paramIndexOf(fn: ts.FunctionLikeDeclaration | null, name: string): number {
  if (!fn) return -1;
  return fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === name);
}

function classifyUserValue(
  expr: ts.Expression,
  fn: ts.FunctionLikeDeclaration | null,
  depth = 0,
): UserBinding {
  if (ts.isIdentifier(expr)) {
    const index = paramIndexOf(fn, expr.text);
    if (index >= 0 && clientDecorated(fn!.parameters[index]!)) return { kind: 'other' };
    if (index >= 0) {
      return {
        kind: 'param',
        index,
        name: expr.text,
        identityNamed: IDENTITY_NAME_RE.test(expr.text),
      };
    }
    // One hop through a local alias: `const actor = input.userId; … where: { userId: actor }`.
    if (fn && depth < 2) {
      let init: ts.Expression | undefined;
      const visit = (n: ts.Node) => {
        if (init) return;
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === expr.text &&
          n.initializer
        ) {
          init = n.initializer;
          return;
        }
        ts.forEachChild(n, visit);
      };
      visit(fn);
      // A reassigned alias (`actor = req.body.onBehalfOf`) may hold anything at the query.
      if (init && !reassigned(fn, expr.text)) return classifyUserValue(init, fn, depth + 1);
    }
    return { kind: 'other' };
  }
  if (ts.isPropertyAccessExpression(expr)) {
    // req.user.id, session.userId, input.userId — rooted in a parameter; never through
    // client-controlled input such as req.body.userId or params.userId.
    const segments: string[] = [];
    let cursor: ts.Expression = expr;
    while (ts.isPropertyAccessExpression(cursor)) {
      segments.unshift(cursor.name.text);
      cursor = cursor.expression;
    }
    if (
      ts.isIdentifier(cursor) &&
      paramIndexOf(fn, cursor.text) >= 0 &&
      isTrustedIdentityPath([cursor.text, ...segments])
    ) {
      return { kind: 'direct' };
    }
  }
  return { kind: 'other' };
}

/**
 * The `where` objects of the statement containing `line` and how their user keys are bound:
 * to the requester directly, to a parameter (resolved by the caller at the call site), or to
 * something else (another entity's id such as `note.authorId`). Nested relation filters
 * (`memberships: { where: { … } }`) are included.
 */
export function whereBindingAt(path: string, text: string, line: number): WhereBinding {
  const none: WhereBinding = { found: false, tenant: false, users: [], tenantValues: [] };
  let sf: ts.SourceFile;
  try {
    sf = parse(path, text);
  } catch {
    return none;
  }
  const range = lineRange(sf, line);
  if (!range) return none;
  const firstChar = sf.text.slice(range.start, range.end).search(/\S/);
  let node = deepestAt(sf, range.start + Math.max(0, firstChar));
  while (node.parent && !isStatementList(node.parent)) node = node.parent;
  const statement = node;
  let fn: ts.FunctionLikeDeclaration | null = null;
  for (let n: ts.Node | undefined = statement; n; n = n.parent) {
    if (isFunctionLike(n)) {
      fn = n;
      break;
    }
  }
  const out: WhereBinding = { found: false, tenant: false, users: [], tenantValues: [] };
  // The query whose `where` decides the row: the call with a `{ where }` argument that spans
  // the line (a sibling query in the same statement, e.g. in Promise.all, is another query).
  const queries: { call: ts.CallExpression; where: ts.ObjectLiteralExpression }[] = [];
  const findQueries = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const arg = n.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const where = arg.properties.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) &&
            ts.isIdentifier(p.name) &&
            p.name.text === 'where' &&
            ts.isObjectLiteralExpression(p.initializer),
        );
        if (where)
          queries.push({ call: n, where: where.initializer as ts.ObjectLiteralExpression });
      }
    }
    ts.forEachChild(n, findQueries);
  };
  findQueries(statement);
  const spanning = queries.filter(
    (q) => lineOf(sf, q.call.getStart(sf)) <= line && line <= lineOf(sf, q.call.end),
  );
  const chosen =
    spanning.sort(
      (a, b) => a.call.end - a.call.getStart(sf) - (b.call.end - b.call.getStart(sf)),
    )[0] ?? (queries.length === 1 ? queries[0] : undefined);
  if (!chosen) return out;
  out.found = true;
  // Keys of the filter itself and of relation filters nested in it (`workspace: { members:
  // { some: { userId } } }`). OR / NOT / none / every do not bind every returned row.
  const LOOSE = /^(?:OR|NOT|none|every|AND_NOT)$/;
  const visitFilter = (obj: ts.ObjectLiteralExpression) => {
    for (const p of obj.properties) {
      const key =
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        ts.isIdentifier(p.name)
          ? p.name.text
          : null;
      if (!key || LOOSE.test(key)) continue;
      const value = ts.isShorthandPropertyAssignment(p)
        ? p.name
        : (p as ts.PropertyAssignment).initializer;
      if (TENANT_KEY_RE.test(key)) {
        out.tenant = true;
        if (ts.isIdentifier(value)) out.tenantValues.push(value.text);
      }
      if (USER_KEY_RE.test(key)) {
        out.users.push({ key, binding: classifyUserValue(value, fn) });
      } else if (ts.isObjectLiteralExpression(value)) {
        visitFilter(value);
      }
    }
  };
  visitFilter(chosen.where);
  return out;
}

/** Top-level arguments of the call to `callee` on a line (null when not closed on it). */
export function callArguments(lineText: string, callee: string): string[] | null {
  const esc = escapeRegExp(callee);
  const m = new RegExp(String.raw`(?<![\w$])${esc}\s*(?:<[^>()]*>)?\(`).exec(lineText);
  if (!m) return null;
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;
  for (let i = m.index + m[0].length; i < lineText.length; i += 1) {
    const c = lineText[i]!;
    if (quote) {
      current += c;
      if (c === '\\') {
        current += lineText[i + 1] ?? '';
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      current += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        if (current.trim()) args.push(current.trim());
        return args;
      }
      depth -= 1;
    }
    if (c === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  return null;
}

/** An argument expression that is the requester's identity in the calling code. */
export function isIdentityArgument(arg: string): boolean {
  const t = arg.trim();
  if (IDENTITY_NAME_RE.test(t)) return true;
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(t)) return false;
  return isTrustedIdentityPath(t.split('.'));
}

// ── resource relation between a guard and the vulnerable statement ─────────

function statementAt(sf: ts.SourceFile, line: number): ts.Node | null {
  const range = lineRange(sf, line);
  if (!range) return null;
  const firstChar = sf.text.slice(range.start, range.end).search(/\S/);
  if (firstChar < 0) return null;
  let node = deepestAt(sf, range.start + firstChar);
  while (node.parent && !isStatementList(node.parent)) node = node.parent;
  return node;
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (isFunctionLike(n)) return n;
  }
  return null;
}

/** Value identifiers a node reads (not property names, object keys or called function names). */
function valueNames(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isCallExpression(p) && p.expression === n);
      if (!isPropertyName) out.add(n.text);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** Names plus the names their local `const x = …` initializers read (a few hops). */
function expandNames(fn: ts.Node, names: Set<string>): Set<string> {
  const out = new Set(names);
  for (let hop = 0; hop < 3; hop += 1) {
    let grew = false;
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const bound = ts.isIdentifier(n.name)
          ? [n.name.text]
          : ts.isObjectBindingPattern(n.name)
            ? n.name.elements.map((e) => (ts.isIdentifier(e.name) ? e.name.text : ''))
            : [];
        if (bound.some((b) => b && out.has(b))) {
          for (const v of valueNames(n.initializer)) {
            if (!out.has(v)) {
              out.add(v);
              grew = true;
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(fn);
    if (!grew) break;
  }
  return out;
}

/** Names that never relate two statements: the requester, clients and framework handles. */
const UNRELATING_NAME_RE =
  /^(?:this|db|prisma|tx|client|repo|repository|em|manager|knex|sql|req|request|res|ctx|context|user|currentUser|session|auth|principal|actor|undefined|null|true|false|Promise|Error)$/;

/**
 * Does the authorization decided on `guardLines` concern the resource the statement on
 * `focusLine` acts on? True when both read a common value other than the requester's
 * identity (directly or through local variables): e.g. `membership(where: { workspaceId:
 * note.workspaceId, userId })` and `delete(where: { id: noteId })` with `note` loaded by
 * `noteId`. A membership of one workspace says nothing about a document addressed only by its
 * own id. Null when it cannot be established from the source (parse failure, other files).
 */
export function resourceRelated(
  path: string,
  text: string,
  guardLines: number[],
  focusLine: number,
): boolean | null {
  let sf: ts.SourceFile;
  try {
    sf = parse(path, text);
  } catch {
    return null;
  }
  const focus = statementAt(sf, focusLine);
  if (!focus) return null;
  const fn = enclosingFunction(focus);
  if (!fn) return null;
  const guards = guardLines.map((l) => statementAt(sf, l)).filter((n): n is ts.Node => n != null);
  if (guards.length === 0 || guards.some((g) => enclosingFunction(g) !== fn)) return null;
  const keep = (names: Set<string>) =>
    new Set([...names].filter((n) => !UNRELATING_NAME_RE.test(n) && !IDENTITY_NAME_RE.test(n)));
  const focusNames = keep(expandNames(fn, valueNames(focus)));
  const guardNames = keep(expandNames(fn, new Set(guards.flatMap((g) => [...valueNames(g)]))));
  return [...guardNames].some((n) => focusNames.has(n));
}

// ── concurrency: check-then-act sequences and what serializes them ─────────

export type ConcurrencyProtection =
  'lock' | 'atomic_update' | 'unique_constraint' | 'serializable_transaction' | 'transaction';

export type ConcurrencyFacts = {
  /** A read whose result is tested before a write in the same function. */
  checkThenAct: boolean;
  /** The strongest mechanism covering the write (and the read, for a lock/transaction). */
  protection: ConcurrencyProtection | null;
  /** Lines of the protecting construct (to match against a verifier's quote). */
  protectionLines: number[];
  /** Both writes of a multi-write sequence run in one transaction (atomicity). */
  atomicWrites: boolean;
  transactionLines: number[];
  /** Lines of the read and of the write of the check-then-act (when there is one). */
  readLine: number | null;
  writeLine: number | null;
};

const READ_CALL_RE = /^(?:count|find\w*|get\w*|select\w*|aggregate|exists|fetch\w*|load\w*)$/;
const WRITE_CALL_RE =
  /^(?:create\w*|insert\w*|update\w*|upsert\w*|delete\w*|remove|save|increment|decrement|put)$/;
const LOCK_CALLEE_RE = /lock|mutex|serializ|advisory|critical|exclusive/i;
const TRANSACTION_CALLEE_RE = /^\$?transaction$|^withTransaction$|^runInTransaction$/;
const UNIQUE_ERROR_RE = /P2002|unique|duplicate|23505|ER_DUP_ENTRY|E11000|SQLITE_CONSTRAINT/i;
const STRICT_ISOLATION_RE = /Serializable|SERIALIZABLE/;
const FOR_UPDATE_RE = /\bFOR\s+UPDATE\b|forUpdate\s*\(|pessimistic_write|lockMode/i;
const CONDITION_OPERATOR_RE =
  /^(?:gt|gte|lt|lte|not|notIn|in|equals|\$gt|\$gte|\$lt|\$lte|\$ne|\$in)$/;

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** The function a callback-wrapped body belongs to (`lock(key, async () => { … })`). */
function outerFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  let fn = enclosingFunction(node);
  while (fn && fn.parent && ts.isCallExpression(fn.parent)) {
    const outer = enclosingFunction(fn.parent);
    if (!outer) break;
    fn = outer;
  }
  return fn;
}

/** The call that receives the callback enclosing `node`, innermost first. */
function callbackCalls(node: ts.Node, stop: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  for (let n: ts.Node | undefined = node.parent; n && n !== stop; n = n.parent) {
    if (isFunctionLike(n) && n.parent && ts.isCallExpression(n.parent)) out.push(n.parent);
  }
  return out;
}

function hasConditionalFilter(call: ts.CallExpression): boolean {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  const where = arg.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      /^(?:where|filter)$/.test(p.name.text),
  );
  if (!where || !ts.isObjectLiteralExpression(where.initializer)) return false;
  let conditional = false;
  const visit = (n: ts.Node) => {
    if (conditional) return;
    if (
      ts.isPropertyAssignment(n) &&
      (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
      CONDITION_OPERATOR_RE.test(n.name.text)
    ) {
      conditional = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(where.initializer);
  return conditional;
}

function linesOf(sf: ts.SourceFile, node: ts.Node): number[] {
  const a = lineOf(sf, node.getStart(sf));
  const b = lineOf(sf, node.end);
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/**
 * Concurrency facts for the function containing `focusLine`: is there a read-check-write
 * (check-then-act) sequence, and what — if anything — serializes it? Only constructs in the
 * source count: a lock callback enclosing both the read and the write, a conditional atomic
 * write (`updateMany({ where: { stock: { gt: 0 } } })`), a write whose unique-constraint
 * violation is handled, a SERIALIZABLE transaction or a row lock (`FOR UPDATE`). A default
 * transaction gives atomicity of its writes, not isolation of a read-check-write.
 */
export function concurrencyAt(
  path: string,
  text: string,
  focusLine: number,
): ConcurrencyFacts | null {
  let sf: ts.SourceFile;
  try {
    sf = parse(path, text);
  } catch {
    return null;
  }
  const focus = statementAt(sf, focusLine);
  if (!focus) return null;
  const fn = outerFunction(focus);
  if (!fn) return null;
  const calls: { call: ts.Node; name: string; kind: 'read' | 'write'; pos: number }[] = [];
  const visit = (n: ts.Node) => {
    // Raw SQL reads (`tx.$queryRaw\`SELECT … FOR UPDATE\``) are tagged templates.
    if (ts.isTaggedTemplateExpression(n) && /\bSELECT\b/i.test(n.template.getText(sf))) {
      calls.push({ call: n, name: 'queryRaw', kind: 'read', pos: n.getStart(sf) });
    }
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name && ts.isPropertyAccessExpression(n.expression)) {
        const kind = WRITE_CALL_RE.test(name) ? 'write' : READ_CALL_RE.test(name) ? 'read' : null;
        if (kind) calls.push({ call: n, name, kind, pos: n.getStart(sf) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  const focusPos = focus.getStart(sf);
  const writes = calls.filter((c) => c.kind === 'write');
  const write =
    writes.find((w) => w.pos >= focusPos) ?? [...writes].reverse().find((w) => w.pos < focusPos);
  const facts: ConcurrencyFacts = {
    checkThenAct: false,
    protection: null,
    protectionLines: [],
    atomicWrites: false,
    transactionLines: [],
    readLine: null,
    writeLine: null,
  };
  if (!write) return facts;
  facts.writeLine = lineOf(sf, write.call.getStart(sf));
  const reads = calls.filter((c) => c.kind === 'read' && c.pos < write.pos);
  const read = reads[reads.length - 1];
  // A read whose value is tested (an `if` between the read and the write) or written back.
  if (read) {
    facts.readLine = lineOf(sf, read.call.getStart(sf));
    const between = sf.text.slice(read.call.end, write.pos);
    facts.checkThenAct =
      /\bif\s*\(|\?\s*[^:]+:|\bthrow\b/.test(between) ||
      /\b\w+\.\w+\s*[-+]/.test(write.call.getText(sf));
  }
  const wrappers = callbackCalls(write.call, fn);
  const inside = (outer: ts.Node, node: ts.Node) =>
    node.getStart(sf) >= outer.getStart(sf) && node.end <= outer.end;
  const consider = (p: ConcurrencyProtection, lines: number[]) => {
    const rank: ConcurrencyProtection[] = [
      'transaction',
      'unique_constraint',
      'atomic_update',
      'serializable_transaction',
      'lock',
    ];
    if (!facts.protection || rank.indexOf(p) > rank.indexOf(facts.protection)) {
      facts.protection = p;
      facts.protectionLines = lines;
    }
  };
  for (const w of wrappers) {
    const name = calleeName(w) ?? '';
    const covers = !read || inside(w, read.call);
    if (TRANSACTION_CALLEE_RE.test(name)) {
      const txLines = [lineOf(sf, w.getStart(sf))];
      facts.transactionLines.push(...txLines);
      facts.atomicWrites = writes.filter((x) => inside(w, x.call)).length >= 2;
      const options = w.arguments
        .slice(1)
        .map((a) => a.getText(sf))
        .join(' ');
      const rowLocked = read != null && FOR_UPDATE_RE.test(read.call.getText(sf));
      if (covers && (STRICT_ISOLATION_RE.test(options) || rowLocked)) {
        consider('serializable_transaction', [
          ...txLines,
          ...(rowLocked ? linesOf(sf, read!.call) : []),
        ]);
      } else {
        consider('transaction', txLines);
      }
    } else if (LOCK_CALLEE_RE.test(name) && covers) {
      consider('lock', [lineOf(sf, w.getStart(sf))]);
    }
  }
  if (
    /^update\w*$/.test(write.name) &&
    ts.isCallExpression(write.call) &&
    hasConditionalFilter(write.call)
  ) {
    consider('atomic_update', linesOf(sf, write.call));
  }
  for (let n: ts.Node | undefined = write.call.parent; n && n !== fn; n = n.parent) {
    if (
      ts.isTryStatement(n) &&
      inside(n.tryBlock, write.call) &&
      n.catchClause &&
      UNIQUE_ERROR_RE.test(n.catchClause.getText(sf))
    ) {
      consider('unique_constraint', linesOf(sf, n.catchClause).slice(0, 4));
      break;
    }
  }
  return facts;
}

/** Whether two lines belong to the same (outer) function; null when it cannot be parsed. */
export function sameFunction(path: string, text: string, a: number, b: number): boolean | null {
  let sf: ts.SourceFile;
  try {
    sf = parse(path, text);
  } catch {
    return null;
  }
  const sa = statementAt(sf, a);
  const sb = statementAt(sf, b);
  if (!sa || !sb) return null;
  return outerFunction(sa) === outerFunction(sb);
}

/** First and last line of the statement containing `line` (null when unknown). */
export function statementSpan(path: string, text: string, line: number): [number, number] | null {
  let sf: ts.SourceFile;
  try {
    sf = parse(path, text);
  } catch {
    return null;
  }
  const s = statementAt(sf, line);
  return s ? [lineOf(sf, s.getStart(sf)), lineOf(sf, s.end)] : null;
}

/**
 * Calls whose result is discarded, run up to and including `focusLine` in its function: expression
 * statements such as `await assertMember(db, ws, user);` (not `.catch`/`void`, which already
 * discard failures). A helper that RETURNS its decision and is called like this decides nothing.
 */
export function discardedCallsBefore(
  path: string,
  text: string,
  focusLine: number,
): { name: string; line: number }[] {
  let sf: ts.SourceFile;
  try {
    sf = parse(path, text);
  } catch {
    return [];
  }
  const focus = statementAt(sf, focusLine);
  if (!focus) return [];
  const fn = outerFunction(focus);
  if (!fn) return [];
  const out: { name: string; line: number }[] = [];
  const visit = (n: ts.Node) => {
    if (n !== fn && isFunctionLike(n)) return;
    // The focus statement itself counts: a discarded call can be the claim's own subject.
    if (ts.isExpressionStatement(n) && n.getStart(sf) <= focus.getStart(sf)) {
      let e: ts.Expression = n.expression;
      while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isCallExpression(e) && !discardsFailure(n.expression)) {
        const name = calleeName(e);
        if (name) out.push({ name, line: lineOf(sf, e.getStart(sf)) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return out;
}

/** Name and line span of the outer function containing `line` (null when none). */
export function functionAt(
  path: string,
  text: string,
  line: number,
): { name: string | null; start: number; end: number } | null {
  let sf: ts.SourceFile;
  try {
    sf = parse(path, text);
  } catch {
    return null;
  }
  const stmt = statementAt(sf, line);
  const fn = stmt ? outerFunction(stmt) : null;
  if (!fn) return null;
  return {
    name: functionNameOf(fn),
    start: lineOf(sf, fn.getStart(sf)),
    end: lineOf(sf, fn.end),
  };
}
