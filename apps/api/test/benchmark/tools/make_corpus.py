#!/usr/bin/env python3
"""Authoring tool: writes the Phase 1 review-quality benchmark corpus.

Ground-truth line numbers are computed from the code (anchor substrings), never typed by
hand, so labels cannot drift from the sources. Run: python3 make_corpus.py <repo root>
"""
import json
import os
import shutil
import subprocess
import sys

ROOT = sys.argv[1]
BENCH = os.path.join(ROOT, 'apps/api/test/benchmark')
CORPUS = os.path.join(BENCH, 'corpus')

DB_TS = """export type Where = Record<string, unknown>;

export type Table<T> = {
  findFirst(query: { where: Where }): Promise<T | null>;
  findUnique(query: { where: Where }): Promise<T | null>;
  findMany(query: { where: Where }): Promise<T[]>;
  count(query: { where: Where }): Promise<number>;
  create(query: { data: T }): Promise<T>;
  update(query: { where: Where; data: Partial<T> }): Promise<T | null>;
  delete(query: { where: Where }): Promise<void>;
};
"""

NOTES_TYPES = """import type { Table } from './db';

export type Note = { id: string; workspaceId: string; authorId: string; archived: boolean };
export type Membership = { workspaceId: string; userId: string; role: string; status: string };
export type NotesDb = { note: Table<Note>; membership: Table<Membership> };
"""


def line_of(text, anchor, occurrence=1):
    lines = text.split('\n')
    seen = 0
    for i, line in enumerate(lines):
        if anchor in line:
            seen += 1
            if seen == occurrence:
                return i + 1
    raise SystemExit(f'anchor not found: {anchor!r}')


CASES = []


def case(**kw):
    CASES.append(kw)


# ── 1. authorization bypass (guard removed) ────────────────────────────────────────────
AUTHZ_BASE = NOTES_TYPES + """
export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {
  const note = await db.note.findUnique({ where: { id: noteId } });
  if (!note) {
    throw new Error('NOT_FOUND');
  }
  const membership = await db.membership.findFirst({
    where: { workspaceId: note.workspaceId, userId },
  });
  if (!membership) {
    throw new Error('FORBIDDEN');
  }
  await db.note.delete({ where: { id: noteId } });
}
"""
AUTHZ_HEAD = NOTES_TYPES + """
export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {
  const note = await db.note.findUnique({ where: { id: noteId } });
  if (!note) {
    throw new Error('NOT_FOUND');
  }
  await db.note.delete({ where: { id: noteId } });
}
"""
case(
    id='authz-bypass',
    title='Note deletion no longer checks workspace membership',
    dir='apps/api/src/notes',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'notes.service.ts': (AUTHZ_BASE, AUTHZ_HEAD, AUTHZ_BASE)},
    truth=[dict(id='authz-bypass/delete-without-membership', file='notes.service.ts',
                anchor='await db.note.delete', category='security', severity='high',
                changeType='removed_safeguard',
                description='The membership check before deleting a note was removed: any authenticated user can delete a note of any workspace by id.',
                witness='an outsider can delete a note of another workspace')],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { deleteNote as fixedDelete } from './fixed/notes.service';
import { deleteNote as headDelete } from './head/notes.service';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'owner', status: 'active' }]),
});

describe('authz-bypass ground truth', () => {
  it('an outsider can delete a note of another workspace', async () => {
    const head = db();
    await headDelete(head, 'outsider', 'n1');
    expect(head.note.rows).toHaveLength(0); // bug: deleted without membership
    const fixed = db();
    await expect(fixedDelete(fixed, 'outsider', 'n1')).rejects.toThrow('FORBIDDEN');
    expect(fixed.note.rows).toHaveLength(1);
  });
});
""",
    candidates=[dict(
        key='authz', truth='authz-bypass/delete-without-membership', file='notes.service.ts',
        claimed=('await db.note.delete', 0), category='security', severity='high',
        changeType='removed_safeguard',
        title='deleteNote no longer verifies workspace membership',
        explanation='The PR removed the membership lookup and FORBIDDEN branch, so the note is deleted for any caller.',
        evidence="if (!membership) {\nthrow new Error('FORBIDDEN');",
        trigger='A user who is not a member of ws1 calls deleteNote with a ws1 note id',
        failurePath='notes.service.ts: findUnique → (removed membership check) → delete',
        violatedInvariant='Only members of the note workspace can delete it',
        impact='Cross-workspace deletion of notes',
        verify=dict(
            verdict='confirmed', severity='high',
            decisiveCode="if (!note) {\nawait db.note.delete({ where: { id: noteId } });",
            failure=('await db.note.delete', 0),
            triggerSource='export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {',
            guards=[('if (!note) {', 'Only rejects a missing note; any existing note of another workspace passes.'),
                    ('if (!membership) {', 'This membership check was deleted by the PR and no longer runs.')],
            trigger='A non-member deletes a ws1 note by id', invariant='Only workspace members delete notes'),
        adversarial=dict(verdict='refuted', severity='low', decisiveCode="if (!note) {\nthrow new Error('NOT_FOUND');"),
    )],
)

# ── 2. missing tenant filter ───────────────────────────────────────────────────────────
TENANT_BASE = NOTES_TYPES + """
export async function listNotesForUser(
  db: NotesDb,
  userId: string,
  workspaceId: string,
): Promise<Note[]> {
  const membership = await db.membership.findFirst({ where: { workspaceId, userId } });
  if (!membership) {
    throw new Error('FORBIDDEN');
  }
  return listNotes(db, workspaceId);
}

export async function listNotes(db: NotesDb, workspaceId: string): Promise<Note[]> {
  return db.note.findMany({ where: { workspaceId, archived: false } });
}
"""
TENANT_HEAD = TENANT_BASE.replace(
    'return db.note.findMany({ where: { workspaceId, archived: false } });',
    'return db.note.findMany({ where: { archived: false } });')
case(
    id='missing-tenant-filter',
    title='Note listing lost its workspace filter',
    dir='apps/api/src/notes',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'notes.query.ts': (TENANT_BASE, TENANT_HEAD, TENANT_BASE)},
    truth=[dict(id='missing-tenant-filter/unscoped-find-many', file='notes.query.ts',
                anchor='return db.note.findMany({ where: { archived: false } });', category='security',
                severity='high', changeType='introduced',
                description='listNotes no longer filters by workspaceId: a member of one workspace lists notes of every workspace (the caller membership check does not help).',
                witness='a member of ws1 sees notes of ws2')],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { listNotesForUser as fixedList } from './fixed/notes.query';
import { listNotesForUser as headList } from './head/notes.query';

const db = () => ({
  note: fakeTable([
    { id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false },
    { id: 'n2', workspaceId: 'ws2', authorId: 'u2', archived: false },
  ]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'member', status: 'active' }]),
});

describe('missing-tenant-filter ground truth', () => {
  it('a member of ws1 sees notes of ws2', async () => {
    expect((await headList(db(), 'u1', 'ws1')).map((n) => n.id)).toEqual(['n1', 'n2']);
    expect((await fixedList(db(), 'u1', 'ws1')).map((n) => n.id)).toEqual(['n1']);
  });
});
""",
    candidates=[dict(
        key='tenant', truth='missing-tenant-filter/unscoped-find-many', file='notes.query.ts',
        claimed=('return db.note.findMany({ where: { archived: false } });', 0), category='security',
        severity='high', changeType='introduced',
        title='listNotes returns notes of every workspace',
        explanation='The workspaceId filter was dropped from the query.',
        evidence='return db.note.findMany({ where: { archived: false } });',
        trigger='A member of ws1 calls listNotesForUser for ws1', failurePath='notes.query.ts listNotes findMany',
        violatedInvariant='Note reads are scoped to the requested workspace',
        impact='Cross-tenant disclosure of notes',
        verify=dict(
            verdict='confirmed', severity='high',
            decisiveCode='export async function listNotes(db: NotesDb, workspaceId: string): Promise<Note[]> {\nreturn db.note.findMany({ where: { archived: false } });',
            failure=('return db.note.findMany({ where: { archived: false } });', 0),
            triggerSource='export async function listNotes(db: NotesDb, workspaceId: string): Promise<Note[]> {',
            guards=[], trigger='A ws1 member lists notes while ws2 has notes',
            invariant='Reads are scoped to the requested workspace'),
        # Wrong refutation: quotes the caller's membership check (a different function above).
        adversarial=dict(verdict='refuted', severity='low',
                         decisiveCode="const membership = await db.membership.findFirst({ where: { workspaceId, userId } });\nif (!membership) {\nthrow new Error('FORBIDDEN');"),
    )],
    security_regression=True,
)

# ── 3. membership query lacks userId ───────────────────────────────────────────────────
MEM_BASE = NOTES_TYPES + """
export async function assertWorkspaceMember(
  db: NotesDb,
  userId: string,
  workspaceId: string,
): Promise<Membership> {
  const membership = await db.membership.findFirst({
    where: { workspaceId, userId, status: 'active' },
  });
  if (!membership) {
    throw new Error('FORBIDDEN');
  }
  return membership;
}
"""
MEM_HEAD = MEM_BASE.replace("where: { workspaceId, userId, status: 'active' },",
                            "where: { workspaceId, status: 'active' },")
case(
    id='membership-missing-userid',
    title='Membership check matches any active member of the workspace',
    dir='apps/api/src/workspaces',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'workspace-access.ts': (MEM_BASE, MEM_HEAD, MEM_BASE)},
    truth=[dict(id='membership-missing-userid/where-without-user', file='workspace-access.ts',
                anchor="where: { workspaceId, status: 'active' },", category='security', severity='high',
                changeType='introduced',
                description='The membership query no longer filters by userId: any caller passes as long as the workspace has an active member.',
                witness='an outsider passes the membership check')],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { assertWorkspaceMember as fixedAssert } from './fixed/workspace-access';
import { assertWorkspaceMember as headAssert } from './head/workspace-access';

const db = () => ({
  note: fakeTable([]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'owner', status: 'active' }]),
});

describe('membership-missing-userid ground truth', () => {
  it('an outsider passes the membership check', async () => {
    await expect(headAssert(db(), 'outsider', 'ws1')).resolves.toMatchObject({ userId: 'u1' });
    await expect(fixedAssert(db(), 'outsider', 'ws1')).rejects.toThrow('FORBIDDEN');
  });
});
""",
    candidates=[dict(
        key='mem-user', truth='membership-missing-userid/where-without-user', file='workspace-access.ts',
        claimed=("where: { workspaceId, status: 'active' },", 0), category='security', severity='high',
        changeType='introduced', title='Membership lookup ignores the acting user',
        explanation='The where clause lost userId, so any active member satisfies the check.',
        evidence="where: { workspaceId, status: 'active' },",
        trigger='A non-member calls an endpoint guarded by assertWorkspaceMember',
        failurePath='workspace-access.ts findFirst without userId → membership of another user',
        violatedInvariant='Only members of the workspace pass the check', impact='Authorization bypass',
        verify=dict(
            verdict='confirmed', severity='high',
            decisiveCode="where: { workspaceId, status: 'active' },\nreturn membership;",
            failure=('return membership;', 0),
            triggerSource='userId: string,',
            guards=[('if (!membership) {', 'It passes whenever ANY active member exists, because the query ignores userId.')],
            trigger='An outsider calls a guarded endpoint for ws1', invariant='Only members pass'),
        # Wrong refutation: quotes the (tenant-looking) where clause itself.
        adversarial=dict(verdict='refuted', severity='low',
                         decisiveCode="const membership = await db.membership.findFirst({\nwhere: { workspaceId, status: 'active' },"),
    )],
    security_regression=True,
)

# ── 4. membership query checks the wrong userId ────────────────────────────────────────
WRONG_BASE = NOTES_TYPES + """
export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {
  const note = await db.note.findUnique({ where: { id: noteId } });
  if (!note) {
    throw new Error('NOT_FOUND');
  }
  const membership = await db.membership.findFirst({
    where: { workspaceId: note.workspaceId, userId },
  });
  if (!membership) {
    throw new Error('FORBIDDEN');
  }
  await db.note.delete({ where: { id: noteId } });
}
"""
WRONG_HEAD = WRONG_BASE.replace('where: { workspaceId: note.workspaceId, userId },',
                                'where: { workspaceId: note.workspaceId, userId: note.authorId },')
case(
    id='membership-wrong-userid',
    title="Delete checks the author's membership instead of the caller's",
    dir='apps/api/src/notes',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'notes.service.ts': (WRONG_BASE, WRONG_HEAD, WRONG_BASE)},
    truth=[dict(id='membership-wrong-userid/author-instead-of-caller', file='notes.service.ts',
                anchor='userId: note.authorId', category='security', severity='high', changeType='introduced',
                description='The membership query uses note.authorId instead of the acting userId: anyone can delete a note whose author is a member.',
                witness='an outsider deletes a note whose author is a member')],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { deleteNote as fixedDelete } from './fixed/notes.service';
import { deleteNote as headDelete } from './head/notes.service';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'owner', status: 'active' }]),
});

describe('membership-wrong-userid ground truth', () => {
  it('an outsider deletes a note whose author is a member', async () => {
    const head = db();
    await headDelete(head, 'outsider', 'n1');
    expect(head.note.rows).toHaveLength(0);
    await expect(fixedDelete(db(), 'outsider', 'n1')).rejects.toThrow('FORBIDDEN');
  });
});
""",
    candidates=[dict(
        key='wrong-user', truth='membership-wrong-userid/author-instead-of-caller', file='notes.service.ts',
        claimed=('userId: note.authorId', 0), category='security', severity='high', changeType='introduced',
        title="deleteNote checks the author's membership, not the caller's",
        explanation='The where clause uses note.authorId, so the caller is never checked.',
        evidence='where: { workspaceId: note.workspaceId, userId: note.authorId },',
        trigger='An outsider deletes a note authored by a member', failurePath='membership lookup by authorId → delete',
        violatedInvariant='The acting user must be a member', impact='Unauthorized deletion',
        verify=dict(
            verdict='confirmed', severity='high',
            decisiveCode='where: { workspaceId: note.workspaceId, userId: note.authorId },\nawait db.note.delete({ where: { id: noteId } });',
            failure=('await db.note.delete', 0),
            triggerSource='export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {',
            guards=[('if (!note) {', 'Only rejects a missing note.'),
                    ('if (!membership) {', "It checks the author's membership, which exists, not the caller's.")],
            trigger='An outsider deletes a member-authored note', invariant='The caller must be a member'),
        adversarial=dict(verdict='refuted', severity='low',
                         decisiveCode="where: { workspaceId: note.workspaceId, userId: note.authorId },\nif (!membership) {\nthrow new Error('FORBIDDEN');"),
    )],
    security_regression=True,
)

# ── 5. guard condition inverted ────────────────────────────────────────────────────────
INV_HEAD = WRONG_BASE.replace('  if (!membership) {', '  if (membership) {')
case(
    id='guard-inverted',
    title='Membership guard condition inverted',
    dir='apps/api/src/notes',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'notes.service.ts': (WRONG_BASE, INV_HEAD, WRONG_BASE)},
    truth=[dict(id='guard-inverted/denies-members', file='notes.service.ts', anchor='  if (membership) {',
                category='security', severity='high', changeType='introduced',
                description='The guard throws for members and lets non-members through.',
                witness='an outsider deletes and a member is refused')],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { deleteNote as fixedDelete } from './fixed/notes.service';
import { deleteNote as headDelete } from './head/notes.service';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'owner', status: 'active' }]),
});

describe('guard-inverted ground truth', () => {
  it('an outsider deletes and a member is refused', async () => {
    const head = db();
    await headDelete(head, 'outsider', 'n1');
    expect(head.note.rows).toHaveLength(0);
    await expect(headDelete(db(), 'u1', 'n1')).rejects.toThrow('FORBIDDEN');
    await expect(fixedDelete(db(), 'outsider', 'n1')).rejects.toThrow('FORBIDDEN');
  });
});
""",
    candidates=[dict(
        key='inverted', truth='guard-inverted/denies-members', file='notes.service.ts',
        claimed=('  if (membership) {', 0), category='security', severity='high', changeType='introduced',
        title='Membership guard is inverted', explanation='The guard throws when a membership exists.',
        evidence='if (membership) {', trigger='An outsider deletes a ws1 note',
        failurePath='inverted guard → delete', violatedInvariant='Only members delete notes',
        impact='Authorization bypass for outsiders',
        verify=dict(
            verdict='confirmed', severity='high',
            decisiveCode='if (membership) {\nawait db.note.delete({ where: { id: noteId } });',
            failure=('await db.note.delete', 0),
            triggerSource='export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {',
            guards=[('if (!note) {', 'Only rejects a missing note.'),
                    ('if (membership) {', 'It is inverted: it denies members and lets non-members through.')],
            trigger='An outsider deletes a ws1 note', invariant='Only members delete notes'),
        adversarial=dict(verdict='refuted', severity='low',
                         decisiveCode="if (membership) {\nthrow new Error('FORBIDDEN');"),
    )],
    security_regression=True,
)

# ── 6. guard denies only one unauthorized role ─────────────────────────────────────────
ROLE_BASE = WRONG_BASE.replace(
    '  if (!membership) {',
    "  if (!membership || !['owner', 'editor'].includes(membership.role)) {")
ROLE_HEAD = WRONG_BASE.replace('  if (!membership) {', "  if (!membership || membership.role === 'viewer') {")
case(
    id='guard-one-role',
    title='Delete guard only refuses viewers (guests pass)',
    dir='apps/api/src/notes',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'notes.service.ts': (ROLE_BASE, ROLE_HEAD, ROLE_BASE)},
    truth=[dict(id='guard-one-role/guest-can-delete', file='notes.service.ts', anchor="membership.role === 'viewer'",
                category='security', severity='high', changeType='introduced',
                description="The guard denies only 'viewer'; a 'guest' member (no write permission) can delete notes.",
                witness='a guest member deletes a note')],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { deleteNote as fixedDelete } from './fixed/notes.service';
import { deleteNote as headDelete } from './head/notes.service';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'g1', role: 'guest', status: 'active' }]),
});

describe('guard-one-role ground truth', () => {
  it('a guest member deletes a note', async () => {
    const head = db();
    await headDelete(head, 'g1', 'n1');
    expect(head.note.rows).toHaveLength(0);
    await expect(fixedDelete(db(), 'g1', 'n1')).rejects.toThrow('FORBIDDEN');
  });
});
""",
    candidates=[dict(
        key='one-role', truth='guard-one-role/guest-can-delete', file='notes.service.ts',
        claimed=("membership.role === 'viewer'", 0), category='security', severity='high', changeType='introduced',
        title='Guard lets guests delete notes', explanation="Only 'viewer' is refused; 'guest' has no write permission.",
        evidence="if (!membership || membership.role === 'viewer') {", trigger='A guest member deletes a note',
        failurePath='role check → delete', violatedInvariant='Only owners and editors delete notes',
        impact='Privilege escalation for guests',
        verify=dict(
            verdict='confirmed', severity='high',
            decisiveCode="if (!membership || membership.role === 'viewer') {\nawait db.note.delete({ where: { id: noteId } });",
            failure=('await db.note.delete', 0),
            triggerSource='export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {',
            guards=[('if (!note) {', 'Only rejects a missing note.'),
                    ("if (!membership || membership.role === 'viewer') {", "It refuses only viewers; a guest membership passes.")],
            trigger='A guest deletes a note', invariant='Only owners and editors delete notes'),
        adversarial=dict(verdict='refuted', severity='low',
                         decisiveCode="if (!membership || membership.role === 'viewer') {\nthrow new Error('FORBIDDEN');"),
    )],
    security_regression=True,
)

# ── 7. real vulnerability inside defensive code ────────────────────────────────────────
SESSION_TYPES = """import type { Table } from './db';

/** `expiresAt` is epoch milliseconds. */
export type Session = { token: string; userId: string; expiresAt: number };
export type SessionDb = { session: Table<Session> };
"""
SESSION_BASE = SESSION_TYPES + """
export async function requireSession(db: SessionDb, token: string): Promise<Session> {
  const session = await db.session.findFirst({ where: { token } });
  if (!session || session.expiresAt < Date.now()) {
    throw new Error('UNAUTHORIZED');
  }
  return session;
}
"""
SESSION_HEAD = SESSION_BASE.replace('session.expiresAt < Date.now()', 'session.expiresAt < Date.now() / 1000')
case(
    id='defensive-guard-bug',
    title='Session expiry guard compares milliseconds with seconds',
    dir='apps/api/src/auth',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'session.guard.ts': (SESSION_BASE, SESSION_HEAD, SESSION_BASE)},
    truth=[dict(id='defensive-guard-bug/expired-session-accepted', file='session.guard.ts',
                anchor='Date.now() / 1000', category='security', severity='high', changeType='introduced',
                description='expiresAt is in milliseconds but is compared with seconds: an expired session is accepted.',
                witness='an expired session is accepted')],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { requireSession as fixedRequire } from './fixed/session.guard';
import { requireSession as headRequire } from './head/session.guard';

const db = () => ({
  session: fakeTable([{ token: 't1', userId: 'u1', expiresAt: Date.now() - 60_000 }]),
});

describe('defensive-guard-bug ground truth', () => {
  it('an expired session is accepted', async () => {
    await expect(headRequire(db(), 't1')).resolves.toMatchObject({ userId: 'u1' });
    await expect(fixedRequire(db(), 't1')).rejects.toThrow('UNAUTHORIZED');
  });
});
""",
    candidates=[dict(
        key='expiry', truth='defensive-guard-bug/expired-session-accepted', file='session.guard.ts',
        claimed=('Date.now() / 1000', 0), category='security', severity='high', changeType='introduced',
        title='Expired sessions pass the expiry check',
        explanation='expiresAt is milliseconds; dividing Date.now() by 1000 makes the expiry comparison never true.',
        evidence='if (!session || session.expiresAt < Date.now() / 1000) {',
        trigger='A request with a token that expired a minute ago', failurePath='expiry guard → return session',
        violatedInvariant='Expired sessions are rejected', impact='Session expiry is not enforced',
        verify=dict(
            verdict='confirmed', severity='high',
            decisiveCode='if (!session || session.expiresAt < Date.now() / 1000) {\nreturn session;',
            failure=('return session;', 0),
            triggerSource='export async function requireSession(db: SessionDb, token: string): Promise<Session> {',
            guards=[('if (!session || session.expiresAt < Date.now() / 1000) {',
                     'It compares a millisecond timestamp with seconds, so an expired session never matches.')],
            trigger='A token that expired a minute ago', invariant='Expired sessions are rejected'),
        adversarial=dict(verdict='refuted', severity='low',
                         decisiveCode="if (!session || session.expiresAt < Date.now() / 1000) {\nthrow new Error('UNAUTHORIZED');"),
    )],
    security_regression=True,
)

# ── 8. payment webhook idempotency ─────────────────────────────────────────────────────
HOOK_TYPES = """import type { Table } from './db';

export type Account = { id: string; credits: number };
export type WebhookEvent = { id: string };
export type PaymentEvent = { id: string; type: string; accountId: string; amount: number };
export type BillingDb = { account: Table<Account>; webhookEvent: Table<WebhookEvent> };
"""
HOOK_BASE = HOOK_TYPES + """
export async function handlePaymentWebhook(
  db: BillingDb,
  event: PaymentEvent,
): Promise<{ ok: boolean; duplicate?: boolean }> {
  if (event.type !== 'payment.succeeded') {
    return { ok: true };
  }
  const seen = await db.webhookEvent.findUnique({ where: { id: event.id } });
  if (seen) {
    return { ok: true, duplicate: true };
  }
  const account = await db.account.findUnique({ where: { id: event.accountId } });
  if (!account) {
    throw new Error('UNKNOWN_ACCOUNT');
  }
  await db.account.update({ where: { id: account.id }, data: { credits: account.credits + event.amount } });
  await db.webhookEvent.create({ data: { id: event.id } });
  return { ok: true };
}
"""
HOOK_HEAD = HOOK_BASE.replace("""  const seen = await db.webhookEvent.findUnique({ where: { id: event.id } });
  if (seen) {
    return { ok: true, duplicate: true };
  }
""", '')
case(
    id='webhook-idempotency',
    title='Payment webhook handler lost its duplicate-event check',
    dir='apps/api/src/billing',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'payment-webhook.ts': (HOOK_BASE, HOOK_HEAD, HOOK_BASE)},
    truth=[dict(id='webhook-idempotency/double-credit', file='payment-webhook.ts', anchor='await db.account.update',
                start_anchor='const account = await db.account.findUnique',
                category='data_integrity', severity='high', changeType='removed_safeguard',
                description='The processed-event check was removed: a redelivered webhook credits the account again.',
                witness='a redelivered event credits twice')],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { handlePaymentWebhook as fixedHandle } from './fixed/payment-webhook';
import { handlePaymentWebhook as headHandle } from './head/payment-webhook';

const event = { id: 'evt_1', type: 'payment.succeeded', accountId: 'a1', amount: 100 };
const db = () => ({ account: fakeTable([{ id: 'a1', credits: 0 }]), webhookEvent: fakeTable<{ id: string }>([]) });

describe('webhook-idempotency ground truth', () => {
  it('a redelivered event credits twice', async () => {
    const head = db();
    await headHandle(head, event);
    await headHandle(head, event);
    expect(head.account.rows[0]!.credits).toBe(200);
    const fixed = db();
    await fixedHandle(fixed, event);
    await expect(fixedHandle(fixed, event)).resolves.toMatchObject({ duplicate: true });
    expect(fixed.account.rows[0]!.credits).toBe(100);
  });
});
""",
    candidates=[dict(
        key='idempotency', truth='webhook-idempotency/double-credit', file='payment-webhook.ts',
        claimed=('await db.account.update', 0), category='data_integrity', severity='high',
        changeType='removed_safeguard', title='Redelivered payment webhooks credit the account again',
        explanation='The PR removed the processed-event lookup, so a duplicate delivery repeats the credit.',
        evidence='const seen = await db.webhookEvent.findUnique({ where: { id: event.id } });\nif (seen) {',
        trigger='The payment provider redelivers evt_1', failurePath='no dedupe → account.update twice',
        violatedInvariant='Each payment event is applied once', impact='Duplicate credits',
        verify=dict(
            verdict='confirmed', severity='high',
            decisiveCode='const account = await db.account.findUnique({ where: { id: event.accountId } });\nawait db.account.update({ where: { id: account.id }, data: { credits: account.credits + event.amount } });',
            failure=('await db.account.update', 0),
            triggerSource='event: PaymentEvent,',
            guards=[("if (event.type !== 'payment.succeeded') {", 'Filters event types only; the duplicate is a succeeded payment.'),
                    ('if (!account) {', 'Only rejects unknown accounts.')],
            trigger='The provider redelivers the same event id', invariant='Each event is applied once'),
    )],
)

# ── 9. race condition (lock removed) ───────────────────────────────────────────────────
SEAT_TYPES = """import type { Table } from './db';

export type Seat = { workspaceId: string; userId: string; role: string };
export type SeatDb = {
  membership: Table<Seat>;
  lock<R>(key: string, fn: () => Promise<R>): Promise<R>;
};
"""
SEAT_BASE = SEAT_TYPES + """
export async function addMember(
  db: SeatDb,
  workspaceId: string,
  userId: string,
  limit: number,
): Promise<void> {
  await db.lock(`seats:${workspaceId}`, async () => {
    const count = await db.membership.count({ where: { workspaceId } });
    if (count >= limit) {
      throw new Error('SEAT_LIMIT');
    }
    await db.membership.create({ data: { workspaceId, userId, role: 'member' } });
  });
}
"""
SEAT_HEAD = SEAT_TYPES + """
export async function addMember(
  db: SeatDb,
  workspaceId: string,
  userId: string,
  limit: number,
): Promise<void> {
  const count = await db.membership.count({ where: { workspaceId } });
  if (count >= limit) {
    throw new Error('SEAT_LIMIT');
  }
  await db.membership.create({ data: { workspaceId, userId, role: 'member' } });
}
"""
case(
    id='race-condition',
    title='Seat limit check-then-insert without the lock',
    dir='apps/api/src/workspaces',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'seats.ts': (SEAT_BASE, SEAT_HEAD, SEAT_BASE)},
    # The defect is the removed lock (base) and the now unserialized check-then-insert (head).
    truth=[dict(id='race-condition/seat-limit-exceeded', file='seats.ts', anchor='await db.membership.create',
                start_anchor='const count = await db.membership.count',
                removed_anchor='await db.lock(`seats:${workspaceId}`', removed_end_anchor='  });',
                category='data_integrity', severity='medium', changeType='removed_safeguard',
                description='The lock serializing the seat count and the insert was removed: concurrent invitations read the same count and exceed the seat limit.',
                witness='three concurrent adds exceed a limit of two')],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeLock, fakeTable } from '../../support/fake-db';
import { addMember as fixedAdd } from './fixed/seats';
import { addMember as headAdd } from './head/seats';

type Seat = { workspaceId: string; userId: string; role: string };
const db = () => ({ membership: fakeTable<Seat>([], { delayMs: 1 }), lock: fakeLock() });

describe('race-condition ground truth', () => {
  it('three concurrent adds exceed a limit of two', async () => {
    const head = db();
    await Promise.allSettled(['a', 'b', 'c'].map((u) => headAdd(head, 'ws1', u, 2)));
    expect(head.membership.rows).toHaveLength(3);
    const fixed = db();
    await Promise.allSettled(['a', 'b', 'c'].map((u) => fixedAdd(fixed, 'ws1', u, 2)));
    expect(fixed.membership.rows).toHaveLength(2);
  });
});
""",
    candidates=[dict(
        key='race', truth='race-condition/seat-limit-exceeded', file='seats.ts',
        claimed=('await db.membership.create', 0), category='data_integrity', severity='medium',
        changeType='introduced', title='Concurrent invitations can exceed the seat limit',
        explanation='The lock around count and create was removed; concurrent calls read the same count.',
        evidence="await db.membership.create({ data: { workspaceId, userId, role: 'member' } });",
        trigger='Two invitations for the last seat arrive at the same time', failurePath='count → (interleave) → create twice',
        violatedInvariant='Members never exceed the seat limit', impact='Seat limit bypass',
        verify=dict(
            verdict='confirmed', severity='medium',
            decisiveCode="const count = await db.membership.count({ where: { workspaceId } });\nawait db.membership.create({ data: { workspaceId, userId, role: 'member' } });",
            failure=('await db.membership.create', 0),
            triggerSource='limit: number,',
            guards=[('if (count >= limit) {', 'Concurrent calls all read the same count before any insert, so all pass.')],
            trigger='Concurrent invitations for the last seat', invariant='Members never exceed the limit'),
    )],
)

# ── 10. missing transaction boundary ───────────────────────────────────────────────────
TX_TYPES = """import type { Table } from './db';

export type Account = { id: string; credits: number };
export type LedgerDb = {
  account: Table<Account>;
  $transaction<R>(fn: (tx: { account: Table<Account> }) => Promise<R>): Promise<R>;
};
"""
TX_BASE = TX_TYPES + """
export async function transferCredits(
  db: LedgerDb,
  fromId: string,
  toId: string,
  amount: number,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const from = await tx.account.findUnique({ where: { id: fromId } });
    const to = await tx.account.findUnique({ where: { id: toId } });
    if (!from || !to || from.credits < amount) {
      throw new Error('INVALID_TRANSFER');
    }
    await tx.account.update({ where: { id: from.id }, data: { credits: from.credits - amount } });
    await tx.account.update({ where: { id: to.id }, data: { credits: to.credits + amount } });
  });
}
"""
TX_HEAD = TX_TYPES + """
export async function transferCredits(
  db: LedgerDb,
  fromId: string,
  toId: string,
  amount: number,
): Promise<void> {
  const from = await db.account.findUnique({ where: { id: fromId } });
  const to = await db.account.findUnique({ where: { id: toId } });
  if (!from || !to || from.credits < amount) {
    throw new Error('INVALID_TRANSFER');
  }
  await db.account.update({ where: { id: from.id }, data: { credits: from.credits - amount } });
  await db.account.update({ where: { id: to.id }, data: { credits: to.credits + amount } });
}
"""
case(
    id='missing-transaction',
    title='Credit transfer no longer runs in a transaction',
    dir='apps/api/src/billing',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'transfer.ts': (TX_BASE, TX_HEAD, TX_BASE)},
    truth=[dict(id='missing-transaction/partial-transfer', file='transfer.ts',
                anchor='await db.account.update({ where: { id: from.id }', category='data_integrity', severity='high',
                changeType='introduced',
                description='Debit and credit are separate writes: if the credit fails, the debit stays and credits are lost.',
                witness='a failed credit leaves the debit applied')],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { transferCredits as fixedTransfer } from './fixed/transfer';
import { transferCredits as headTransfer } from './head/transfer';

type Account = { id: string; credits: number };
function db() {
  const account = fakeTable<Account>(
    [
      { id: 'a', credits: 100 },
      { id: 'b', credits: 0 },
    ],
    { failWrite: (op, where) => op === 'update' && where?.id === 'b' },
  );
  return {
    account,
    async $transaction<R>(fn: (tx: { account: typeof account }) => Promise<R>): Promise<R> {
      const snapshot = account.rows.map((r) => ({ ...r }));
      try {
        return await fn({ account });
      } catch (error) {
        account.rows.splice(0, account.rows.length, ...snapshot);
        throw error;
      }
    },
  };
}

describe('missing-transaction ground truth', () => {
  it('a failed credit leaves the debit applied', async () => {
    const head = db();
    await expect(headTransfer(head, 'a', 'b', 40)).rejects.toThrow('WRITE_FAILED');
    expect(head.account.rows.find((r) => r.id === 'a')!.credits).toBe(60); // money lost
    const fixed = db();
    await expect(fixedTransfer(fixed, 'a', 'b', 40)).rejects.toThrow('WRITE_FAILED');
    expect(fixed.account.rows.find((r) => r.id === 'a')!.credits).toBe(100);
  });
});
""",
    candidates=[dict(
        key='tx', truth='missing-transaction/partial-transfer', file='transfer.ts',
        claimed=('await db.account.update({ where: { id: from.id }', 0), category='data_integrity', severity='high',
        changeType='introduced', title='Transfer debits without a transaction',
        explanation='The $transaction wrapper was removed; a failed credit leaves the debit applied.',
        evidence='await db.account.update({ where: { id: from.id }, data: { credits: from.credits - amount } });',
        trigger='The credit update fails (constraint, timeout) after the debit',
        failurePath='debit committed → credit throws', violatedInvariant='A transfer applies both writes or neither',
        impact='Lost credits',
        verify=dict(
            verdict='confirmed', severity='high',
            decisiveCode='await db.account.update({ where: { id: from.id }, data: { credits: from.credits - amount } });\nawait db.account.update({ where: { id: to.id }, data: { credits: to.credits + amount } });',
            failure=('await db.account.update({ where: { id: to.id }', 0),
            triggerSource='amount: number,',
            guards=[('if (!from || !to || from.credits < amount) {', 'Validates input only; it cannot undo a debit when the later credit fails.')],
            trigger='The credit update throws after the debit', invariant='Both writes or neither'),
    )],
)

# ── 11. incorrect null handling + swallowed error ──────────────────────────────────────
NOTIFY_TYPES = """import type { Table } from './db';

export type User = { workspaceId: string; role: string; email: string; displayName?: string | null };
export type Mailer = { send(to: string, body: string): Promise<void> };
"""
NOTIFY_BASE = NOTIFY_TYPES + """
export async function notifyOwner(
  db: { user: Table<User> },
  mailer: Mailer,
  workspaceId: string,
): Promise<{ sent: boolean }> {
  const owner = await db.user.findFirst({ where: { workspaceId, role: 'owner' } });
  if (!owner) {
    return { sent: false };
  }
  const name = owner.displayName?.trim() ?? 'there';
  await mailer.send(owner.email, `Hello ${name}`);
  return { sent: true };
}
"""
NOTIFY_HEAD = NOTIFY_TYPES + """
export async function notifyOwner(
  db: { user: Table<User> },
  mailer: Mailer,
  workspaceId: string,
): Promise<{ sent: boolean }> {
  const owner = await db.user.findFirst({ where: { workspaceId, role: 'owner' } });
  const name = owner!.displayName!.trim();
  try {
    await mailer.send(owner!.email, `Hello ${name}`);
  } catch {
    // Mail failures are not fatal.
  }
  return { sent: true };
}
"""
case(
    id='null-and-swallowed',
    title='Owner notification: null owner crash and swallowed send failure',
    dir='apps/api/src/notifications',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'notify.ts': (NOTIFY_BASE, NOTIFY_HEAD, NOTIFY_BASE)},
    truth=[
        dict(id='null-and-swallowed/null-owner', file='notify.ts', anchor='const name = owner!.displayName!.trim();',
             category='correctness', severity='medium', changeType='introduced',
             description='A workspace without an owner (or an owner without displayName) throws a TypeError.',
             witness='a workspace without an owner crashes'),
        dict(id='null-and-swallowed/swallowed-send', file='notify.ts', anchor='} catch {', span=3,
             category='correctness', severity='medium', changeType='introduced',
             description='A failed send is swallowed and reported as sent: true.',
             witness='a failed send is reported as sent'),
    ],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { notifyOwner as fixedNotify } from './fixed/notify';
import { notifyOwner as headNotify } from './head/notify';

type User = { workspaceId: string; role: string; email: string; displayName?: string | null };
const ok = { send: async () => undefined };
const failing = {
  send: async () => {
    throw new Error('SMTP_DOWN');
  },
};

describe('null-and-swallowed ground truth', () => {
  it('a workspace without an owner crashes', async () => {
    const db = { user: fakeTable<User>([]) };
    await expect(headNotify(db, ok, 'ws1')).rejects.toThrow(TypeError);
    await expect(fixedNotify(db, ok, 'ws1')).resolves.toEqual({ sent: false });
  });

  it('a failed send is reported as sent', async () => {
    const db = () => ({
      user: fakeTable<User>([{ workspaceId: 'ws1', role: 'owner', email: 'o@x', displayName: 'Ann' }]),
    });
    await expect(headNotify(db(), failing, 'ws1')).resolves.toEqual({ sent: true });
    await expect(fixedNotify(db(), failing, 'ws1')).rejects.toThrow('SMTP_DOWN');
  });
});
""",
    candidates=[
        dict(key='null', truth='null-and-swallowed/null-owner', file='notify.ts',
             claimed=('const name = owner!.displayName!.trim();', 0), category='correctness', severity='medium',
             changeType='introduced', title='notifyOwner crashes when the workspace has no owner',
             explanation='findFirst can return null and displayName is optional; both are dereferenced.',
             evidence='const name = owner!.displayName!.trim();', trigger='A workspace whose owner left',
             failurePath='findFirst → null → owner!.displayName', violatedInvariant='notifyOwner never throws on missing data',
             impact='Notification job crashes',
             verify=dict(
                 verdict='confirmed', severity='medium',
                 decisiveCode="const owner = await db.user.findFirst({ where: { workspaceId, role: 'owner' } });\nconst name = owner!.displayName!.trim();",
                 failure=('const name = owner!.displayName!.trim();', 0),
                 triggerSource="const owner = await db.user.findFirst({ where: { workspaceId, role: 'owner' } });",
                 guards=[], trigger='A workspace without an owner', invariant='No crash on a missing owner')),
        dict(key='swallowed', truth='null-and-swallowed/swallowed-send', file='notify.ts',
             claimed=('} catch {', 0), category='correctness', severity='medium', changeType='introduced',
             title='Failed notification emails are reported as sent',
             explanation='The catch block ignores the send error and the function returns sent: true.',
             evidence='} catch {\n// Mail failures are not fatal.', trigger='The SMTP server is down',
             failurePath='send throws → catch → return { sent: true }', violatedInvariant='sent reflects delivery',
             impact='Silent loss of owner notifications',
             verify=dict(
                 verdict='confirmed', severity='medium',
                 decisiveCode='} catch {\nreturn { sent: true };',
                 failure=('return { sent: true };', 0),
                 triggerSource='mailer: Mailer,',
                 guards=[('} catch {', 'It swallows the send error and falls through to return sent: true.')],
                 trigger='mailer.send rejects', invariant='sent reflects delivery')),
    ],
)

# ── 12. broken fallback + incorrect async handling ─────────────────────────────────────
SYNC_BASE = """export type SyncConfig = { retryDelayMs?: number };
export type Item = { id: string };

export const DEFAULT_RETRY_DELAY_MS = 1000;

export function retryDelay(config: SyncConfig): number {
  return config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
}

export async function syncAll(
  items: Item[],
  save: (item: Item) => Promise<void>,
): Promise<{ synced: number }> {
  for (const item of items) {
    await save(item);
  }
  return { synced: items.length };
}
"""
SYNC_HEAD = """export type SyncConfig = { retryDelayMs?: number };
export type Item = { id: string };

export const DEFAULT_RETRY_DELAY_MS = 1000;

export function retryDelay(config: SyncConfig): number {
  return config.retryDelayMs || DEFAULT_RETRY_DELAY_MS;
}

export async function syncAll(
  items: Item[],
  save: (item: Item) => Promise<void>,
): Promise<{ synced: number }> {
  items.forEach(async (item) => {
    await save(item);
  });
  return { synced: items.length };
}
"""
case(
    id='fallback-and-async',
    title='Sync: retry delay fallback and fire-and-forget saves',
    dir='apps/api/src/sync',
    files={'sync.ts': (SYNC_BASE, SYNC_HEAD, SYNC_BASE)},
    truth=[
        dict(id='fallback-and-async/zero-delay-overridden', file='sync.ts',
             anchor='return config.retryDelayMs || DEFAULT_RETRY_DELAY_MS;', category='correctness',
             severity='medium', changeType='introduced',
             description='`||` replaces a configured retryDelayMs of 0 (retry immediately) with the 1000 ms default.',
             witness='a configured delay of 0 is replaced'),
        dict(id='fallback-and-async/unawaited-saves', file='sync.ts', anchor='items.forEach(async (item) => {', span=3,
             category='correctness', severity='medium', changeType='introduced',
             description='forEach does not await the async callbacks: syncAll reports success before saves finish and their errors are unhandled.',
             witness='syncAll resolves before the saves complete'),
    ],
    witness="""import { describe, expect, it } from 'vitest';

import { retryDelay as fixedDelay, syncAll as fixedSync } from './fixed/sync';
import { retryDelay as headDelay, syncAll as headSync } from './head/sync';

describe('fallback-and-async ground truth', () => {
  it('a configured delay of 0 is replaced', () => {
    expect(headDelay({ retryDelayMs: 0 })).toBe(1000);
    expect(fixedDelay({ retryDelayMs: 0 })).toBe(0);
  });

  it('syncAll resolves before the saves complete', async () => {
    const saved: string[] = [];
    const save = async (item: { id: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      saved.push(item.id);
    };
    await headSync([{ id: 'a' }, { id: 'b' }], save);
    expect(saved).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    saved.length = 0;
    await fixedSync([{ id: 'a' }, { id: 'b' }], save);
    expect(saved).toEqual(['a', 'b']);
  });
});
""",
    candidates=[
        dict(key='fallback', truth='fallback-and-async/zero-delay-overridden', file='sync.ts',
             claimed=('return config.retryDelayMs || DEFAULT_RETRY_DELAY_MS;', 0), category='correctness',
             severity='medium', changeType='introduced', title='A retry delay of 0 is replaced by the default',
             explanation='`||` treats 0 as missing.', evidence='return config.retryDelayMs || DEFAULT_RETRY_DELAY_MS;',
             trigger='retryDelayMs is configured as 0', failurePath='retryDelay returns 1000',
             violatedInvariant='A configured delay is respected', impact='Retries are delayed against configuration',
             verify=dict(
                 verdict='confirmed', severity='medium',
                 decisiveCode='export function retryDelay(config: SyncConfig): number {\nreturn config.retryDelayMs || DEFAULT_RETRY_DELAY_MS;',
                 failure=('return config.retryDelayMs || DEFAULT_RETRY_DELAY_MS;', 0),
                 triggerSource='export function retryDelay(config: SyncConfig): number {',
                 guards=[('return config.retryDelayMs || DEFAULT_RETRY_DELAY_MS;', 'The || fallback treats a configured 0 as missing and returns 1000.')],
                 trigger='retryDelayMs = 0', invariant='Configured delays are respected')),
        dict(key='async', truth='fallback-and-async/unawaited-saves', file='sync.ts',
             claimed=('items.forEach(async (item) => {', 0), category='correctness', severity='medium',
             changeType='introduced', title='syncAll does not wait for saves',
             explanation='forEach ignores the promises returned by the async callback.',
             evidence='items.forEach(async (item) => {', trigger='syncAll is called with items',
             failurePath='forEach → return before saves', violatedInvariant='syncAll resolves after all saves',
             impact='Lost writes and unhandled rejections',
             verify=dict(
                 verdict='confirmed', severity='medium',
                 decisiveCode='items.forEach(async (item) => {\nreturn { synced: items.length };',
                 failure=('return { synced: items.length };', 0),
                 triggerSource='items: Item[],',
                 guards=[], trigger='Any non-empty items array', invariant='Resolve after all saves')),
    ],
)

# ── 13. clean defensive-code PR ────────────────────────────────────────────────────────
MEMBERS_TYPES = """import type { Table } from './db';

export type Membership = { workspaceId: string; userId: string; role: string };
export type Logger = { error(message: string, error: unknown): void };
"""
MEMBERS_BASE = MEMBERS_TYPES + """
export async function removeMember(
  db: { membership: Table<Membership> },
  workspaceId: string,
  memberId: string,
): Promise<{ removed: boolean }> {
  await db.membership.delete({ where: { workspaceId, userId: memberId } });
  return { removed: true };
}
"""
MEMBERS_HEAD = MEMBERS_TYPES + """
export async function removeMember(
  db: { membership: Table<Membership> },
  logger: Logger,
  actorId: string,
  workspaceId: string,
  memberId: string,
): Promise<{ removed: boolean }> {
  const actor = await db.membership.findFirst({ where: { workspaceId, userId: actorId } });
  if (!actor || actor.role !== 'owner') {
    throw new Error('FORBIDDEN');
  }
  const target = await db.membership.findFirst({ where: { workspaceId, userId: memberId } });
  if (!target) {
    return { removed: false };
  }
  try {
    await db.membership.delete({ where: { workspaceId, userId: memberId } });
  } catch (error) {
    logger.error('member removal failed', error);
    throw error;
  }
  return { removed: true };
}

export function displayName(user: { displayName?: string | null; email: string }): string {
  return user.displayName?.trim() || user.email;
}
"""
case(
    id='clean-defensive',
    title='Hardening: owner-only member removal, safe fallbacks (no bug)',
    dir='apps/api/src/members',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'members.service.ts': (MEMBERS_BASE, MEMBERS_HEAD, None)},
    truth=[],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { displayName, removeMember } from './head/members.service';

type Membership = { workspaceId: string; userId: string; role: string };
const logger = { error: () => undefined };
const db = () => ({
  membership: fakeTable<Membership>([
    { workspaceId: 'ws1', userId: 'owner', role: 'owner' },
    { workspaceId: 'ws1', userId: 'ed', role: 'editor' },
    { workspaceId: 'ws1', userId: 'm1', role: 'member' },
  ]),
});

describe('clean-defensive ground truth (no defect)', () => {
  it('only owners remove members; non-members and editors are refused', async () => {
    await expect(removeMember(db(), logger, 'owner', 'ws1', 'm1')).resolves.toEqual({ removed: true });
    await expect(removeMember(db(), logger, 'ed', 'ws1', 'm1')).rejects.toThrow('FORBIDDEN');
    await expect(removeMember(db(), logger, 'outsider', 'ws1', 'm1')).rejects.toThrow('FORBIDDEN');
  });

  it('a missing target is reported, failures are logged and rethrown, display names fall back', async () => {
    await expect(removeMember(db(), logger, 'owner', 'ws1', 'ghost')).resolves.toEqual({ removed: false });
    const failing = {
      membership: fakeTable<Membership>(db().membership.rows, { failWrite: () => true }),
    };
    const errors: unknown[] = [];
    await expect(
      removeMember(failing, { error: (_m, e) => void errors.push(e) }, 'owner', 'ws1', 'm1'),
    ).rejects.toThrow('WRITE_FAILED');
    expect(errors).toHaveLength(1);
    expect(displayName({ displayName: '  ', email: 'a@x' })).toBe('a@x');
  });
});
""",
    candidates=[
        dict(key='fp-guard', truth=None, file='members.service.ts', claimed=("if (!actor || actor.role !== 'owner') {", 0),
             category='security', severity='medium', changeType='introduced',
             title='Owner check may not handle role changes', explanation='It is unclear whether role changes are handled.',
             evidence="if (!actor || actor.role !== 'owner') {", trigger='The actor role changes',
             failurePath='members.service.ts guard', violatedInvariant='Only owners remove members',
             impact='Possible unauthorized removal',
             verify=dict(verdict='refuted', severity='low',
                         decisiveCode="if (!actor || actor.role !== 'owner') {\nthrow new Error('FORBIDDEN');")),
        dict(key='fp-null', truth=None, file='members.service.ts', claimed=('return { removed: false };', 0),
             category='correctness', severity='medium', changeType='introduced',
             title='Missing member is silently ignored', explanation='The function may silently return.',
             evidence='return { removed: false };', trigger='The member does not exist',
             failurePath='target null → removed false', violatedInvariant='Errors are surfaced',
             impact='Callers may not notice', verify=dict(
                 verdict='confirmed', severity='medium', decisiveCode='return { removed: false };',
                 failure=('return { removed: false };', 0), triggerSource='memberId: string,', guards=[],
                 trigger='Removing a missing member', invariant='Errors are surfaced')),
        dict(key='fp-catch', truth=None, file='members.service.ts', claimed=('} catch (error) {', 0),
             category='robustness', severity='medium', changeType='introduced',
             title='Removal errors are only logged', explanation='The catch block could hide failures.',
             evidence='} catch (error) {\nlogger.error(\'member removal failed\', error);',
             trigger='The delete fails', failurePath='catch → log', violatedInvariant='Failures propagate',
             impact='Hidden failures', verify=dict(verdict='insufficient_context', severity='medium', decisiveCode='')),
    ],
)

# ── 14. clean refactoring PR ───────────────────────────────────────────────────────────
INV_BASE = """export type LineItem = { unitPrice: number; quantity: number };

export function invoiceTotal(items: LineItem[]): number {
  let total = 0;
  for (const item of items) {
    total += Math.round(item.unitPrice * item.quantity * 100) / 100;
  }
  return Math.round(total * 100) / 100;
}
"""
INV_HEAD = """export type LineItem = { unitPrice: number; quantity: number };

export function lineTotal(item: LineItem): number {
  return Math.round(item.unitPrice * item.quantity * 100) / 100;
}

export function invoiceTotal(items: LineItem[]): number {
  const sum = items.reduce((acc, item) => acc + lineTotal(item), 0);
  return Math.round(sum * 100) / 100;
}
"""
case(
    id='clean-refactor',
    title='Refactor: extract lineTotal (no behavior change)',
    dir='apps/api/src/invoices',
    files={'invoice-total.ts': (INV_BASE, INV_HEAD, None)},
    truth=[],
    witness="""import { describe, expect, it } from 'vitest';

import { invoiceTotal as baseTotal } from './base/invoice-total';
import { invoiceTotal as headTotal } from './head/invoice-total';

describe('clean-refactor ground truth (no behavior change)', () => {
  it('produces the same totals as before for representative invoices', () => {
    const invoices = [
      [],
      [{ unitPrice: 0.1, quantity: 3 }],
      [
        { unitPrice: 19.99, quantity: 3 },
        { unitPrice: 0.333, quantity: 7 },
      ],
      [{ unitPrice: 1e6, quantity: 1.5 }],
    ];
    for (const items of invoices) expect(headTotal(items)).toBe(baseTotal(items));
  });
});
""",
    candidates=[dict(
        key='fp-refactor', truth=None, file='invoice-total.ts',
        claimed=('return Math.round(item.unitPrice * item.quantity * 100) / 100;', 0), category='correctness',
        severity='medium', changeType='introduced', title='Refactor may change invoice rounding',
        explanation='Moving the rounding into lineTotal could change totals.',
        evidence='return Math.round(item.unitPrice * item.quantity * 100) / 100;',
        trigger='Invoices with fractional prices', failurePath='lineTotal rounding',
        violatedInvariant='Totals are unchanged by the refactor', impact='Wrong invoice totals',
        verify=dict(verdict='refuted', severity='low',
                    decisiveCode='return Math.round(item.unitPrice * item.quantity * 100) / 100;\nconst sum = items.reduce((acc, item) => acc + lineTotal(item), 0);'),
    )],
)

# ── 15. Project Memory contamination ───────────────────────────────────────────────────
SPEC_BASE = None
SPEC_HEAD = """import { describe, expect, it } from 'vitest';

import { invoiceTotal } from './invoice-total';

const PAYMENT_RULE = 'All payment webhook handlers must be idempotent.';

describe('invoice totals (billing)', () => {
  it('sums line items for the payments repository', () => {
    expect(PAYMENT_RULE.length).toBeGreaterThan(0);
    expect(invoiceTotal([{ unitPrice: 2, quantity: 3 }])).toBe(6);
  });
});
"""
case(
    id='memory-contamination',
    title='Billing test added; Project Memory rule about webhooks (no bug)',
    dir='apps/api/src/invoices',
    files={'invoice-total.ts': (INV_HEAD, INV_HEAD, None),
           'invoice-total.spec.ts': (SPEC_BASE, SPEC_HEAD, None)},
    physical={'invoice-total.spec.ts': 'invoice-total.spec.fixture.ts'},
    truth=[],
    memory='- [high] (USER_PREFERENCE) payment-idempotency: All payment webhook handlers must be idempotent. Duplicate webhook events must never cause duplicate billing operations.',
    witness="""import { describe, expect, it } from 'vitest';

import { invoiceTotal } from './head/invoice-total';

describe('memory-contamination ground truth (no defect)', () => {
  it('the added test only exercises invoice totals; no payment handler exists in the PR', () => {
    expect(invoiceTotal([{ unitPrice: 2, quantity: 3 }])).toBe(6);
  });
});
""",
    candidates=[dict(
        key='fp-memory', truth=None, file='invoice-total.spec.ts', claimed=("const PAYMENT_RULE = 'All payment webhook handlers must be idempotent.';", 0),
        category='correctness', severity='medium', changeType='introduced',
        title='Ensuring Idempotence for Payment Webhook Handlers',
        explanation='Payment webhook handlers must be idempotent to avoid duplicate billing.',
        evidence="const PAYMENT_RULE = 'All payment webhook handlers must be idempotent.';",
        trigger='Duplicate payment webhook event', failurePath='billing test',
        violatedInvariant='Webhooks are idempotent', impact='Multiple charges for one event',
        verify=dict(verdict='confirmed', severity='high', decisiveCode='never reached',
                    failure=('describe(', 0), triggerSource='', guards=[], trigger='x' * 20, invariant='y' * 20),
    )],
)


# ── 17. moved guard (clean refactor; a "removed safeguard" claim is false) ────────────
MOVED_BASE = NOTES_TYPES + """
export async function archiveNote(db: NotesDb, userId: string, noteId: string): Promise<void> {
  const membership = await db.membership.findFirst({
    where: { workspaceId: 'ws1', userId },
  });
  if (!membership) {
    throw new Error('FORBIDDEN');
  }
  const note = await db.note.findUnique({ where: { id: noteId } });
  if (!note) {
    throw new Error('NOT_FOUND');
  }
  await db.note.update({ where: { id: noteId }, data: { archived: true } });
}
"""
MOVED_HEAD = NOTES_TYPES + """
export async function archiveNote(db: NotesDb, userId: string, noteId: string): Promise<void> {
  const note = await db.note.findUnique({ where: { id: noteId } });
  if (!note) {
    throw new Error('NOT_FOUND');
  }
  const membership = await db.membership.findFirst({
    where: { workspaceId: note.workspaceId, userId },
  });
  if (!membership) {
    throw new Error('FORBIDDEN');
  }
  await db.note.update({ where: { id: noteId }, data: { archived: true } });
}
"""
case(
    id='moved-guard',
    title='Refactor moves the membership guard below the note lookup (no bug)',
    dir='apps/api/src/notes',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'archive.ts': (MOVED_BASE, MOVED_HEAD, None)},
    truth=[],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { archiveNote } from './head/archive';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'owner', status: 'active' }]),
});

describe('moved-guard ground truth (no defect)', () => {
  it('the membership guard still runs before the update', async () => {
    await expect(archiveNote(db(), 'outsider', 'n1')).rejects.toThrow('FORBIDDEN');
    const ok = db();
    await archiveNote(ok, 'u1', 'n1');
    expect(ok.note.rows[0]!.archived).toBe(true);
  });
});
""",
    candidates=[dict(
        key='fp-moved', truth=None, file='archive.ts', claimed=('if (!membership) {', 0),
        category='security', severity='high', changeType='removed_safeguard',
        title='Membership check removed from archiveNote',
        explanation='The membership guard at the top of archiveNote was deleted.',
        evidence="if (!membership) {\nthrow new Error('FORBIDDEN');",
        trigger='A non-member archives a note', failurePath='archiveNote update without membership',
        violatedInvariant='Only members archive notes', impact='Unauthorized archive',
        verify=dict(verdict='refuted', severity='low',
                    decisiveCode="if (!membership) {\nthrow new Error('FORBIDDEN');\nawait db.note.update({ where: { id: noteId }, data: { archived: true } });"),
    )],
)

# ── 18. correct helper called with the wrong user (identity aliasing) ─────────────────
HELPER_TS = NOTES_TYPES + """
export async function findMembership(
  db: NotesDb,
  memberUserId: string,
  workspaceId: string,
): Promise<Membership | null> {
  return db.membership.findFirst({
    where: { workspaceId, userId: memberUserId, status: 'active' },
  });
}
"""
HW_BASE = """import { findMembership } from './membership';
import type { NotesDb } from './membership';

export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {
  const note = await db.note.findUnique({ where: { id: noteId } });
  if (!note) {
    throw new Error('NOT_FOUND');
  }
  const membership = await findMembership(db, userId, note.workspaceId);
  if (!membership) {
    throw new Error('FORBIDDEN');
  }
  await db.note.delete({ where: { id: noteId } });
}
"""
HW_HEAD = HW_BASE.replace('await findMembership(db, userId, note.workspaceId);',
                          'await findMembership(db, note.authorId, note.workspaceId);')
case(
    id='helper-wrong-user',
    title="A correct membership helper is called with the author's id",
    dir='apps/api/src/notes',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'membership.ts': (HELPER_TS, HELPER_TS, HELPER_TS),
           'delete-note.ts': (HW_BASE, HW_HEAD, HW_BASE)},
    truth=[dict(id='helper-wrong-user/author-passed-as-member', file='delete-note.ts',
                anchor='findMembership(db, note.authorId', category='security', severity='high',
                changeType='introduced',
                description="findMembership is called with note.authorId: the caller is never checked, so anyone can delete a note whose author is a member.",
                witness='an outsider deletes a note through the helper')],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { deleteNote as fixedDelete } from './fixed/delete-note';
import { deleteNote as headDelete } from './head/delete-note';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'owner', status: 'active' }]),
});

describe('helper-wrong-user ground truth', () => {
  it('an outsider deletes a note through the helper', async () => {
    const head = db();
    await headDelete(head, 'outsider', 'n1');
    expect(head.note.rows).toHaveLength(0);
    await expect(fixedDelete(db(), 'outsider', 'n1')).rejects.toThrow('FORBIDDEN');
  });
});
""",
    candidates=[dict(
        key='helper-user', truth='helper-wrong-user/author-passed-as-member', file='delete-note.ts',
        claimed=('findMembership(db, note.authorId', 0), category='security', severity='high',
        changeType='introduced', title="deleteNote checks the author's membership through the helper",
        explanation='findMembership receives note.authorId instead of the acting userId.',
        evidence='const membership = await findMembership(db, note.authorId, note.workspaceId);',
        trigger='An outsider deletes a member-authored note', failurePath='findMembership(author) → delete',
        violatedInvariant='The acting user must be a member', impact='Unauthorized deletion',
        verify=dict(
            verdict='confirmed', severity='high',
            decisiveCode='const membership = await findMembership(db, note.authorId, note.workspaceId);\nawait db.note.delete({ where: { id: noteId } });',
            failure=('await db.note.delete', 0),
            triggerSource='export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {',
            guards=[('if (!note) {', 'Only rejects a missing note.'),
                    ('if (!membership) {', "It tests the author's membership (found), never the caller's.")],
            trigger='An outsider deletes a member-authored note', invariant='The caller must be a member'),
        adversarial=dict(verdict='refuted', severity='low',
                         decisiveCode="if (!membership) {\nthrow new Error('FORBIDDEN');"),
    )],
    security_regression=True,
)


# ── 19/20. identity taken from the request body vs the authenticated principal ────────
REQ_TYPES = """import type { Table } from './db';

export type Note = { id: string; workspaceId: string; authorId: string; archived: boolean };
export type Membership = { workspaceId: string; userId: string; role: string; status: string };
export type NotesDb = { note: Table<Note>; membership: Table<Membership> };
/** `user` is set by the authentication middleware; `body` is client input. */
export type Request = { user: { id: string }; body: { userId?: string; noteId: string } };
"""
def req_handler(identity):
    return REQ_TYPES + f"""
export async function deleteNoteHandler(db: NotesDb, req: Request): Promise<void> {{
  const userId = {identity};
  const note = await db.note.findUnique({{ where: {{ id: req.body.noteId }} }});
  if (!note) {{
    throw new Error('NOT_FOUND');
  }}
  const membership = await db.membership.findFirst({{
    where: {{ workspaceId: note.workspaceId, userId }},
  }});
  if (!membership) {{
    throw new Error('FORBIDDEN');
  }}
  await db.note.delete({{ where: {{ id: note.id }} }});
}}
"""
REQ_BASE = req_handler('req.user.id')
REQ_HEAD = req_handler("req.body.userId ?? req.user.id")
REQ_WITNESS_DB = """const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'owner', status: 'active' }]),
});"""
case(
    id='request-body-userid',
    title='Delete handler takes the acting user id from the request body',
    dir='apps/api/src/notes',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'notes.handler.ts': (REQ_BASE, REQ_HEAD, REQ_BASE)},
    truth=[dict(id='request-body-userid/client-chosen-identity', file='notes.handler.ts',
                start_anchor='const userId = req.body.userId',
                anchor='where: { workspaceId: note.workspaceId, userId },', category='security', severity='high',
                changeType='introduced',
                description='The membership check uses req.body.userId (client input) instead of the authenticated req.user.id: an attacker names a member and deletes notes.',
                witness='an outsider deletes a note by naming a member in the body')],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { deleteNoteHandler as fixedDelete } from './fixed/notes.handler';
import { deleteNoteHandler as headDelete } from './head/notes.handler';

""" + REQ_WITNESS_DB + """

describe('request-body-userid ground truth', () => {
  it('an outsider deletes a note by naming a member in the body', async () => {
    const attack = { user: { id: 'outsider' }, body: { userId: 'u1', noteId: 'n1' } };
    const head = db();
    await headDelete(head, attack);
    expect(head.note.rows).toHaveLength(0);
    await expect(fixedDelete(db(), attack)).rejects.toThrow('FORBIDDEN');
  });
});
""",
    candidates=[dict(
        key='body-user', truth='request-body-userid/client-chosen-identity', file='notes.handler.ts',
        claimed=('where: { workspaceId: note.workspaceId, userId },', 0), category='security', severity='high',
        changeType='introduced', title='Membership check trusts a user id from the request body',
        explanation='The membership lookup filters by userId, which comes from req.body (client input).',
        evidence='const userId = req.body.userId ?? req.user.id;',
        trigger='An outsider sends body.userId of a workspace member', failurePath='body userId → membership → delete',
        violatedInvariant='Authorization uses the authenticated principal', impact='Authorization bypass',
        verify=dict(
            verdict='confirmed', severity='high',
            decisiveCode='const userId = req.body.userId ?? req.user.id;\nawait db.note.delete({ where: { id: note.id } });',
            failure=('await db.note.delete', 0),
            triggerSource='const userId = req.body.userId ?? req.user.id;',
            guards=[('const userId = req.body.userId ?? req.user.id;',
                     'The ?? fallback only applies when body.userId is absent; an attacker supplies it.'),
                    ('if (!note) {', 'Only rejects a missing note.'),
                    ('if (!membership) {', 'It checks the membership of the user named in the body, not the authenticated caller.')],
            trigger='An outsider names a member in body.userId', invariant='Authorization uses the authenticated principal'),
        # Wrong refutation: "the lookup is scoped to the workspace and the user".
        adversarial=dict(verdict='refuted', severity='low',
                         decisiveCode='const membership = await db.membership.findFirst({\nwhere: { workspaceId: note.workspaceId, userId },'),
    )],
    security_regression=True,
)
case(
    id='request-principal-userid',
    title='Delete handler uses the authenticated principal (no bug)',
    dir='apps/api/src/notes',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'notes.handler.ts': (None, REQ_BASE, None)},
    truth=[],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { deleteNoteHandler } from './head/notes.handler';

""" + REQ_WITNESS_DB + """

describe('request-principal-userid ground truth (no defect)', () => {
  it('a body userId cannot impersonate a member; the authenticated member can delete', async () => {
    await expect(
      deleteNoteHandler(db(), { user: { id: 'outsider' }, body: { userId: 'u1', noteId: 'n1' } }),
    ).rejects.toThrow('FORBIDDEN');
    const ok = db();
    await deleteNoteHandler(ok, { user: { id: 'u1' }, body: { noteId: 'n1' } });
    expect(ok.note.rows).toHaveLength(0);
  });
});
""",
    candidates=[dict(
        key='fp-principal', truth=None, file='notes.handler.ts',
        claimed=('where: { workspaceId: note.workspaceId, userId },', 0),
        category='security', severity='high', changeType='introduced',
        title='Membership check may use the wrong user',
        explanation='It is unclear whether the membership lookup uses the authenticated user.',
        evidence='where: { workspaceId: note.workspaceId, userId },', trigger='A user deletes another workspace note',
        failurePath='membership check', violatedInvariant='Only members delete notes', impact='Possible bypass',
        # The same answer the adversarial verifier gives for the body-userid bug.
        verify=dict(verdict='refuted', severity='low',
                    decisiveCode='const membership = await db.membership.findFirst({\nwhere: { workspaceId: note.workspaceId, userId },'),
    )],
)


# Hardening cases: vulnerable/safe pairs and verifier adversaries.
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cases_hardening.py')).read())


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)


def git_patch(base_text, head_text, logical):
    """Unified diff base→head with repository paths (git diff --no-index)."""
    tmp = os.path.join(BENCH, '.tmp-diff')
    os.makedirs(tmp, exist_ok=True)
    a = os.path.join(tmp, 'a')
    b = os.path.join(tmp, 'b')
    write(a, base_text or '')
    write(b, head_text)
    args = ['git', 'diff', '--no-index', '--unified=3', '--no-color', 'a' if base_text is not None else '/dev/null', 'b']
    out = subprocess.run(args, cwd=tmp, capture_output=True, text=True).stdout
    for f in (a, b):
        os.remove(f)
    os.rmdir(tmp)
    body = out[out.index('\n@@') + 1:]
    header_a = f'a/{logical}' if base_text is not None else '/dev/null'
    header = f'diff --git a/{logical} b/{logical}\n--- {header_a}\n+++ b/{logical}\n'
    return header + body


def candidate_json(c, files, d):
    head = files[c['file']][1]
    claimed_line = line_of(head, c['claimed'][0]) + c['claimed'][1]
    raw = dict(
        path=f"{d}/{c['file']}", lineStart=claimed_line, lineEnd=claimed_line, category=c['category'],
        severity=c['severity'], confidence='high', title=c['title'], explanation=c['explanation'],
        evidence=c['evidence'], changeType=c['changeType'], trigger=c['trigger'],
        failurePath=c['failurePath'], violatedInvariant=c['violatedInvariant'], impact=c['impact'],
        assumptions='', missingContext='')
    return raw


def verify_json(c, files, d, which='verify'):
    v = c.get(which)
    if not v:
        return None
    head = files[c['file']][1]
    out = dict(verdict=v['verdict'], severity=v['severity'], reasoning=f"scripted {v['verdict']}",
               decisiveCode=v.get('decisiveCode', ''), failureSite='', dependsOnCodeNotShown=False,
               reachableTrigger='', violatedInvariant='', triggerSource='', guardsOnPath=[])
    if v['verdict'] == 'confirmed':
        out['failureSite'] = f"{d}/{c['file']}:{line_of(head, v['failure'][0]) + v['failure'][1]}"
        out['reachableTrigger'] = v['trigger']
        out['violatedInvariant'] = v['invariant']
        out['triggerSource'] = v['triggerSource']
        out['guardsOnPath'] = [dict(code=g[0], whyNotPreventing=g[1]) for g in v['guards']]
    return out


manifest_cases = {}
for c in CASES:
    cdir = os.path.join(CORPUS, c['id'])
    # Rebuild each case from scratch so no stale file (e.g. an old base/) survives.
    shutil.rmtree(cdir, ignore_errors=True)
    d = c['dir']
    physical = c.get('physical', {})
    files_meta = []
    patches = []
    for name, (base, head, fixed) in c['files'].items():
        phys = physical.get(name, name)
        write(os.path.join(cdir, 'head', phys), head)
        if base is not None:
            write(os.path.join(cdir, 'base', phys), base)
        if fixed is not None:
            write(os.path.join(cdir, 'fixed', phys), fixed)
        if name in c.get('hidden', []):
            # Present for the witness only: not part of the PR and not readable by the review.
            continue
        changed = base != head
        if changed:
            patches.append(git_patch(base, head, f'{d}/{name}'))
        files_meta.append(dict(path=f'{d}/{name}', physical=phys, changed=changed,
                               status='added' if base is None else 'modified'))
    write(os.path.join(cdir, 'diff.patch'), ''.join(patches))
    write(os.path.join(cdir, 'witness.spec.ts'), c['witness'])
    truth = []
    for t in c['truth']:
        head = c['files'][t['file']][1]
        end_line = line_of(head, t['anchor']) + t.get('span', 1) - 1
        # Removed safeguards span from where the check was removed to the operation it guarded.
        start = line_of(head, t['start_anchor']) if t.get('start_anchor') else end_line - t.get('span', 1) + 1
        # Removed code is labelled in base (old-file) coordinates.
        removed = None
        if t.get('removed_anchor'):
            base = c['files'][t['file']][0]
            r0 = line_of(base, t['removed_anchor'])
            r1 = next(i + 1 for i, l in enumerate(base.split('\n'))
                      if i + 1 > r0 and l.startswith(t['removed_end_anchor']))
            removed = [r0, r1]
        truth.append(dict(
            id=t['id'], path=f"{d}/{t['file']}", lines=[start, end_line],
            **({'removedLines': removed} if removed else {}),
            category=t['category'], severity=t['severity'], security=t['category'] == 'security',
            changeType=t['changeType'], description=t['description'],
            witness=f"witness.spec.ts › {t['witness']}"))
    groups = set()
    for t in truth:
        groups.add({'security': 'security', 'data_integrity': 'data'}.get(t['category'], 'correctness'))
    if c.get('security_regression'):
        groups.add('security')
    if not truth:
        groups.add('clean')
    if c['id'] in ('memory-contamination', 'moved-guard'):
        groups.add('regression')
    case_json = dict(
        id=c['id'], title=c['title'], repository='benchmark/phase1', pullRequest=c['id'],
        groups=sorted(groups),
        clean=len(truth) == 0, securityRegression=bool(c.get('security_regression')), files=files_meta,
        groundTruth=truth,
        groundTruthSource='executable witness (witness.spec.ts): the defect is demonstrated on head/ and absent from fixed/ (clean cases: head/ behaves correctly)',
        **({'projectMemory': c['memory']} if c.get('memory') else {}))
    write(os.path.join(cdir, 'case.json'), json.dumps(case_json, indent=2) + '\n')

    raws = [candidate_json(x, c['files'], d) for x in c['candidates']]
    baseline_verify = {}
    adversarial_verify = {}
    confirm_verify = {}
    for x in c['candidates']:
        k = verify_json(x, c['files'], d, 'adversarial_confirm')
        if k:
            confirm_verify[x['title']] = k
        v = verify_json(x, c['files'], d)
        if v:
            baseline_verify[x['title']] = v
        a = verify_json(x, c['files'], d, 'adversarial')
        if a:
            adversarial_verify[x['title']] = a
    runs = [dict(id='baseline', batch=dict(summary='scripted batch', findings=raws), verify=baseline_verify)]
    if adversarial_verify:
        runs.append(dict(id='adversarial-refutation', batch=dict(summary='scripted batch', findings=raws),
                         verify={**baseline_verify, **adversarial_verify}))
    if confirm_verify:
        runs.append(dict(id='adversarial-confirmation', batch=dict(summary='scripted batch', findings=raws),
                         verify={**baseline_verify, **confirm_verify}))
    responses = dict(
        provenance='scripted',
        note='Scripted model responses (not captured from a live model). They exercise the deterministic pipeline: a correct, grounded verifier in "baseline"; wrong refutations of real bugs in "adversarial-refutation"; wrong confirmations of clean code (fabricated paths, stitched quotes) in "adversarial-confirmation".',
        model=None, capturedAt=None, runs=runs)
    write(os.path.join(cdir, 'responses.json'), json.dumps(responses, indent=2) + '\n')
    manifest_cases[c['id']] = len(truth)

print('cases:', len(CASES), manifest_cases)
