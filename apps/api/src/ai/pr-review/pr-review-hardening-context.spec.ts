/**
 * Regression tests for the deterministic context used to verify security findings:
 * requester binding of `where` clauses, identity trust, path guards, dependency resolution,
 * denial detection and caller lookup. Tests named `KNOWN LIMITATION:` pin behaviour that is
 * still not the desired one.
 */
import { describe, expect, it } from 'vitest';

import { chunkPatch } from './diff-hunks';
import { findDefinition, type CodeSection } from './pr-review-context';
import { findCallers } from './pr-review-callers';
import { DENY_RE, DependencyCache, resolveDependencies } from './pr-review-deps';
import { validatedFinding } from './pr-review-fixtures';
import { guardsBeforeSite, isIdentityArgument, whereBindingAt } from './pr-review-site';
import {
  assessVerdict,
  buildVerificationContent,
  type VerificationOutput,
} from './pr-review-verify';

const P = 'apps/api/src/notes/notes.service.ts';
const windowOf = (path: string, text: string): CodeSection => ({
  path,
  label: 'code at PR head around the finding',
  lines: text.split('\n').map((t, i) => ({ tag: 'HEAD' as const, n: i + 1, old: null, text: t })),
  focus: 0,
});
async function refute(files: Record<string, string>, focus: number, decisiveCode: string) {
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

describe('pr-review hardening: where-binding is per query, not per statement', () => {
  const t = [
    'export async function getNote(db: Db, req: Req, noteId: string) {', // 1
    '  return db.note.findFirst({ where: { id: noteId }, include: { shares: { where: { userId: req.user.id } } } });', // 2
    '}', // 3
    'export async function del(db: Db, req: Req, id: string) {', // 4
    '  const [s] = await Promise.all([db.share.findFirst({ where: { userId: req.user.id } }), db.note.delete({ where: { id } })]);', // 5
    '}', // 6
  ].join('\n');

  it('a userId filter inside include does not make the top-level lookup requester-bound', () => {
    expect(whereBindingAt('x.ts', t, 2).users).toEqual([]);
  });
  it('a sibling query in Promise.all does not make the unscoped delete requester-bound', () => {
    expect(whereBindingAt('x.ts', t, 5).users).toEqual([]);
  });
  it('a refutation of an IDOR scoped only in include is not accepted', async () => {
    const a = await refute(
      { [P]: t },
      2,
      'return db.note.findFirst({ where: { id: noteId }, include: { shares: { where: { userId: req.user.id } } } });',
    );
    expect(a.verdict).toBe('insufficient_context');
    expect(a.audit.rule).toBe('refute_security_gap');
  });
});

describe('pr-review hardening: identity is trusted by provenance, not by name', () => {
  it('client DTO / options roots are not trusted; a principal (user.id) is', () => {
    const t = [
      'export async function update(db: Db, input: UpdateNoteDto, id: string) {', // 1
      '  return db.note.findFirst({ where: { id, userId: input.userId } });', // 2
      '}', // 3
      'export async function m(db: Db, options: QueryOptions, user: User) {', // 4
      '  return db.note.findFirst({ where: { ownerId: options.userId, authorId: user.id } });', // 5
      '}', // 6
    ].join('\n');
    expect(whereBindingAt('x.ts', t, 2).users[0]!.binding.kind).toBe('other');
    expect(whereBindingAt('x.ts', t, 5).users.map((u) => u.binding.kind)).toEqual([
      'other',
      'direct',
    ]);
  });
  it('a refutation relying on client DTO input.userId scoping is not accepted', async () => {
    const t = [
      'export async function update(db: Db, input: UpdateNoteDto, id: string) {',
      '  return db.note.findFirst({ where: { id, userId: input.userId } });',
      '}',
    ].join('\n');
    const a = await refute(
      { [P]: t },
      2,
      'return db.note.findFirst({ where: { id, userId: input.userId } });',
    );
    expect(a.verdict).toBe('insufficient_context');
    expect(a.audit.rule).toBe('refute_security_gap');
  });
  it("a @Body('userId') parameter named userId is not trusted as the requester", async () => {
    const t = [
      "export async function remove(@Body('userId') userId: string, @Param('id') id: string) {",
      '  return db.note.findFirst({ where: { id, userId } });',
      '}',
    ].join('\n');
    expect(whereBindingAt('x.ts', t, 2).users[0]!.binding.kind).toBe('other');
    const a = await refute({ [P]: t }, 2, 'return db.note.findFirst({ where: { id, userId } });');
    expect(a.verdict).toBe('insufficient_context');
    expect(a.audit.rule).toBe('refute_security_gap');
  });
  it('an alias later reassigned from client input is not trusted', () => {
    const t = [
      'export async function get(db: Db, req: Req) {', // 1
      '  let actor = req.user.id;', // 2
      '  if (req.body.onBehalfOf) actor = req.body.onBehalfOf;', // 3
      '  return db.note.findMany({ where: { userId: actor } });', // 4
      '}', // 5
    ].join('\n');
    expect(whereBindingAt('x.ts', t, 4).users[0]!.binding.kind).toBe('other');
  });
  it('isIdentityArgument does not trust session.id, input.user.id or options.userId', () => {
    expect(isIdentityArgument('req.session.id')).toBe(false);
    expect(isIdentityArgument('input.user.id')).toBe(false);
    expect(isIdentityArgument('options.userId')).toBe(false);
    expect(isIdentityArgument('req.user.id')).toBe(true);
    expect(isIdentityArgument('user.id')).toBe(true);
  });
  it('KNOWN LIMITATION: isIdentityArgument trusts bare identity-named identifiers by name', () => {
    // Desired: a bare `userId` / `currentUserId` argument is trusted only when its provenance
    // (e.g. not a @Body/@Query parameter) is known.
    expect(isIdentityArgument('userId')).toBe(true);
    expect(isIdentityArgument('currentUserId')).toBe(true);
  });
});

describe('pr-review hardening: guardsBeforeSite only credits calls that can stop the site', () => {
  const t = [
    'export async function del(db: Db, user: User, id: string) {', // 1
    '  try {', // 2
    '    await assertCanDelete(user, id);', // 3
    '  } catch (e) {', // 4
    '    logger.warn(e);', // 5
    '  }', // 6
    '  await assertOwner(user, id).catch(() => undefined);', // 7
    '  void requireMember(user, id);', // 8
    '  await db.note.delete({ where: { id } });', // 9
    '}', // 10
  ].join('\n');
  it('swallowed (try/catch, .catch) and un-awaited asserts are not path guards', () => {
    const scan = guardsBeforeSite('x.ts', t, 9);
    expect(scan.status).toBe('ok');
    const guards = scan.status === 'ok' ? scan.guards : null;
    expect(guards).toEqual([]);
  });
});

describe('pr-review hardening: definition lookup resolves the real definition', () => {
  const origin = [
    "import { assertCanEdit } from './authz';", // 1
    'export function edit(db: Db, userId: string, note: Note) {', // 2
    '  assertCanEdit(', // 3
    '    userId,', // 4
    '    note,', // 5
    '  );', // 6
    '  return db.note.update({ where: { id: note.id }, data: {} });', // 7
    '}', // 8
  ].join('\n');
  const authz = [
    'export function assertCanEdit(userId: string, note: Note) {',
    '  if (note.authorId !== userId) throw new ForbiddenException();',
    '}',
  ].join('\n');
  it('a multi-line bare call is not taken as the definition; the imported helper is read', async () => {
    const reads: string[] = [];
    const files: Record<string, string> = { 'apps/api/src/notes/authz.ts': authz };
    const deps = await resolveDependencies({
      originPath: P,
      originText: origin,
      windowLines: windowOf(P, origin).lines,
      focusLine: 7,
      cache: new DependencyCache(async (p) => {
        reads.push(p);
        return files[p] ?? null;
      }),
      maxChars: 9_000,
      securityFinding: true,
    });
    const d = deps.resolved.find((r) => r.name === 'assertCanEdit')!;
    expect(d).toMatchObject({
      path: 'apps/api/src/notes/authz.ts',
      start: 1,
      end: 3,
      partial: false,
    });
    expect(reads).toContain('apps/api/src/notes/authz.ts');
    expect(deps.unresolved).toEqual([]);
  });
  it('findDefinition does not return a multi-line bare call site', () => {
    expect(findDefinition(origin.split('\n'), 'assertCanEdit')).toBeNull();
  });
  it('a field call resolves to the method of the declared class, not the first same-named one', async () => {
    const svc = [
      "import { AuthzService } from './authz.service';",
      'export class NotesService {',
      '  constructor(private readonly authz: AuthzService) {}',
      '  async del(user: User, id: string) {',
      '    await this.authz.canDelete(user, id);',
      '    return db.note.delete({ where: { id } });',
      '  }',
      '}',
    ].join('\n');
    const mod = [
      'export class NoopAuthz {',
      '  async canDelete(user: User, id: string) {',
      '    return true;',
      '  }',
      '}',
      'export class AuthzService {',
      '  async canDelete(user: User, id: string) {',
      '    if (!user.isAdmin) throw new ForbiddenException();',
      '  }',
      '}',
    ].join('\n');
    const deps = await resolveDependencies({
      originPath: P,
      originText: svc,
      windowLines: windowOf(P, svc).lines,
      focusLine: 6,
      cache: new DependencyCache(async (p) =>
        p === 'apps/api/src/notes/authz.service.ts' ? mod : null,
      ),
      maxChars: 9_000,
      securityFinding: true,
    });
    const d = deps.resolved.find((r) => r.name === 'AuthzService.canDelete')!;
    expect(d).toMatchObject({
      path: 'apps/api/src/notes/authz.service.ts',
      start: 7,
      end: 9,
      partial: false,
    });
  });
});

describe('pr-review hardening: a missing origin file is reported', () => {
  it('originText null yields a security-relevant unresolved entry', async () => {
    const win = [
      'export async function del(user: User, id: string) {',
      '  await this.access.assertCanDelete(user, id);',
      '  await db.note.delete({ where: { id } });',
      '}',
    ].join('\n');
    const deps = await resolveDependencies({
      originPath: P,
      originText: null,
      windowLines: windowOf(P, win).lines,
      focusLine: 3,
      cache: new DependencyCache(async () => null),
      maxChars: 9_000,
      securityFinding: true,
    });
    expect(deps.resolved).toEqual([]);
    expect(deps.unresolved).toHaveLength(1);
    expect(deps.unresolved[0]).toMatchObject({
      reason: 'not_found_or_inaccessible',
      securityRelevant: true,
      calledFrom: `${P}:2`,
    });
  });
});

describe('pr-review hardening: DENY_RE only matches real denials', () => {
  it('log strings, metric names and instanceof checks are not denials', () => {
    expect(DENY_RE.test("this.logger.warn('Forbidden access attempt, continuing');")).toBe(false);
    expect(DENY_RE.test("metrics.increment('ACCESS_DENIED');")).toBe(false);
    expect(DENY_RE.test('const wasNotFound = err instanceof NotFoundError;')).toBe(false);
    expect(DENY_RE.test('throw new ForbiddenException();')).toBe(true);
    expect(DENY_RE.test('throw new NotFoundException();')).toBe(true);
  });
});

describe('pr-review hardening: callers are matched by receiver, not bare method name', () => {
  const usersPatch = [
    '@@ -1,0 +1,4 @@',
    '+export class UsersController {',
    '+  async drop(id: string) {',
    '+    return this.usersService.remove(id);',
    '+  }',
  ].join('\n');
  const notesService = [
    'export class NotesService {',
    ...Array.from({ length: 8 }, () => '  // filler'),
    '  async remove(id: string) {', // 10
    '    return db.note.delete({ where: { id } });',
    '  }',
    '}',
  ].join('\n');

  it('`this.usersService.remove(` is not a caller of NotesService.remove', async () => {
    const r = await findCallers({
      name: 'remove',
      definitionPath: P,
      definitionRange: [10, 12],
      diffLinesByPath: new Map([
        ['apps/api/src/users/users.controller.ts', chunkPatch(usersPatch, 100_000)[0]!.lines],
      ]),
      provider: async (p) => (p === P ? notesService : null),
      maxChars: 2_000,
    });
    expect(r).toMatchObject({ status: 'none_in_changed_files', found: 0 });
  });

  it('KNOWN LIMITATION: without the definition file a same-named method call is a caller', async () => {
    // Desired: an unknown owner class does not invent callers. Mitigation: the section is
    // labelled context only.
    const r = await findCallers({
      name: 'remove',
      definitionPath: P,
      definitionRange: [10, 20],
      diffLinesByPath: new Map([
        ['apps/api/src/users/users.controller.ts', chunkPatch(usersPatch, 100_000)[0]!.lines],
      ]),
      maxChars: 2_000,
    });
    expect(r.status).toBe('found');
    expect(r.sections[0]!.label).toMatch(/context only/);
  });
});
