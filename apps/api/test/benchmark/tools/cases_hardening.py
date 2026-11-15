# Hardening cases (loaded by make_corpus.py, which provides case(), DB_TS, NOTES_TYPES).
#
# Vulnerable / safe pairs for authorization, check-then-act races, locks, unique constraints,
# atomic conditional updates and transaction isolation, plus verifier adversaries:
#   adversarial      → a wrong refutation of a real bug (must not dismiss it)
#   adversarial_confirm → a wrong confirmation of a clean finding using fabricated execution
#                         paths or stitched quotes (must not confirm it)
# Every case has an executable witness. New cases use their own db.ts (with updateMany) so the
# shared DB_TS of the original corpus stays byte-identical.

DB_ATOMIC_TS = DB_TS.replace(
    "  delete(query: { where: Where }): Promise<void>;\n",
    "  delete(query: { where: Where }): Promise<void>;\n"
    "  /** Atomic conditional update: match and write in one statement. */\n"
    "  updateMany(query: { where: Where; data: Record<string, unknown> }): Promise<{ count: number }>;\n",
)
assert DB_ATOMIC_TS != DB_TS

# ── H1. correct role authorization (clean) ─────────────────────────────────────────────
ROLE_BASE = NOTES_TYPES + """
export async function archiveNote(db: NotesDb, userId: string, noteId: string): Promise<void> {
  const note = await db.note.findUnique({ where: { id: noteId } });
  if (!note) {
    throw new Error('NOT_FOUND');
  }
  const membership = await db.membership.findFirst({
    where: { workspaceId: note.workspaceId, userId, status: 'active' },
  });
  if (!membership || membership.role !== 'owner') {
    throw new Error('FORBIDDEN');
  }
  await db.note.update({ where: { id: noteId }, data: { archived: true } });
}
"""
ROLE_HEAD = NOTES_TYPES + """
/** Roles allowed to archive notes. Viewers and guests are read-only. */
const ARCHIVE_ROLES = ['owner', 'admin', 'editor'];

export async function archiveNote(db: NotesDb, userId: string, noteId: string): Promise<void> {
  const note = await db.note.findUnique({ where: { id: noteId } });
  if (!note) {
    throw new Error('NOT_FOUND');
  }
  const membership = await db.membership.findFirst({
    where: { workspaceId: note.workspaceId, userId, status: 'active' },
  });
  if (!membership || !ARCHIVE_ROLES.includes(membership.role)) {
    throw new Error('FORBIDDEN');
  }
  await db.note.update({ where: { id: noteId }, data: { archived: true } });
}
"""
case(
    id='role-check-correct',
    title='Allow admins and editors to archive notes (viewers and guests stay read-only)',
    dir='apps/api/src/notes',
    files={'db.ts': (DB_TS, DB_TS, None), 'notes.service.ts': (ROLE_BASE, ROLE_HEAD, None)},
    truth=[],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { archiveNote } from './head/notes.service';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([
    { workspaceId: 'ws1', userId: 'editor', role: 'editor', status: 'active' },
    { workspaceId: 'ws1', userId: 'viewer', role: 'viewer', status: 'active' },
    { workspaceId: 'ws1', userId: 'guest', role: 'guest', status: 'active' },
    { workspaceId: 'ws1', userId: 'gone', role: 'admin', status: 'removed' },
  ]),
});

describe('role-check-correct ground truth (clean)', () => {
  it('only active owners, admins and editors can archive; viewers, guests and outsiders cannot', async () => {
    for (const user of ['viewer', 'guest', 'gone', 'outsider']) {
      const d = db();
      await expect(archiveNote(d, user, 'n1')).rejects.toThrow('FORBIDDEN');
      expect(d.note.rows[0]!.archived).toBe(false);
    }
    const d = db();
    await archiveNote(d, 'editor', 'n1');
    expect(d.note.rows[0]!.archived).toBe(true);
  });
});
""",
    candidates=[dict(
        key='fp-role', truth=None, file='notes.service.ts',
        claimed=("if (!membership || !ARCHIVE_ROLES.includes(membership.role)) {", 0),
        category='security', severity='high', changeType='introduced',
        title='Role check lets non-owners archive notes',
        explanation='The guard now accepts any role in ARCHIVE_ROLES, so users who are not owners can archive notes.',
        evidence="if (!membership || !ARCHIVE_ROLES.includes(membership.role)) {",
        trigger='A viewer archives a note', failurePath='archiveNote → role check → update',
        violatedInvariant='Only privileged roles archive notes', impact='Unauthorized archival',
        verify=dict(verdict='refuted', severity='low',
                    decisiveCode="if (!membership || !ARCHIVE_ROLES.includes(membership.role)) {\nthrow new Error('FORBIDDEN');"),
        # Wrong confirmation: the "path" is a stitched quote that does not exist in the code.
        adversarial_confirm=dict(
            verdict='confirmed', severity='high',
            decisiveCode="if (!membership) { await db.note.update({ where: { id: noteId }, data: { archived: true } }); }",
            failure=('await db.note.update', 0),
            triggerSource="const ARCHIVE_ROLES = ['owner', 'admin', 'editor'];",
            guards=[("if (!membership || !ARCHIVE_ROLES.includes(membership.role)) {",
                     'Viewers are in the allowed roles.')],
            trigger='A viewer archives a note', invariant='Only privileged roles archive notes'),
    )],
)

# ── H2. correct locking (clean) ────────────────────────────────────────────────────────
LOCK_UNLOCKED = """import type { Table } from './db';

export type Seat = { workspaceId: string; userId: string; role: string };
export type SeatDb = {
  membership: Table<Seat>;
  lock<R>(key: string, fn: () => Promise<R>): Promise<R>;
};

export async function addSeat(
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
LOCK_LOCKED = LOCK_UNLOCKED.replace("""  const count = await db.membership.count({ where: { workspaceId } });
  if (count >= limit) {
    throw new Error('SEAT_LIMIT');
  }
  await db.membership.create({ data: { workspaceId, userId, role: 'member' } });
""", """  // Serialize seat allocation per workspace: count and insert run under one lock.
  await db.lock(`seats:${workspaceId}`, async () => {
    const count = await db.membership.count({ where: { workspaceId } });
    if (count >= limit) {
      throw new Error('SEAT_LIMIT');
    }
    await db.membership.create({ data: { workspaceId, userId, role: 'member' } });
  });
""")
assert LOCK_LOCKED != LOCK_UNLOCKED
case(
    id='race-locked',
    title='Serialize seat allocation with a per-workspace lock',
    dir='apps/api/src/workspaces',
    files={'db.ts': (DB_TS, DB_TS, None), 'seats.ts': (LOCK_UNLOCKED, LOCK_LOCKED, None)},
    truth=[],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeLock, fakeTable } from '../../support/fake-db';
import { addSeat } from './head/seats';

type Seat = { workspaceId: string; userId: string; role: string };

describe('race-locked ground truth (clean)', () => {
  it('concurrent adds never exceed the limit because count and insert share one lock', async () => {
    const db = { membership: fakeTable<Seat>([], { delayMs: 1 }), lock: fakeLock() };
    const results = await Promise.allSettled(['a', 'b', 'c', 'd'].map((u) => addSeat(db, 'ws1', u, 2)));
    expect(db.membership.rows).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
  });
});
""",
    candidates=[dict(
        key='fp-race', truth=None, file='seats.ts',
        claimed=('const count = await db.membership.count', 0),
        category='data_integrity', severity='medium', changeType='introduced',
        title='Seat count and insert can race under concurrent invitations',
        explanation='Two invitations may read the same count before either inserts, exceeding the seat limit.',
        evidence='const count = await db.membership.count({ where: { workspaceId } });',
        trigger='Two invitations for the last seat at the same time', failurePath='count → create twice',
        violatedInvariant='Members never exceed the seat limit', impact='Seat limit bypass',
        verify=dict(verdict='refuted', severity='low',
                    decisiveCode="await db.lock(`seats:${workspaceId}`, async () => {\nconst count = await db.membership.count({ where: { workspaceId } });"),
        # Wrong confirmation: ignores the enclosing lock, restating the check-then-insert.
        adversarial_confirm=dict(
            verdict='confirmed', severity='medium',
            decisiveCode="if (count >= limit) {\nawait db.membership.create({ data: { workspaceId, userId, role: 'member' } });",
            failure=('await db.membership.create', 0),
            triggerSource='limit: number,',
            guards=[('if (count >= limit) {', 'Concurrent calls read the same count.')],
            trigger='Two invitations for the last seat at the same time',
            invariant='Members never exceed the seat limit'),
    )],
)

# ── H3. uniqueness constraint handles the check-then-insert race (clean) ─────────────────
INVITE_TYPES = """import type { Table } from './db';

/** `(workspaceId, email)` is unique: see prisma/schema.prisma `@@unique([workspaceId, email])`. */
export type Invite = { workspaceId: string; email: string; status: string };
export type InviteDb = { invite: Table<Invite> };
"""
INVITE_BASE = INVITE_TYPES + """
export async function inviteMember(db: InviteDb, workspaceId: string, email: string): Promise<Invite> {
  const existing = await db.invite.findFirst({ where: { workspaceId, email } });
  if (existing) {
    return existing;
  }
  return db.invite.create({ data: { workspaceId, email, status: 'pending' } });
}
"""
INVITE_HEAD = INVITE_TYPES + """
const UNIQUE_VIOLATION = 'P2002';

export async function inviteMember(db: InviteDb, workspaceId: string, email: string): Promise<Invite> {
  const existing = await db.invite.findFirst({ where: { workspaceId, email } });
  if (existing) {
    return existing;
  }
  try {
    return await db.invite.create({ data: { workspaceId, email, status: 'pending' } });
  } catch (error) {
    // A concurrent invite inserted the same (workspaceId, email) first: return that one.
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      const winner = await db.invite.findFirst({ where: { workspaceId, email } });
      if (winner) {
        return winner;
      }
    }
    throw error;
  }
}
"""
SCHEMA_PRISMA = """model Invite {
  workspaceId String
  email       String
  status      String

  @@unique([workspaceId, email])
}
"""
case(
    id='race-unique-constraint',
    title='Return the existing invite when a concurrent invite wins the unique constraint',
    dir='apps/api/src/invites',
    files={'db.ts': (DB_TS, DB_TS, None), 'invites.service.ts': (INVITE_BASE, INVITE_HEAD, None),
           'schema.prisma': (SCHEMA_PRISMA, SCHEMA_PRISMA, None)},
    truth=[],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { inviteMember } from './head/invites.service';

type Invite = { workspaceId: string; email: string; status: string };

describe('race-unique-constraint ground truth (clean)', () => {
  it('concurrent invites for one email create exactly one row and all callers get it', async () => {
    const invite = fakeTable<Invite>([], { delayMs: 1, unique: ['workspaceId', 'email'] });
    const results = await Promise.all(
      [1, 2, 3].map(() => inviteMember({ invite }, 'ws1', 'a@example.com')),
    );
    expect(invite.rows).toHaveLength(1);
    expect(results.every((r) => r.email === 'a@example.com')).toBe(true);
  });
});
""",
    candidates=[dict(
        key='fp-dup', truth=None, file='invites.service.ts',
        claimed=('const existing = await db.invite.findFirst', 0),
        category='data_integrity', severity='medium', changeType='introduced',
        title='Duplicate invites under concurrent requests (check-then-insert)',
        explanation='findFirst and create are not atomic, so two requests can both insert an invite.',
        evidence='const existing = await db.invite.findFirst({ where: { workspaceId, email } });',
        trigger='Two invite requests for the same email at once', failurePath='findFirst → create twice',
        violatedInvariant='One invite per email and workspace', impact='Duplicate invites',
        verify=dict(verdict='refuted', severity='low',
                    decisiveCode="} catch (error) {\n// A concurrent invite inserted the same (workspaceId, email) first: return that one.\nif ((error as { code?: string }).code === UNIQUE_VIOLATION) {"),
    )],
)

# ── H4. atomic conditional update (clean) ──────────────────────────────────────────────
EVENT_TYPES = """import type { Table } from './db';

export type Event = { id: string; remaining: number };
export type EventDb = { event: Table<Event> };
"""
EVENT_BASE = EVENT_TYPES + """
export async function reserveTicket(db: EventDb, eventId: string): Promise<void> {
  const event = await db.event.findUnique({ where: { id: eventId } });
  if (!event || event.remaining <= 0) {
    throw new Error('SOLD_OUT');
  }
  await db.event.update({ where: { id: eventId }, data: { remaining: event.remaining - 1 } });
}
"""
EVENT_HEAD = EVENT_TYPES + """
export async function reserveTicket(db: EventDb, eventId: string): Promise<void> {
  // One statement: the stock check and the decrement cannot interleave with another request.
  const reserved = await db.event.updateMany({
    where: { id: eventId, remaining: { gt: 0 } },
    data: { remaining: { decrement: 1 } },
  });
  if (reserved.count === 0) {
    throw new Error('SOLD_OUT');
  }
}
"""
case(
    id='atomic-conditional-update',
    title='Reserve tickets with an atomic conditional decrement',
    dir='apps/api/src/events',
    files={'db.ts': (DB_ATOMIC_TS, DB_ATOMIC_TS, None), 'tickets.ts': (EVENT_BASE, EVENT_HEAD, None)},
    truth=[],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { reserveTicket as baseReserve } from './base/tickets';
import { reserveTicket } from './head/tickets';

type Event = { id: string; remaining: number };

describe('atomic-conditional-update ground truth (clean)', () => {
  it('concurrent reservations never oversell (the read-then-write version did)', async () => {
    const head = fakeTable<Event>([{ id: 'e1', remaining: 2 }], { delayMs: 1 });
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => reserveTicket({ event: head }, 'e1')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(head.rows[0]!.remaining).toBe(0);
    const base = fakeTable<Event>([{ id: 'e1', remaining: 2 }], { delayMs: 1 });
    const before = await Promise.allSettled([1, 2, 3, 4, 5].map(() => baseReserve({ event: base }, 'e1')));
    expect(before.filter((r) => r.status === 'fulfilled').length).toBeGreaterThan(2);
  });
});
""",
    candidates=[dict(
        key='fp-oversell', truth=None, file='tickets.ts',
        claimed=('const reserved = await db.event.updateMany({', 0),
        category='data_integrity', severity='high', changeType='introduced',
        title='Concurrent reservations can oversell tickets',
        explanation='The remaining count is checked and decremented without a lock, so parallel requests can oversell.',
        evidence='const reserved = await db.event.updateMany({',
        trigger='Many reservations for the last ticket', failurePath='updateMany → count check',
        violatedInvariant='Tickets are never oversold', impact='Oversold events',
        verify=dict(verdict='refuted', severity='low',
                    decisiveCode="where: { id: eventId, remaining: { gt: 0 } },\ndata: { remaining: { decrement: 1 } },"),
        # Wrong confirmation: failure site on a comment line (fabricated execution path).
        adversarial_confirm=dict(
            verdict='confirmed', severity='high',
            decisiveCode="if (reserved.count === 0) {",
            failure=('// One statement:', 0),
            triggerSource='export async function reserveTicket(db: EventDb, eventId: string): Promise<void> {',
            guards=[('if (reserved.count === 0) {', 'Checked after the decrement.')],
            trigger='Many reservations for the last ticket', invariant='Tickets are never oversold'),
    )],
)

# ── H5. transaction with insufficient isolation (bug) ─────────────────────────────────
WALLET_TYPES = """import type { Table } from './db';

export type Account = { id: string; credits: number };
export type WalletDb = {
  account: Table<Account>;
  /** Interactive transaction at the database default isolation (READ COMMITTED). */
  $transaction<R>(fn: (tx: { account: Table<Account> }) => Promise<R>): Promise<R>;
};
"""
WALLET_ATOMIC = WALLET_TYPES + """
export async function withdraw(db: WalletDb, accountId: string, amount: number): Promise<void> {
  const debited = await db.account.updateMany({
    where: { id: accountId, credits: { gte: amount } },
    data: { credits: { decrement: amount } },
  });
  if (debited.count === 0) {
    throw new Error('INSUFFICIENT_FUNDS');
  }
}
"""
WALLET_TX = WALLET_TYPES + """
export async function withdraw(db: WalletDb, accountId: string, amount: number): Promise<void> {
  await db.$transaction(async (tx) => {
    const account = await tx.account.findUnique({ where: { id: accountId } });
    if (!account || account.credits < amount) {
      throw new Error('INSUFFICIENT_FUNDS');
    }
    await tx.account.update({ where: { id: accountId }, data: { credits: account.credits - amount } });
  });
}
"""
case(
    id='tx-insufficient-isolation',
    title='Move withdrawals into an interactive transaction',
    dir='apps/api/src/wallet',
    files={'db.ts': (DB_ATOMIC_TS, DB_ATOMIC_TS, DB_ATOMIC_TS),
           'wallet.service.ts': (WALLET_ATOMIC, WALLET_TX, WALLET_ATOMIC)},
    truth=[dict(id='tx-insufficient-isolation/lost-update-overdraft', file='wallet.service.ts',
                anchor='await tx.account.update', start_anchor='const account = await tx.account.findUnique',
                removed_anchor='const debited = await db.account.updateMany({', removed_end_anchor='  });',
                category='data_integrity', severity='high', changeType='removed_safeguard',
                description='The atomic conditional decrement was replaced by read-check-write inside a READ COMMITTED transaction: concurrent withdrawals both pass the balance check and overdraw (lost update).',
                witness='two concurrent withdrawals overdraw the account')],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable, fakeTransaction } from '../../support/fake-db';
import { withdraw as fixedWithdraw } from './fixed/wallet.service';
import { withdraw as headWithdraw } from './head/wallet.service';

type Account = { id: string; credits: number };
const wallet = () => {
  const account = fakeTable<Account>([{ id: 'a1', credits: 100 }], { delayMs: 1 });
  return { account, $transaction: fakeTransaction({ account }) };
};

describe('tx-insufficient-isolation ground truth', () => {
  it('two concurrent withdrawals overdraw the account', async () => {
    const head = wallet();
    const done = await Promise.allSettled([headWithdraw(head, 'a1', 60), headWithdraw(head, 'a1', 60)]);
    // bug: both succeed (120 withdrawn from 100) and the second write overwrites the first
    expect(done.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(head.account.rows[0]!.credits).toBe(40);
    const fixed = wallet();
    const ok = await Promise.allSettled([fixedWithdraw(fixed, 'a1', 60), fixedWithdraw(fixed, 'a1', 60)]);
    expect(ok.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(fixed.account.rows[0]!.credits).toBe(40);
  });
});
""",
    candidates=[dict(
        key='lost-update', truth='tx-insufficient-isolation/lost-update-overdraft', file='wallet.service.ts',
        claimed=('await tx.account.update', 0), category='data_integrity', severity='high',
        changeType='removed_safeguard',
        title='Concurrent withdrawals can overdraw: read-check-write in a READ COMMITTED transaction',
        explanation='The balance is read, checked and written back inside a default-isolation transaction; two concurrent withdrawals read the same balance and both pass the check.',
        evidence="await tx.account.update({ where: { id: accountId }, data: { credits: account.credits - amount } });",
        trigger='Two withdrawals of 60 from a balance of 100 at the same time',
        failurePath='findUnique (100) ×2 → check passes ×2 → update 40 ×2',
        violatedInvariant='Credits never go below zero and every withdrawal is debited',
        impact='Overdraft and lost debits',
        verify=dict(
            verdict='confirmed', severity='high',
            decisiveCode="const account = await tx.account.findUnique({ where: { id: accountId } });\nawait tx.account.update({ where: { id: accountId }, data: { credits: account.credits - amount } });",
            failure=('await tx.account.update', 0),
            triggerSource='export async function withdraw(db: WalletDb, accountId: string, amount: number): Promise<void> {',
            guards=[('if (!account || account.credits < amount) {', 'Both transactions read the same balance before either writes.'),
                    ('await db.$transaction(async (tx) => {', 'The default READ COMMITTED transaction takes no lock on the row read by findUnique.')],
            trigger='Two concurrent withdrawals', invariant='Credits never go below zero'),
        # Wrong refutation: "it runs in a transaction" (isolation is not serializable).
        adversarial=dict(verdict='refuted', severity='low',
                         decisiveCode="await db.$transaction(async (tx) => {\nconst account = await tx.account.findUnique({ where: { id: accountId } });"),
    )],
)

# ── H6. correct transaction boundary (clean) ───────────────────────────────────────────
TRANSFER_BASE = WALLET_TYPES + """
export async function transfer(db: WalletDb, fromId: string, toId: string, amount: number): Promise<void> {
  const debited = await db.account.updateMany({
    where: { id: fromId, credits: { gte: amount } },
    data: { credits: { decrement: amount } },
  });
  if (debited.count === 0) {
    throw new Error('INSUFFICIENT_FUNDS');
  }
  await db.account.update({ where: { id: toId }, data: { credits: { increment: amount } } });
}
"""
TRANSFER_HEAD = WALLET_TYPES + """
export async function transfer(db: WalletDb, fromId: string, toId: string, amount: number): Promise<void> {
  // Debit and credit commit together; the debit is an atomic conditional decrement.
  await db.$transaction(async (tx) => {
    const debited = await tx.account.updateMany({
      where: { id: fromId, credits: { gte: amount } },
      data: { credits: { decrement: amount } },
    });
    if (debited.count === 0) {
      throw new Error('INSUFFICIENT_FUNDS');
    }
    await tx.account.update({ where: { id: toId }, data: { credits: { increment: amount } } });
  });
}
"""
case(
    id='tx-correct',
    title='Run transfer debit and credit in one transaction',
    dir='apps/api/src/wallet',
    files={'db.ts': (DB_ATOMIC_TS, DB_ATOMIC_TS, None), 'transfer.service.ts': (TRANSFER_BASE, TRANSFER_HEAD, None)},
    truth=[],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable, fakeTransaction } from '../../support/fake-db';
import { transfer } from './head/transfer.service';

type Account = { id: string; credits: number };
const bank = (failCredit = false) => {
  const account = fakeTable<Account>(
    [
      { id: 'a', credits: 100 },
      { id: 'b', credits: 0 },
    ],
    { delayMs: 1, failWrite: (op, where) => failCredit && op === 'update' && where?.id === 'b' },
  );
  return { account, $transaction: fakeTransaction({ account }) };
};

describe('tx-correct ground truth (clean)', () => {
  it('a failed credit rolls back the debit, and concurrent transfers never overdraw', async () => {
    const failing = bank(true);
    await expect(transfer(failing, 'a', 'b', 30)).rejects.toThrow('WRITE_FAILED');
    expect(failing.account.rows.map((r) => r.credits)).toEqual([100, 0]);
    const busy = bank();
    const done = await Promise.allSettled([1, 2, 3].map(() => transfer(busy, 'a', 'b', 40)));
    expect(done.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(busy.account.rows.map((r) => r.credits)).toEqual([20, 80]);
  });
});
""",
    candidates=[dict(
        key='fp-partial', truth=None, file='transfer.service.ts',
        claimed=('await tx.account.update({ where: { id: toId }', 0),
        category='data_integrity', severity='high', changeType='introduced',
        title='Credit failure leaves the debit applied (partial transfer)',
        explanation='If the credit update fails after the debit, the sender loses credits.',
        evidence="await tx.account.update({ where: { id: toId }, data: { credits: { increment: amount } } });",
        trigger='The credit update fails', failurePath='debit → credit throws',
        violatedInvariant='Transfers are all-or-nothing', impact='Lost credits',
        verify=dict(verdict='refuted', severity='low',
                    decisiveCode="await db.$transaction(async (tx) => {\nconst debited = await tx.account.updateMany({"),
    )],
)

# ── H7. authorization helper that never denies (bug; dismissal by name alone) ──────────
ACCESS_TS = """import type { Table } from './db';

export type Membership = { workspaceId: string; userId: string; role: string; status: string };
export type AccessDb = { membership: Table<Membership> };

/** Whether `userId` belongs to `workspaceId`. Callers decide what to do with the answer. */
export async function assertMember(db: AccessDb, workspaceId: string, userId: string): Promise<boolean> {
  const membership = await db.membership.findFirst({ where: { workspaceId, userId, status: 'active' } });
  return membership != null;
}
"""
HELPER_BASE = NOTES_TYPES + """
export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {
  const note = await db.note.findUnique({ where: { id: noteId } });
  if (!note) {
    throw new Error('NOT_FOUND');
  }
  const membership = await db.membership.findFirst({
    where: { workspaceId: note.workspaceId, userId, status: 'active' },
  });
  if (!membership) {
    throw new Error('FORBIDDEN');
  }
  await db.note.delete({ where: { id: noteId } });
}
"""
HELPER_HEAD = NOTES_TYPES.replace("import type { Table } from './db';",
                                  "import { assertMember } from './access';\nimport type { Table } from './db';") + """
export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {
  const note = await db.note.findUnique({ where: { id: noteId } });
  if (!note) {
    throw new Error('NOT_FOUND');
  }
  await assertMember(db, note.workspaceId, userId);
  await db.note.delete({ where: { id: noteId } });
}
"""
HELPER_FIXED = HELPER_HEAD.replace("""  await assertMember(db, note.workspaceId, userId);
""", """  if (!(await assertMember(db, note.workspaceId, userId))) {
    throw new Error('FORBIDDEN');
  }
""")
assert HELPER_FIXED != HELPER_HEAD
case(
    id='helper-never-denies',
    title='Replace the inline membership check with assertMember()',
    dir='apps/api/src/notes',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'access.ts': (None, ACCESS_TS, ACCESS_TS),
           'notes.service.ts': (HELPER_BASE, HELPER_HEAD, HELPER_FIXED)},
    security_regression=True,
    truth=[dict(id='helper-never-denies/ignored-membership-result', file='notes.service.ts',
                anchor='await db.note.delete', start_anchor='await assertMember(db, note.workspaceId, userId);',
                category='security', severity='high', changeType='removed_safeguard',
                description='assertMember only returns a boolean; its result is ignored, so non-members delete notes. The name suggests a check that never denies.',
                witness='an outsider can delete a note although assertMember is called')],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { deleteNote as fixedDelete } from './fixed/notes.service';
import { deleteNote as headDelete } from './head/notes.service';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'owner', status: 'active' }]),
});

describe('helper-never-denies ground truth', () => {
  it('an outsider can delete a note although assertMember is called', async () => {
    const head = db();
    await headDelete(head, 'outsider', 'n1');
    expect(head.note.rows).toHaveLength(0);
    const fixed = db();
    await expect(fixedDelete(fixed, 'outsider', 'n1')).rejects.toThrow('FORBIDDEN');
    expect(fixed.note.rows).toHaveLength(1);
  });
});
""",
    candidates=[dict(
        key='ignored', truth='helper-never-denies/ignored-membership-result', file='notes.service.ts',
        claimed=('await db.note.delete', 0), category='security', severity='high',
        changeType='removed_safeguard',
        title='Membership check result is ignored before deleting the note',
        explanation='assertMember returns a boolean instead of throwing, and deleteNote ignores it.',
        evidence="await assertMember(db, note.workspaceId, userId);",
        trigger='A non-member deletes a note by id', failurePath='assertMember → false (ignored) → delete',
        violatedInvariant='Only workspace members delete notes', impact='Cross-workspace deletion',
        verify=dict(
            verdict='confirmed', severity='high',
            decisiveCode="return membership != null;\nawait db.note.delete({ where: { id: noteId } });",
            failure=('await db.note.delete', 0),
            triggerSource='export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {',
            guards=[('if (!note) {', 'Only rejects a missing note.'),
                    ('await assertMember(db, note.workspaceId, userId);', 'assertMember returns false for non-members and never throws; the result is discarded.')],
            trigger='A non-member deletes a note', invariant='Only workspace members delete notes'),
        # Wrong refutation by name alone: "assertMember asserts membership".
        adversarial=dict(verdict='refuted', severity='low',
                         decisiveCode="await assertMember(db, note.workspaceId, userId);\nawait db.note.delete({ where: { id: noteId } });"),
    )],
)

# ── H8. multi-line deleted evidence ending in `});` (bug; live capture shape) ──────────
MULTI_BASE = NOTES_TYPES + """
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
MULTI_HEAD = NOTES_TYPES + """
export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {
  const note = await db.note.findUnique({ where: { id: noteId } });
  if (!note) {
    throw new Error('NOT_FOUND');
  }
  await db.note.delete({ where: { id: noteId } });
}
"""
case(
    id='multiline-evidence',
    title='Remove the membership lookup from note deletion (multi-line deleted evidence)',
    dir='apps/api/src/docs',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'notes.service.ts': (MULTI_BASE, MULTI_HEAD, MULTI_BASE)},
    security_regression=True,
    truth=[dict(id='multiline-evidence/delete-without-membership', file='notes.service.ts',
                anchor='await db.note.delete', category='security', severity='high',
                changeType='removed_safeguard',
                removed_anchor='const membership = await db.membership.findFirst({',
                removed_end_anchor="    throw new Error('FORBIDDEN');",
                description='The membership lookup and its FORBIDDEN branch were removed: any user deletes any note by id.',
                witness='an outsider can delete a note of another workspace')],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { deleteNote as fixedDelete } from './fixed/notes.service';
import { deleteNote as headDelete } from './head/notes.service';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'owner', status: 'active' }]),
});

describe('multiline-evidence ground truth', () => {
  it('an outsider can delete a note of another workspace', async () => {
    const head = db();
    await headDelete(head, 'outsider', 'n1');
    expect(head.note.rows).toHaveLength(0);
    const fixed = db();
    await expect(fixedDelete(fixed, 'outsider', 'n1')).rejects.toThrow('FORBIDDEN');
  });
});
""",
    candidates=[dict(
        key='multi', truth='multiline-evidence/delete-without-membership', file='notes.service.ts',
        claimed=('await db.note.delete', 0), category='security', severity='high',
        changeType='removed_safeguard',
        title='Missing Workspace Membership Check',
        explanation='The deletion of a note does not verify that the user is a member of the note workspace.',
        # Exactly the live run-0 evidence shape: deleted lines ending in a structural `});`.
        evidence="-  const membership = await db.membership.findFirst({\n-    where: { workspaceId: note.workspaceId, userId },\n-  });",
        trigger='A user deletes a note of a workspace they do not belong to',
        failurePath='findUnique → delete', violatedInvariant='Only members delete notes',
        impact='Cross-workspace deletion',
        verify=dict(
            verdict='confirmed', severity='high',
            decisiveCode='await db.note.delete({ where: { id: noteId } });',
            failure=('await db.note.delete', 0),
            triggerSource='const note = await db.note.findUnique({ where: { id: noteId } });',
            guards=[("if (!note) {\n    throw new Error('NOT_FOUND');\n}", 'Only checks that the note exists.')],
            trigger='A non-member deletes a note', invariant='Only workspace members delete notes'),
        # Wrong refutation with a joined quote of the unrelated existence guard.
        adversarial=dict(verdict='refuted', severity='low',
                         decisiveCode="if (!note) { throw new Error('NOT_FOUND'); }"),
    )],
)

# ── H9. authorization helper whose implementation cannot be read (bug) ────────────────
# access.ts exists for the witness but is hidden from the review (not in the PR's files and
# not fetchable): the engine must keep the finding uncertain, never confirm or dismiss it.
MISSING_HEAD = NOTES_TYPES.replace("import type { Table } from './db';",
                                   "import { requireWorkspaceMember } from './access';\nimport type { Table } from './db';") + """
export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {
  const note = await db.note.findUnique({ where: { id: noteId } });
  if (!note) {
    throw new Error('NOT_FOUND');
  }
  await requireWorkspaceMember(db, note.workspaceId, userId);
  await db.note.delete({ where: { id: noteId } });
}
"""
MISSING_ACCESS = ACCESS_TS.replace('assertMember', 'requireWorkspaceMember')
MISSING_FIXED = MISSING_HEAD.replace("""  await requireWorkspaceMember(db, note.workspaceId, userId);
""", """  if (!(await requireWorkspaceMember(db, note.workspaceId, userId))) {
    throw new Error('FORBIDDEN');
  }
""")
assert MISSING_FIXED != MISSING_HEAD
case(
    id='helper-unavailable',
    title='Delegate the membership check to requireWorkspaceMember() (helper source unavailable)',
    dir='apps/api/src/notes',
    files={'db.ts': (DB_TS, DB_TS, DB_TS), 'access.ts': (MISSING_ACCESS, MISSING_ACCESS, MISSING_ACCESS),
           'notes.service.ts': (HELPER_BASE, MISSING_HEAD, MISSING_FIXED)},
    hidden=['access.ts'],
    security_regression=True,
    truth=[dict(id='helper-unavailable/membership-result-ignored', file='notes.service.ts',
                anchor='await db.note.delete', start_anchor='await requireWorkspaceMember(db, note.workspaceId, userId);',
                category='security', severity='high', changeType='removed_safeguard',
                description='requireWorkspaceMember returns a boolean that deleteNote ignores; its source is not available to the review, so the engine can only report it as uncertain.',
                witness='an outsider can delete a note although requireWorkspaceMember is called')],
    witness="""import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { deleteNote as fixedDelete } from './fixed/notes.service';
import { deleteNote as headDelete } from './head/notes.service';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'owner', status: 'active' }]),
});

describe('helper-unavailable ground truth', () => {
  it('an outsider can delete a note although requireWorkspaceMember is called', async () => {
    const head = db();
    await headDelete(head, 'outsider', 'n1');
    expect(head.note.rows).toHaveLength(0);
    const fixed = db();
    await expect(fixedDelete(fixed, 'outsider', 'n1')).rejects.toThrow('FORBIDDEN');
  });
});
""",
    candidates=[dict(
        key='unavailable', truth='helper-unavailable/membership-result-ignored', file='notes.service.ts',
        claimed=('await db.note.delete', 0), category='security', severity='high',
        changeType='removed_safeguard',
        title='Note deletion relies on a membership helper that is not shown to deny',
        explanation='The inline FORBIDDEN check was replaced by requireWorkspaceMember(), whose behaviour is not visible.',
        evidence="await requireWorkspaceMember(db, note.workspaceId, userId);",
        trigger='A non-member deletes a note by id', failurePath='requireWorkspaceMember → delete',
        violatedInvariant='Only workspace members delete notes', impact='Cross-workspace deletion',
        # A confident confirmation that guesses the helper's behaviour (it cannot see it).
        verify=dict(
            verdict='confirmed', severity='high',
            decisiveCode="await requireWorkspaceMember(db, note.workspaceId, userId);\nawait db.note.delete({ where: { id: noteId } });",
            failure=('await db.note.delete', 0),
            triggerSource='export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {',
            guards=[('await requireWorkspaceMember(db, note.workspaceId, userId);', 'It probably returns a boolean that is ignored.')],
            trigger='A non-member deletes a note', invariant='Only workspace members delete notes'),
        # A wrong refutation by the helper's name.
        adversarial=dict(verdict='refuted', severity='low',
                         decisiveCode="await requireWorkspaceMember(db, note.workspaceId, userId);"),
    )],
)
