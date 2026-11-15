import { describe, expect, it } from 'vitest';

import type { CodeSection } from './pr-review-context';
import { DependencyCache, resolveDependencies } from './pr-review-deps';
import { validatedFinding } from './pr-review-fixtures';
import { classifySiteLine, classifySiteText } from './pr-review-site';
import {
  assessVerdict,
  buildVerificationContent,
  SECURITY_CATEGORIES,
  type AssessedVerdict,
  type VerificationOutput,
} from './pr-review-verify';

/* Exact sources at PR #48 head 69e1fc4 (live review #4 replay). Test data only. */

const RESOLVE_PATH = 'apps/api/src/workspaces/resolve-workspace-id.ts';
const RESOLVE_TEXT = [
  "import type { PrismaService } from '../prisma/prisma.service';",
  'import {',
  '  peekRequestWorkspaceHeaderInvalid,',
  '  peekRequestWorkspaceId,',
  "} from '../observability/request-context.service';",
  "import { workspaceException } from './workspace.errors';",
  '',
  '/**',
  ' * Resolve the acting workspace for legacy user-scoped call sites.',
  ' *',
  ' * - An explicitly requested workspace (the `explicitWorkspaceId` argument, else the',
  ' *   X-Workspace-Id header via ALS) must be one the user is an active member of, in an active',
  ' *   workspace. Otherwise this throws \u2014 it NEVER silently substitutes another workspace, so a',
  ' *   stale or spoofed selection cannot read from or write to the wrong tenant.',
  ' *   - malformed header                         \u2192 400 WORKSPACE_ID_INVALID',
  ' *   - unknown / inactive / not a member / left \u2192 403 WORKSPACE_CONTEXT_UNAVAILABLE',
  ' *     (one response for all cases, so the error is not a workspace-existence oracle)',
  ' * - Only when no workspace was requested at all does the documented fallback apply:',
  ' *   lastWorkspaceId \u2192 oldest owned workspace \u2192 personal workspace id `ws_${userId}`.',
  ' */',
  'export async function resolveWorkspaceIdForUser(',
  '  prisma: PrismaService,',
  '  userId: string,',
  '  explicitWorkspaceId?: string,',
  '): Promise<string> {',
  '  const explicit = explicitWorkspaceId?.trim() || undefined;',
  '  const candidate = explicit ?? peekRequestWorkspaceId();',
  '',
  '  if (!candidate && peekRequestWorkspaceHeaderInvalid()) {',
  "    throw workspaceException('WORKSPACE_ID_INVALID', 'X-Workspace-Id header is malformed.');",
  '  }',
  '',
  '  if (candidate) {',
  '    const membership = await findActiveMembership(prisma, userId, candidate);',
  '    if (!membership) {',
  '      throw workspaceException(',
  "        'WORKSPACE_CONTEXT_UNAVAILABLE',",
  "        'The selected workspace is not available to you. Refresh your workspace selection and try again.',",
  '      );',
  '    }',
  '    return membership.workspaceId;',
  '  }',
  '',
  '  const user = await prisma.user.findUnique({',
  '    where: { id: userId },',
  '    select: { lastWorkspaceId: true },',
  '  });',
  '  if (user?.lastWorkspaceId) {',
  '    const membership = await findActiveMembership(prisma, userId, user.lastWorkspaceId);',
  '    if (membership) {',
  '      return membership.workspaceId;',
  '    }',
  '  }',
  '',
  '  const owned = await prisma.workspaceMembership.findFirst({',
  "    where: { userId, status: 'active', role: 'owner', workspace: { status: 'active' } },",
  '    select: { workspaceId: true },',
  "    orderBy: { createdAt: 'asc' },",
  '  });',
  '  if (owned) {',
  '    return owned.workspaceId;',
  '  }',
  '',
  '  return `ws_${userId}`;',
  '}',
  '',
  'function findActiveMembership(prisma: PrismaService, userId: string, workspaceId: string) {',
  '  return prisma.workspaceMembership.findFirst({',
  '    where: {',
  '      workspaceId,',
  '      userId,',
  "      status: 'active',",
  "      workspace: { status: 'active' },",
  '    },',
  '    select: { workspaceId: true },',
  '  });',
  '}',
].join('\n');

const CONTEXT_PATH = 'apps/api/src/observability/request-context.service.ts';
const CONTEXT_TEXT = [
  "import { Injectable } from '@nestjs/common';",
  "import { AsyncLocalStorage } from 'node:async_hooks';",
  "import type { ObservabilityContext } from '@project-x/types';",
  '',
  'export type RequestContextStore = ObservabilityContext & {',
  '  sampled?: boolean;',
  '  /**',
  '   * True when the request carried a non-empty X-Workspace-Id that failed format validation.',
  '   * `workspaceId` is left unset in that case, so this flag is what stops callers from',
  '   * treating a malformed header as "absent" and falling back to another workspace.',
  '   */',
  '  workspaceHeaderInvalid?: boolean;',
  '};',
  '',
  'const storage = new AsyncLocalStorage<RequestContextStore>();',
  '',
  '/** Read workspace from the active ALS store (set by RequestContextMiddleware from X-Workspace-Id). */',
  'export function peekRequestWorkspaceId(): string | undefined {',
  '  const workspaceId = storage.getStore()?.workspaceId;',
  "  return typeof workspaceId === 'string' && workspaceId.length > 0 ? workspaceId : undefined;",
  '}',
  '',
  '/** True when the active request sent a malformed X-Workspace-Id header. */',
  'export function peekRequestWorkspaceHeaderInvalid(): boolean {',
  '  return storage.getStore()?.workspaceHeaderInvalid === true;',
  '}',
  '',
  '/**',
  ' * AsyncLocalStorage-backed request/trace context.',
  ' * Must not use global mutable state \u2014 concurrent requests stay isolated.',
  ' */',
  '@Injectable()',
  'export class RequestContextService {',
  '  run<T>(context: RequestContextStore, fn: () => T): T {',
  '    return storage.run({ ...context }, fn);',
  '  }',
  '',
  '  get(): RequestContextStore | undefined {',
  '    return storage.getStore();',
  '  }',
  '',
  '  patch(partial: Partial<RequestContextStore>): void {',
  '    const current = storage.getStore();',
  '    if (!current) return;',
  '    Object.assign(current, partial);',
  '  }',
  '',
  '  snapshot(): ObservabilityContext {',
  '    const current = storage.getStore();',
  '    if (!current) return {};',
  '    const {',
  '      requestId,',
  '      traceId,',
  '      spanId,',
  '      workspaceId,',
  '      userIdHash,',
  '      workflowId,',
  '      executionId,',
  '      stepId,',
  '      capability,',
  '      repository,',
  '      pullRequestNumber,',
  '      provider,',
  '      release,',
  '      environment,',
  '      plan,',
  '      service,',
  '      errorCode,',
  '    } = current;',
  '    return {',
  '      ...(requestId ? { requestId } : {}),',
  '      ...(traceId ? { traceId } : {}),',
  '      ...(spanId ? { spanId } : {}),',
  '      ...(workspaceId ? { workspaceId } : {}),',
  '      ...(userIdHash ? { userIdHash } : {}),',
  '      ...(workflowId ? { workflowId } : {}),',
  '      ...(executionId ? { executionId } : {}),',
  '      ...(stepId ? { stepId } : {}),',
  '      ...(capability ? { capability } : {}),',
  '      ...(repository ? { repository } : {}),',
  '      ...(pullRequestNumber != null ? { pullRequestNumber } : {}),',
  '      ...(provider ? { provider } : {}),',
  '      ...(release ? { release } : {}),',
  '      ...(environment ? { environment } : {}),',
  '      ...(plan ? { plan } : {}),',
  '      ...(service ? { service } : {}),',
  '      ...(errorCode ? { errorCode } : {}),',
  '    };',
  '  }',
  '}',
].join('\n');

const ERRORS_PATH = 'apps/api/src/workspaces/workspace.errors.ts';
const ERRORS_TEXT = [
  'import {',
  '  BadRequestException,',
  '  ForbiddenException,',
  '  HttpException,',
  '  HttpStatus,',
  '  NotFoundException,',
  "} from '@nestjs/common';",
  "import type { WorkspaceErrorBody, WorkspaceErrorCode } from '@project-x/types';",
  '',
  'export function workspaceException(',
  '  code: WorkspaceErrorCode,',
  '  message: string,',
  '  details?: Record<string, unknown>,',
  '): HttpException {',
  '  const statusCode = statusForCode(code);',
  '  const body: WorkspaceErrorBody & { statusCode: number } = {',
  '    code,',
  '    message,',
  '    statusCode,',
  '    ...(details ? { details } : {}),',
  '  };',
  '',
  '  switch (code) {',
  "    case 'WORKSPACE_NOT_FOUND':",
  "    case 'WORKSPACE_MEMBER_NOT_FOUND':",
  '      return new NotFoundException(body);',
  "    case 'WORKSPACE_ACCESS_DENIED':",
  "    case 'WORKSPACE_INACTIVE':",
  "    case 'WORKSPACE_CONTEXT_UNAVAILABLE':",
  "    case 'WORKSPACE_OWNER_REQUIRED':",
  "    case 'WORKSPACE_LAST_OWNER':",
  "    case 'WORKSPACE_RESOURCE_ACCESS_DENIED':",
  "    case 'FEATURE_NOT_AVAILABLE':",
  '      return new ForbiddenException(body);',
  "    case 'WORKSPACE_ID_INVALID':",
  "    case 'WORKSPACE_LIMIT_REACHED':",
  "    case 'WORKSPACE_MEMBER_LIMIT_REACHED':",
  "    case 'WORKSPACE_INVITATION_INVALID':",
  "    case 'WORKSPACE_INVITATION_EXPIRED':",
  "    case 'WORKSPACE_INVITATION_ALREADY_USED':",
  "    case 'USAGE_LIMIT_REACHED':",
  "    case 'PLAN_LIMIT_EXCEEDED':",
  "    case 'SUBSCRIPTION_REQUIRED':",
  "    case 'SUBSCRIPTION_INACTIVE':",
  "    case 'BILLING_CONFIGURATION_INVALID':",
  "    case 'BILLING_CHECKOUT_FAILED':",
  "    case 'BILLING_WEBHOOK_INVALID':",
  "    case 'BILLING_WEBHOOK_DUPLICATE':",
  '      return new BadRequestException(body);',
  '    default:',
  '      return new HttpException(body, statusCode);',
  '  }',
  '}',
  '',
  'function statusForCode(code: WorkspaceErrorCode): number {',
  '  switch (code) {',
  "    case 'WORKSPACE_NOT_FOUND':",
  "    case 'WORKSPACE_MEMBER_NOT_FOUND':",
  '      return HttpStatus.NOT_FOUND;',
  "    case 'WORKSPACE_ACCESS_DENIED':",
  "    case 'WORKSPACE_INACTIVE':",
  "    case 'WORKSPACE_CONTEXT_UNAVAILABLE':",
  "    case 'WORKSPACE_OWNER_REQUIRED':",
  "    case 'WORKSPACE_LAST_OWNER':",
  "    case 'WORKSPACE_RESOURCE_ACCESS_DENIED':",
  "    case 'FEATURE_NOT_AVAILABLE':",
  '      return HttpStatus.FORBIDDEN;',
  "    case 'WORKSPACE_LIMIT_REACHED':",
  "    case 'WORKSPACE_MEMBER_LIMIT_REACHED':",
  "    case 'USAGE_LIMIT_REACHED':",
  "    case 'PLAN_LIMIT_EXCEEDED':",
  '      return HttpStatus.PAYMENT_REQUIRED;',
  "    case 'BILLING_PROVIDER_UNAVAILABLE':",
  "    case 'BILLING_SUBSCRIPTION_UPDATE_FAILED':",
  "    case 'BILLING_RECONCILIATION_REQUIRED':",
  '      return HttpStatus.BAD_GATEWAY;',
  "    case 'UNKNOWN':",
  '      return HttpStatus.INTERNAL_SERVER_ERROR;',
  '    default:',
  '      return HttpStatus.BAD_REQUEST;',
  '  }',
  '}',
].join('\n');

const TYPES_PATH = 'apps/extension/lib/selection/types.ts';
const TYPES_TEXT = [
  "import type { AIAction, PR_DIFF_UNAVAILABLE_CODE, WorkspaceErrorCode } from '@project-x/types';",
  '',
  'export type SelectionRect = {',
  '  x: number;',
  '  y: number;',
  '  width: number;',
  '  height: number;',
  '  top: number;',
  '  right: number;',
  '  bottom: number;',
  '  left: number;',
  '};',
  '',
  "export type ToolbarPhase = 'hidden' | 'trigger' | 'menu' | 'assistant';",
  '',
  'export type AiActionId = AIAction;',
  '',
  'export type AiActionDefinition = {',
  '  id: AIAction;',
  '  label: string;',
  '  description: string;',
  '  shortcut?: string;',
  '};',
  '',
  'export type AssistantView =',
  "  | { status: 'menu' }",
  "  | { status: 'custom-prompt'; input: string }",
  "  | { status: 'loading'; action: AIAction }",
  "  | { status: 'streaming'; action: AIAction; content: string }",
  "  | { status: 'success'; action: AIAction; content: string }",
  '  | {',
  "      status: 'error';",
  '      action: AIAction;',
  '      message: string;',
  '      code?: WorkspaceErrorCode | typeof PR_DIFF_UNAVAILABLE_CODE | null;',
  '      referenceId?: string | null;',
  '      unauthorized?: boolean;',
  '    };',
  '',
  'export type SelectionSnapshot = {',
  '  text: string;',
  '  rect: SelectionRect;',
  '};',
].join('\n');

// ── a small service with every guard shape ─────────────────────────────────────────────

const SVC = 'apps/api/src/notes/notes.service.ts';
const ACCESS = 'apps/api/src/notes/access.ts';
const FILES: Record<string, string> = {
  [SVC]: [
    "import type { NoteRow } from './types';", // 1
    "import { assertMember } from './access';", // 2
    '', // 3
    'type Options = {', // 4
    '  includeArchived?: boolean;', // 5
    '};', // 6
    '', // 7
    'export class NotesService {', // 8
    '  async read(userId: string, noteId: string, opts: Options) {', // 9
    '    const note = await this.prisma.note.findUnique({ where: { id: noteId } });', // 10
    '    if (!note) {', // 11
    "      throw new NotFoundException('Note not found.');", // 12
    '    }', // 13
    '    if (opts.includeArchived) {', // 14
    "      if (!userId) throw new ForbiddenException('debug only');", // 15
    '    }', // 16
    "    const owner: NoteRow['owner'] = note.owner;", // 17
    '    return this.audit.record(', // 18
    '      userId,', // 19
    '      owner.workspaceId,', // 20
    '    );', // 21
    '  }', // 22
    '  async wrongCheck(userId: string, workspaceId: string, noteId: string) {', // 23
    '    const member = await this.prisma.membership.findFirst({ where: { userId, workspaceId } });', // 24
    '    if (!member) {', // 25
    "      throw new ForbiddenException('Not a member.');", // 26
    '    }', // 27
    '    return this.prisma.note.delete({ where: { id: noteId } });', // 28
    '  }', // 29
    '  async guarded(userId: string, noteId: string) {', // 30
    '    await assertMember(userId, noteId);', // 31
    '    return this.prisma.note.delete({ where: { id: noteId } });', // 32
    '  }', // 33
    '  async opaque(userId: string, noteId: string) {', // 34
    '    await this.policy.assertCanDelete(userId, noteId);', // 35
    '    return this.prisma.note.delete({ where: { id: noteId } });', // 36
    '  }', // 37
    '  async late(userId: string, noteId: string) {', // 38
    '    const deleted = await this.prisma.note.delete({ where: { id: noteId } });', // 39
    "    if (!userId) throw new ForbiddenException('too late');", // 40
    '    return deleted;', // 41
    '  }', // 42
    '}', // 43
  ].join('\n'),
  [ACCESS]: [
    'export async function assertMember(userId: string, noteId: string): Promise<void> {',
    '  const m = await prisma.membership.findFirst({ where: { userId } });',
    '  if (!m) {',
    "    throw new ForbiddenException('Not a member.');",
    '  }',
    '}',
  ].join('\n'),
};

function windowOf(path: string, text: string, from: number, to: number): CodeSection {
  const lines = text.split('\n');
  return {
    path,
    label: 'code at PR head around the finding',
    lines: Array.from({ length: to - from + 1 }, (_, i) => ({
      tag: 'HEAD' as const,
      n: from + i,
      old: null,
      text: lines[from + i - 1]!,
    })),
    focus: 0,
  };
}

async function check(input: {
  files?: Record<string, string>;
  path: string;
  from: number;
  to: number;
  focus: number;
  evidence?: string;
  category?: 'security' | 'correctness';
  fullText?: boolean;
  /** Window lines withheld from the verifier. */
  hide?: number[];
  output: Partial<VerificationOutput>;
}): Promise<AssessedVerdict> {
  const files = input.files ?? FILES;
  const text = files[input.path]!;
  const full = windowOf(input.path, text, input.from, input.to);
  const window = { ...full, lines: full.lines.filter((l) => !input.hide?.includes(l.n!)) };
  const category = input.category ?? 'correctness';
  const deps = await resolveDependencies({
    originPath: input.path,
    originText: text,
    windowLines: window.lines,
    focusLine: input.focus,
    cache: new DependencyCache(async (p: string) => files[p] ?? null),
    maxChars: 12_000,
    securityFinding: SECURITY_CATEGORIES.has(category),
  });
  const finding = validatedFinding({
    path: input.path,
    category,
    severity: 'medium',
    lineStart: input.focus,
    lineEnd: input.focus,
    headLine: input.focus,
    evidence: input.evidence ?? text.split('\n')[input.focus - 1]!.trim(),
  });
  const { provided } = buildVerificationContent({
    finding,
    sections: [window],
    dependencies: deps,
    fileTexts: input.fullText === false ? new Map() : new Map([[input.path, text]]),
  });
  const output: VerificationOutput = {
    verdict: 'confirmed',
    severity: 'medium',
    reasoning: 'r',
    decisiveCode: '',
    failureSite: '',
    dependsOnCodeNotShown: false,
    reachableTrigger: 'A caller passes a crafted identifier',
    violatedInvariant: 'Only members change notes of their workspace',
    triggerSource: '',
    guardsOnPath: [],
    ...input.output,
  };
  return assessVerdict(output, finding, provided);
}

const DELETE_LINE = 'return this.prisma.note.delete({ where: { id: noteId } });';

describe('failure-site classification (TypeScript AST)', () => {
  const T = [
    "import { a } from './a';", // 1
    "import type { B } from './b';", // 2
    "export { c } from './c';", // 3
    'export type { D } from "./d";', // 4
    '', // 5
    '/**', // 6
    ' * Doc comment.', // 7
    ' */', // 8
    'type Opts = {', // 9
    '  code?: string | null;', // 10
    '};', // 11
    'interface Shape {', // 12
    '  size: number;', // 13
    '}', // 14
    'declare const ENV: string;', // 15
    'export function run(x: Opts): string {', // 16
    "  const label: Opts['code'] = x.code ?? null; // typed, but runtime", // 17
    '  const msg = `a', // 18
    '    multi-line template ${label}`;', // 19
    '  return format(', // 20
    '    msg,', // 21
    '    label,', // 22
    '  );', // 23
    '}', // 24
  ].join('\n');
  it.each([
    [1, 'import'],
    [2, 'import'],
    [3, 'import'],
    [4, 'type_only'],
    [5, 'blank'],
    [6, 'comment'],
    [7, 'comment'],
    [10, 'type_only'],
    [11, 'closing'],
    [13, 'type_only'],
    [14, 'closing'],
    [15, 'type_only'],
    [16, 'executable'],
    [17, 'executable'],
    [19, 'executable'],
    [21, 'executable'],
    [23, 'closing'],
    [24, 'closing'],
  ])('line %i → %s', (line, kind) => {
    expect(classifySiteLine('src/t.ts', T, line)).toBe(kind);
  });

  it('text fallback (no parseable source) recognizes the same non-executable lines', () => {
    expect(classifySiteText('  }')).toBe('closing');
    expect(classifySiteText('   ')).toBe('blank');
    expect(classifySiteText('  // note')).toBe('comment');
    expect(classifySiteText("import { x } from 'y';")).toBe('import');
    expect(classifySiteText('export type A = B;')).toBe('type_only');
    expect(classifySiteText('  return run(x);')).toBe('executable');
  });
});

describe('guard-aware confirmation', () => {
  const wrongCheck = {
    path: SVC,
    from: 23,
    to: 29,
    focus: 28,
    output: {
      decisiveCode: `if (!member) {\n${DELETE_LINE}`,
      failureSite: `${SVC}:28`,
      triggerSource: 'async wrongCheck(userId: string, workspaceId: string, noteId: string) {',
    },
  };

  it('a model omitting an existing guard from guardsOnPath → Needs Investigation', async () => {
    const a = await check(wrongCheck);
    expect(a).toMatchObject({
      verdict: 'insufficient_context',
      audit: { rule: 'guard_not_addressed', guardCoverage: 'missing', guardsFound: 1 },
    });
    expect(a.reason).toContain(`${SVC}:25`);
  });

  it('a guard that checks the wrong variable stays confirmable when the bypass is explained', async () => {
    const a = await check({
      ...wrongCheck,
      output: {
        ...wrongCheck.output,
        guardsOnPath: [
          {
            code: 'if (!member) {',
            whyNotPreventing:
              'It checks membership of the requested workspace, but the delete is not scoped to it, so any note id is deleted.',
          },
        ],
      },
    });
    expect(a).toMatchObject({
      verdict: 'confirmed',
      audit: {
        rule: 'confirmed',
        guardCoverage: 'complete',
        guardsFound: 1,
        siteKind: 'executable',
      },
    });
  });

  it('a one-word excuse does not count as addressing a guard', async () => {
    const a = await check({
      ...wrongCheck,
      output: {
        ...wrongCheck.output,
        guardsOnPath: [{ code: 'if (!member) {', whyNotPreventing: 'n/a' }],
      },
    });
    expect(a.audit.rule).toBe('guard_not_addressed');
  });

  it('a guard inside an unrelated branch is not required; a multi-line statement is a valid site; types nearby do not matter', async () => {
    const a = await check({
      path: SVC,
      from: 9,
      to: 22,
      focus: 20,
      output: {
        decisiveCode: "const owner: NoteRow['owner'] = note.owner;\nowner.workspaceId,",
        failureSite: `${SVC}:20`,
        triggerSource: 'async read(userId: string, noteId: string, opts: Options) {',
        guardsOnPath: [
          {
            code: 'if (!note) {',
            whyNotPreventing:
              'Only rejects a missing note; any existing note of another workspace passes.',
          },
        ],
      },
    });
    // The `if (opts.includeArchived) { if (!userId) throw … }` guard is nested in an
    // unrelated branch and need not be listed; line 20 is inside a multi-line call.
    expect(a).toMatchObject({
      verdict: 'confirmed',
      audit: { guardsFound: 1, siteKind: 'executable' },
    });
  });

  it('a guard after the failure site is not on the path (nothing to address)', async () => {
    const a = await check({
      path: SVC,
      from: 38,
      to: 42,
      focus: 39,
      output: {
        decisiveCode:
          'const deleted = await this.prisma.note.delete({ where: { id: noteId } });\nreturn deleted;',
        failureSite: `${SVC}:39`,
        triggerSource: 'async late(userId: string, noteId: string) {',
      },
    });
    expect(a).toMatchObject({ verdict: 'confirmed', audit: { guardCoverage: 'none_found' } });
  });

  it('a guard in a resolved helper must be addressed; explaining its gap keeps a real bug confirmable', async () => {
    const base = {
      path: SVC,
      from: 30,
      to: 33,
      focus: 32,
      output: {
        decisiveCode: `await assertMember(userId, noteId);\n${DELETE_LINE}`,
        failureSite: `${SVC}:32`,
        triggerSource: 'async guarded(userId: string, noteId: string) {',
      },
    };
    const silent = await check(base);
    expect(silent).toMatchObject({
      verdict: 'insufficient_context',
      audit: { rule: 'guard_not_addressed' },
    });
    expect(silent.reason).toContain('assertMember()');

    const explained = await check({
      ...base,
      output: {
        ...base.output,
        guardsOnPath: [
          {
            code: "throw new ForbiddenException('Not a member.');",
            whyNotPreventing:
              'assertMember only checks that the user has some membership, never that the note is in it.',
          },
        ],
      },
    });
    expect(explained.verdict).toBe('confirmed');
  });

  it('a guard that cannot be inspected leaves the outcome open', async () => {
    const a = await check({
      path: SVC,
      from: 34,
      to: 37,
      focus: 36,
      output: {
        decisiveCode: `await this.policy.assertCanDelete(userId, noteId);\n${DELETE_LINE}`,
        failureSite: `${SVC}:36`,
        triggerSource: 'async opaque(userId: string, noteId: string) {',
      },
    });
    expect(a).toMatchObject({
      verdict: 'insufficient_context',
      audit: { rule: 'guard_unresolved', guardCoverage: 'unresolved' },
    });
  });

  it('a guard the verifier was never shown → Needs Investigation', async () => {
    // The guard's condition (L25) is withheld; the file text still shows it exists.
    const a = await check({
      ...wrongCheck,
      hide: [25],
      output: {
        ...wrongCheck.output,
        decisiveCode: `throw new ForbiddenException('Not a member.');\n${DELETE_LINE}`,
      },
    });
    expect(a).toMatchObject({ audit: { rule: 'guard_not_shown', guardCoverage: 'not_shown' } });
  });

  it('without the file text, a window that starts mid-function cannot establish order', async () => {
    const a = await check({ ...wrongCheck, hide: [24], fullText: false });
    expect(a).toMatchObject({
      audit: { rule: 'guard_order_unknown', guardCoverage: 'order_unknown' },
    });
  });

  it('without the file text, a fully shown method is still analysed (class context rebuilt)', async () => {
    const a = await check({ ...wrongCheck, fullText: false });
    expect(a.audit.rule).toBe('guard_not_addressed');
  });

  it.each([
    [27, 'closing'],
    [3, 'blank'],
    [1, 'import'],
    [5, 'type_only'],
  ] as const)('failure site at line %i (%s) is rejected', async (line, kind) => {
    const a = await check({
      ...wrongCheck,
      from: 1,
      to: 29,
      output: { ...wrongCheck.output, failureSite: `${SVC}:${line}` },
    });
    expect(a).toMatchObject({
      verdict: 'insufficient_context',
      audit: { rule: 'site_not_executable', siteKind: kind, siteLine: line },
    });
  });

  it('a confirmation without a grounded trigger source is not proof', async () => {
    const a = await check({
      ...wrongCheck,
      output: { ...wrongCheck.output, triggerSource: 'the user sends a bad id' },
    });
    expect(a.audit.rule).toBe('trigger_source_missing');
  });
});

// ── live review #4 replay (exact sources at 69e1fc4) ──────────────────────────────────

const LIVE = {
  [RESOLVE_PATH]: RESOLVE_TEXT,
  [CONTEXT_PATH]: CONTEXT_TEXT,
  [ERRORS_PATH]: ERRORS_TEXT,
};
const C1 = {
  files: LIVE,
  path: RESOLVE_PATH,
  from: 21,
  to: 42,
  focus: 29,
  evidence: 'if (!candidate && peekRequestWorkspaceHeaderInvalid()) {',
};
const C1_DECISIVE =
  'const candidate = explicit ?? peekRequestWorkspaceId();\nif (!candidate && peekRequestWorkspaceHeaderInvalid()) {';

describe('live review #4 replay — neither candidate is confirmed', () => {
  it('C1 as reported live: failure site L42 is a closing brace', async () => {
    const a = await check({
      ...C1,
      output: { decisiveCode: C1_DECISIVE, failureSite: `${RESOLVE_PATH}:42` },
    });
    expect(a).toMatchObject({
      verdict: 'insufficient_context',
      audit: { rule: 'site_not_executable', siteKind: 'closing', siteLine: 42 },
    });
  });

  it('C1 with an executable site: the trigger is a request-context value whose writer was never shown', async () => {
    const a = await check({
      ...C1,
      output: {
        decisiveCode: `${C1_DECISIVE}\nreturn membership.workspaceId;`,
        failureSite: `${RESOLVE_PATH}:41`,
        triggerSource: 'const candidate = explicit ?? peekRequestWorkspaceId();',
      },
    });
    expect(a).toMatchObject({
      verdict: 'insufficient_context',
      audit: { rule: 'state_writer_unavailable' },
    });
    expect(a.reason).toContain('workspaceId');
  });

  it('C1 explaining only the header check: the membership denial on the path is unaddressed', async () => {
    const a = await check({
      ...C1,
      output: {
        decisiveCode: `${C1_DECISIVE}\nreturn membership.workspaceId;`,
        failureSite: `${RESOLVE_PATH}:41`,
        triggerSource: 'explicitWorkspaceId?: string,',
        guardsOnPath: [
          {
            code: 'if (!candidate && peekRequestWorkspaceHeaderInvalid()) {',
            whyNotPreventing: 'It is skipped whenever a candidate exists.',
          },
        ],
      },
    });
    expect(a).toMatchObject({
      verdict: 'insufficient_context',
      audit: { rule: 'guard_not_addressed', guardsFound: 2 },
    });
    expect(a.reason).toContain(`${RESOLVE_PATH}:35`);
  });

  it('C1 limitation: a verifier that explains away every guard is not caught by the gates alone', async () => {
    // Documented residual risk: the gates check structure, not whether the excuse is true.
    const a = await check({
      ...C1,
      output: {
        decisiveCode: `${C1_DECISIVE}\nreturn membership.workspaceId;`,
        failureSite: `${RESOLVE_PATH}:41`,
        triggerSource: 'explicitWorkspaceId?: string,',
        guardsOnPath: [
          {
            code: 'if (!candidate && peekRequestWorkspaceHeaderInvalid()) {',
            whyNotPreventing: 'It is skipped whenever a candidate exists.',
          },
          {
            code: 'if (!membership) {',
            whyNotPreventing: 'Claims the membership could belong to another workspace.',
          },
        ],
      },
    });
    expect(a.verdict).toBe('confirmed');
  });

  it.each([
    [35, 'type_only'],
    [1, 'import'],
  ] as const)(
    'C2 selection/types.ts: a failure site at L%i (%s) cannot fail at runtime',
    async (line, kind) => {
      const a = await check({
        files: { [TYPES_PATH]: TYPES_TEXT },
        path: TYPES_PATH,
        from: 1,
        to: 38,
        focus: 35,
        output: {
          decisiveCode:
            "code?: WorkspaceErrorCode | typeof PR_DIFF_UNAVAILABLE_CODE | null;\nstatus: 'error';",
          failureSite: `${TYPES_PATH}:${line}`,
        },
      });
      expect(a).toMatchObject({
        verdict: 'insufficient_context',
        audit: { rule: 'site_not_executable', siteKind: kind },
      });
    },
  );

  it('seeded genuine vulnerability in the same shape stays confirmed: a requested workspace is returned unchecked', async () => {
    const vulnerable = RESOLVE_TEXT.replace(
      '    const membership = await findActiveMembership(prisma, userId, candidate);',
      '    return candidate; // BUG: no membership check',
    );
    const a = await check({
      ...C1,
      files: { ...LIVE, [RESOLVE_PATH]: vulnerable },
      focus: 34,
      evidence: 'return candidate; // BUG: no membership check',
      category: 'security',
      output: {
        decisiveCode: 'if (candidate) {\nreturn candidate; // BUG: no membership check',
        failureSite: `${RESOLVE_PATH}:34`,
        triggerSource: 'explicitWorkspaceId?: string,',
        reachableTrigger: 'A caller passes the id of a workspace the user is not a member of',
        violatedInvariant: 'Only workspaces the user is an active member of are returned',
        guardsOnPath: [
          {
            code: 'if (!candidate && peekRequestWorkspaceHeaderInvalid()) {',
            whyNotPreventing:
              'It only fires when no workspace was requested; a requested foreign id skips it.',
          },
        ],
      },
    });
    expect(a).toMatchObject({
      verdict: 'confirmed',
      audit: { guardCoverage: 'complete', guardsFound: 1 },
    });
  });
});
