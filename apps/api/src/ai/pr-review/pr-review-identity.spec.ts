import { describe, expect, it } from 'vitest';

import { chunkPatch } from './diff-hunks';
import type { CodeSection } from './pr-review-context';
import { DependencyCache, resolveDependencies } from './pr-review-deps';
import { validateBatchFindings, type BatchFindingInput } from './pr-review-findings';
import { rawFinding, validatedFinding } from './pr-review-fixtures';
import type { PlannedBatch } from './pr-review-plan';
import { callArguments, isIdentityArgument, whereBindingAt } from './pr-review-site';
import {
  assessVerdict,
  buildVerificationContent,
  type AssessedVerdict,
  type VerificationOutput,
} from './pr-review-verify';

// ── 1. evidence matching: moved / re-indented code ──────────────────────────────────────

const batchOf = (path: string, patch: string): PlannedBatch => ({
  id: 'b1',
  diffChars: patch.length,
  units: [{ path, chunkIndex: 0, chunkCount: 1, chunk: chunkPatch(patch, 100_000)[0]! }],
});
const validate = (path: string, patch: string, finding: Partial<BatchFindingInput>) =>
  validateBatchFindings(
    { summary: '', findings: [rawFinding({ path, ...finding })] },
    batchOf(path, patch),
  );

// A lock removed around count + create: both lines are re-indented (DEL copy, then ADD copy).
const REINDENT = [
  '@@ -10,9 +10,7 @@ export async function addMember(',
  '   limit: number,',
  ' ): Promise<void> {',
  '-  await db.lock(`seats:${workspaceId}`, async () => {',
  '-    const count = await db.membership.count({ where: { workspaceId } });',
  '-    await db.membership.create({ data: { workspaceId, userId } });',
  '-  });',
  '+  const count = await db.membership.count({ where: { workspaceId } });',
  '+  await db.membership.create({ data: { workspaceId, userId } });',
  ' }',
].join('\n');
const CREATE = 'await db.membership.create({ data: { workspaceId, userId } });';

// A guard moved below the lookup (exists as DEL and as ADD), plus an unrelated change.
const MOVED = [
  '@@ -3,8 +3,8 @@ export async function remove(userId: string, id: string) {',
  "-  if (!userId) throw new Error('FORBIDDEN');",
  '   const row = await db.row.findUnique({ where: { id } });',
  "+  if (!userId) throw new Error('FORBIDDEN');",
  '   await db.row.delete({ where: { id } });',
  ' }',
].join('\n');

// A guard genuinely removed (DEL only).
const REMOVED = [
  '@@ -3,6 +3,5 @@ export async function remove(userId: string, id: string) {',
  "-  if (!(await isMember(userId))) throw new Error('FORBIDDEN');",
  '   await db.row.delete({ where: { id } });',
  ' }',
].join('\n');

describe('evidence matching — moved and re-indented code', () => {
  it('a re-indented line present as DEL and ADD anchors to the ADD copy for introduced behavior', () => {
    const r = validate('src/seats.ts', REINDENT, {
      category: 'data_integrity',
      severity: 'medium',
      evidence: CREATE,
      changeType: 'introduced',
    });
    expect(r.rejectedByReason).toEqual({});
    expect(r.findings[0]).toMatchObject({ lineStart: 13, lineEnd: 13, headLine: 13 });
    expect(r.findings[0]!.gateNotes).toContain('evidence_moved');
  });

  it('a removed-safeguard claim about a guard that only MOVED anchors to the deleted copy but is kept (verification decides)', () => {
    const r = validate('src/rows.ts', MOVED, {
      category: 'security',
      evidence: "if (!userId) throw new Error('FORBIDDEN');",
      changeType: 'removed_safeguard',
    });
    expect(r.rejectedByReason).toEqual({});
    expect(r.findings[0]).toMatchObject({
      changeType: 'removed_safeguard',
      lineStart: 3,
      disposition: 'needs_investigation',
      verification: { status: 'pending' },
    });
    expect(r.findings[0]!.gateNotes).toContain('evidence_moved');
  });

  it('a genuinely removed guard keeps its removed-safeguard anchor (no moved note)', () => {
    const r = validate('src/rows.ts', REMOVED, {
      category: 'security',
      evidence: "if (!(await isMember(userId))) throw new Error('FORBIDDEN');",
      changeType: 'removed_safeguard',
    });
    expect(r.findings[0]).toMatchObject({ changeType: 'removed_safeguard', lineStart: 3 });
    expect(r.findings[0]!.gateNotes).not.toContain('evidence_moved');
  });

  it('a deleted guard mislabelled "introduced" is judged as a removed safeguard, not discarded', () => {
    const r = validate('src/rows.ts', REMOVED, {
      evidence: "if (!(await isMember(userId))) throw new Error('FORBIDDEN');",
      changeType: 'introduced',
    });
    expect(r.rejectedByReason).toEqual({});
    expect(r.findings[0]).toMatchObject({ changeType: 'removed_safeguard' });
    expect(r.findings[0]!.gateNotes).toContain('change_type_corrected');
    // Not tagged defensive: the deleted guard is the claim's subject and no longer runs.
    expect(r.findings[0]!.gateNotes).not.toContain('defensive_evidence');
  });

  it('several surviving copies: the one nearest the claimed line wins', () => {
    const patch = [
      '@@ -1,0 +1,9 @@',
      '+export function a() {',
      '+  return cache.get(key) ?? load();',
      '+}',
      '+export function b() {',
      '+  return 1;',
      '+}',
      '+export function c() {',
      '+  return cache.get(key) ?? load();',
      '+}',
    ].join('\n');
    const r = validate('src/c.ts', patch, {
      category: 'correctness',
      severity: 'medium',
      evidence: 'return cache.get(key) ?? load();',
      lineStart: 8,
      lineEnd: 8,
    });
    expect(r.findings[0]).toMatchObject({ lineStart: 8, headLine: 8 });
  });
});

// ── 2. authorization refutation safety: identity binding ───────────────────────────────

describe('requester identity binding (AST)', () => {
  const text = [
    'export async function a(db: Db, userId: string, workspaceId: string) {', // 1
    '  return db.m.findFirst({ where: { workspaceId, userId } });', // 2
    '}', // 3
    'export async function b(db: Db, userId: string, workspaceId: string) {', // 4
    '  return db.m.findFirst({', // 5
    "    where: { workspaceId, status: 'active' },", // 6
    '  });', // 7
    '}', // 8
    'export async function c(db: Db, userId: string, note: Note) {', // 9
    '  return db.m.findFirst({ where: { workspaceId: note.workspaceId, userId: note.authorId } });', // 10
    '}', // 11
    'export async function d(db: Db, currentUser: { id: string }, workspaceId: string) {', // 12
    '  const actor = currentUser.id;', // 13
    '  return db.m.findFirst({ where: { workspaceId, userId: actor } });', // 14
    '}', // 15
  ].join('\n');

  it('binds shorthand userId to the identity-named parameter', () => {
    expect(whereBindingAt('x.ts', text, 2).users).toEqual([
      { key: 'userId', binding: { kind: 'param', index: 1, name: 'userId', identityNamed: true } },
    ]);
  });

  it('a multi-line where without a user key has only a tenant filter', () => {
    expect(whereBindingAt('x.ts', text, 6)).toMatchObject({ found: true, tenant: true, users: [] });
    // The statement start line resolves to the same where.
    expect(whereBindingAt('x.ts', text, 5)).toMatchObject({ found: true, users: [] });
  });

  it('another entity’s id is not the requester', () => {
    expect(whereBindingAt('x.ts', text, 10).users).toEqual([
      { key: 'userId', binding: { kind: 'other' } },
    ]);
  });

  it('a local alias of an identity field is the requester', () => {
    expect(whereBindingAt('x.ts', text, 14).users).toEqual([
      { key: 'userId', binding: { kind: 'direct' } },
    ]);
  });

  it('client-controlled request input is never the requester (req.body / params / query / dto)', () => {
    const t = [
      'export async function a(db: Db, req: Req) {', // 1
      '  const userId = req.body.userId;', // 2
      '  return db.m.findFirst({ where: { workspaceId: req.body.ws, userId } });', // 3
      '}', // 4
      'export async function b(db: Db, params: { userId: string }, query: Q, dto: D) {', // 5
      '  return db.m.findFirst({ where: { userId: params.userId, ownerId: query.userId, authorId: dto.userId } });', // 6
      '}', // 7
      'export async function c(db: Db, req: Req, ctx: Ctx, session: S) {', // 8
      '  return db.m.findFirst({ where: { userId: req.user.id, ownerId: ctx.state.user.id, authorId: session.userId } });', // 9
      '}', // 10
    ].join('\n');
    expect(whereBindingAt('x.ts', t, 3).users).toEqual([
      { key: 'userId', binding: { kind: 'other' } },
    ]);
    expect(whereBindingAt('x.ts', t, 6).users.map((u) => u.binding.kind)).toEqual([
      'other',
      'other',
      'other',
    ]);
    expect(whereBindingAt('x.ts', t, 9).users.map((u) => u.binding.kind)).toEqual([
      'direct',
      'direct',
      'direct',
    ]);
    expect(
      [
        'req.body.userId',
        'params.userId',
        'dto.userId',
        'req.query.userId',
        'req.headers.userId',
      ].some(isIdentityArgument),
    ).toBe(false);
    expect(
      ['req.user.id', 'request.user.userId', 'session.userId', 'currentUser.id'].every(
        isIdentityArgument,
      ),
    ).toBe(true);
  });

  it('call-site arguments and identity arguments', () => {
    expect(
      callArguments('const m = await findMembership(db, userId, ws);', 'findMembership'),
    ).toEqual(['db', 'userId', 'ws']);
    expect(callArguments('const m = await findMembership(db, {', 'findMembership')).toBeNull();
    expect(['userId', 'currentUser.id', 'req.user.id', 'actorId'].every(isIdentityArgument)).toBe(
      true,
    );
    // `input` / `options` are usually client DTOs; `session.id` is the session's id.
    expect(
      [
        'note.authorId',
        'memberId',
        'row.userId',
        'workspaceId',
        'input.userId',
        'options.userId',
        'req.session.id',
        'session.id',
      ].some(isIdentityArgument),
    ).toBe(false);
  });
});

const P = 'apps/api/src/notes/notes.service.ts';
function windowOf(path: string, text: string): CodeSection {
  return {
    path,
    label: 'code at PR head around the finding',
    lines: text.split('\n').map((t, i) => ({ tag: 'HEAD' as const, n: i + 1, old: null, text: t })),
    focus: 0,
  };
}
async function refute(
  files: Record<string, string>,
  focus: number,
  decisiveCode: string,
): Promise<AssessedVerdict> {
  const text = files[P]!;
  const window = windowOf(P, text);
  const deps = await resolveDependencies({
    originPath: P,
    originText: text,
    windowLines: window.lines,
    focusLine: focus,
    cache: new DependencyCache(async (p: string) => files[p] ?? null),
    maxChars: 9_000,
    securityFinding: true,
  });
  const finding = validatedFinding({
    path: P,
    category: 'security',
    severity: 'high',
    lineStart: focus,
    lineEnd: focus,
    headLine: focus,
    evidence: text.split('\n')[focus - 1]!.trim(),
  });
  const { provided } = buildVerificationContent({
    finding,
    sections: [window],
    dependencies: deps,
    fileTexts: new Map(Object.entries(files)),
  });
  const output: VerificationOutput = {
    verdict: 'refuted',
    severity: 'low',
    reasoning: 'r',
    decisiveCode,
    failureSite: '',
    dependsOnCodeNotShown: false,
    reachableTrigger: '',
    violatedInvariant: '',
    triggerSource: '',
    guardsOnPath: [],
  };
  return assessVerdict(output, finding, provided);
}

const service = (whereLines: string[], guard = 'if (!membership) {') =>
  [
    'export async function deleteNote(db: Db, userId: string, noteId: string): Promise<void> {', // 1
    '  const note = await db.note.findUnique({ where: { id: noteId } });', // 2
    '  const membership = await db.membership.findFirst({', // 3
    ...whereLines.map((w) => `    ${w}`), // 4
    '  });', // 5
    `  ${guard}`, // 6
    "    throw new Error('FORBIDDEN');", // 7
    '  }', // 8
    '  await db.note.delete({ where: { id: noteId } });', // 9
    '}', // 10
  ].join('\n');
const GUARD_AND_DENY = "if (!membership) {\nthrow new Error('FORBIDDEN');";

describe('authorization refutation safety', () => {
  it('correct authenticated userId (multi-line where): the guard refutes', async () => {
    const a = await refute(
      { [P]: service(['where: { workspaceId: note.workspaceId, userId },']) },
      6,
      GUARD_AND_DENY,
    );
    expect(a).toMatchObject({ verdict: 'refuted', audit: { guardRelation: 'focus_guard_branch' } });
  });

  it('correct userId in a single-line where: the scoped query itself refutes', async () => {
    const text = [
      'export async function list(db: Db, userId: string, workspaceId: string) {',
      '  return db.note.findMany({ where: { workspaceId, authorId: userId } });',
      '}',
    ].join('\n');
    const a = await refute(
      { [P]: text },
      2,
      'return db.note.findMany({ where: { workspaceId, authorId: userId } });',
    );
    expect(a.verdict).toBe('refuted');
  });

  it.each([
    ['missing userId', ["where: { workspaceId: note.workspaceId, status: 'active' },"]],
    [
      'wrong userId (another entity)',
      ['where: { workspaceId: note.workspaceId, userId: note.authorId },'],
    ],
    [
      'unrelated user (a parameter that is not the requester)',
      ['where: { workspaceId: note.workspaceId, userId: noteId },'],
    ],
  ])('%s: the guard is not proof of membership → Needs Investigation', async (_l, where) => {
    const a = await refute({ [P]: service(where) }, 6, GUARD_AND_DENY);
    expect(a).toMatchObject({
      verdict: 'insufficient_context',
      audit: { guardRelation: 'not_established' },
    });
    expect(a.reason).toContain('requesting user');
  });

  it('missing userId in a single-line where: the query is not a denial', async () => {
    const text = [
      'export async function list(db: Db, userId: string, workspaceId: string) {',
      '  return db.note.findMany({ where: { workspaceId, archived: false } });',
      '}',
    ].join('\n');
    const a = await refute(
      { [P]: text },
      2,
      'return db.note.findMany({ where: { workspaceId, archived: false } });',
    );
    expect(a.verdict).toBe('insufficient_context');
  });

  const HELPER = 'apps/api/src/notes/membership.ts';
  const helper = [
    'export async function findMembership(db: Db, memberUserId: string, workspaceId: string) {',
    '  return db.membership.findFirst({',
    '    where: { workspaceId, userId: memberUserId },',
    '  });',
    '}',
  ].join('\n');
  const withHelper = (arg: string) =>
    [
      "import { findMembership } from './membership';",
      'export async function deleteNote(db: Db, userId: string, noteId: string): Promise<void> {',
      '  const note = await db.note.findUnique({ where: { id: noteId } });',
      `  const membership = await findMembership(db, ${arg}, note.workspaceId);`,
      '  if (!membership) {',
      "    throw new Error('FORBIDDEN');",
      '  }',
      '  await db.note.delete({ where: { id: noteId } });',
      '}',
    ].join('\n');

  it('identity aliased through a validated helper (requester passed in) refutes', async () => {
    const a = await refute({ [P]: withHelper('userId'), [HELPER]: helper }, 5, GUARD_AND_DENY);
    expect(a.verdict).toBe('refuted');
  });

  it('the same helper called with another entity’s id does not refute', async () => {
    const a = await refute(
      { [P]: withHelper('note.authorId'), [HELPER]: helper },
      5,
      GUARD_AND_DENY,
    );
    expect(a.verdict).toBe('insufficient_context');
  });

  it('incorrect guard conditions do not refute: inverted, and a role deny-list', async () => {
    const correctWhere = ['where: { workspaceId: note.workspaceId, userId },'];
    const inverted = await refute(
      { [P]: service(correctWhere, 'if (membership) {') },
      6,
      "if (membership) {\nthrow new Error('FORBIDDEN');",
    );
    expect(inverted.reason).toContain('not negated');
    const denyList = await refute(
      { [P]: service(correctWhere, "if (!membership || membership.role === 'viewer') {") },
      6,
      "if (!membership || membership.role === 'viewer') {\nthrow new Error('FORBIDDEN');",
    );
    expect(denyList).toMatchObject({ verdict: 'insufficient_context' });
    expect(denyList.reason).toContain('deny-list');
    // An allow-list (only owners) remains a valid denial.
    const allowList = await refute(
      { [P]: service(correctWhere, "if (!membership || membership.role !== 'owner') {") },
      6,
      "if (!membership || membership.role !== 'owner') {\nthrow new Error('FORBIDDEN');",
    );
    expect(allowList.verdict).toBe('refuted');
  });

  const AUTHZ = 'apps/api/src/notes/authz.ts';
  it('a tenant id produced by a validated authorization helper makes a workspace-only filter a denial', async () => {
    const authz = [
      'export async function authorize(db: Db, userId: string): Promise<string> {',
      '  const m = await db.membership.findFirst({ where: { userId } });',
      "  if (!m) throw new Error('FORBIDDEN');",
      '  return m.workspaceId;',
      '}',
    ].join('\n');
    const text = [
      "import { authorize } from './authz';",
      'export async function list(db: Db, userId: string) {',
      '  const workspaceId = await authorize(db, userId);',
      '  return db.note.findMany({ where: { workspaceId } });',
      '}',
    ].join('\n');
    const ok = await refute(
      { [P]: text, [AUTHZ]: authz },
      4,
      'return db.note.findMany({ where: { workspaceId } });',
    );
    expect(ok.verdict).toBe('refuted');
    // Without the authorization helper (workspaceId straight from the caller): not proof.
    const raw = text.replace(
      'const workspaceId = await authorize(db, userId);',
      'const workspaceId = requested;',
    );
    const no = await refute(
      { [P]: raw, [AUTHZ]: authz },
      4,
      'return db.note.findMany({ where: { workspaceId } });',
    );
    expect(no.verdict).toBe('insufficient_context');
  });
});
