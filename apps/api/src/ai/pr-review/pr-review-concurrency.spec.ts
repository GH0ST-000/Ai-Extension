/**
 * Check-then-act analysis (`concurrencyAt`), resource relation between a guard and the
 * vulnerable statement (`resourceRelated`), and the verdict rules built on them. Sources are
 * the benchmark corpus files (executable witnesses prove which ones are safe) plus focused
 * variants.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CodeSection } from './pr-review-context';
import { validatedFinding } from './pr-review-fixtures';
import { concurrencyAt, guardsBeforeSite, resourceRelated } from './pr-review-site';
import {
  assessVerdict,
  buildVerificationContent,
  type VerificationOutput,
} from './pr-review-verify';

const CORPUS = join(__dirname, '../../../test/benchmark/corpus');
const read = (rel: string) => readFileSync(join(CORPUS, rel), 'utf8');
const lineOf = (text: string, needle: string) =>
  text.split('\n').findIndex((l) => l.includes(needle)) + 1;

const UNLOCKED = read('race-condition/head/seats.ts');
const LOCKED = read('race-locked/head/seats.ts');
const UNIQUE = read('race-unique-constraint/head/invites.service.ts');
const ATOMIC = read('atomic-conditional-update/head/tickets.ts');
const ATOMIC_BASE = read('atomic-conditional-update/base/tickets.ts');
const TX_WEAK = read('tx-insufficient-isolation/head/wallet.service.ts');
const TX_GROUPED = read('tx-correct/head/transfer.service.ts');

describe('concurrencyAt: what serializes a check-then-act sequence', () => {
  it('unlocked count → check → create is a check-then-act with no protection', () => {
    const f = concurrencyAt('s.ts', UNLOCKED, lineOf(UNLOCKED, 'membership.count'))!;
    expect(f).toMatchObject({ checkThenAct: true, protection: null });
  });

  it('a lock callback enclosing the read and the write protects it', () => {
    const f = concurrencyAt('s.ts', LOCKED, lineOf(LOCKED, 'membership.count'))!;
    expect(f.checkThenAct).toBe(true);
    expect(f.protection).toBe('lock');
    expect(f.protectionLines).toEqual([lineOf(LOCKED, 'await db.lock(')]);
  });

  it('a lock around the write only does not serialize the read', () => {
    const text = [
      'export async function add(db: Db, ws: string, limit: number) {',
      '  const count = await db.membership.count({ where: { ws } });',
      '  if (count >= limit) throw new Error("LIMIT");',
      '  await db.lock(`seats:${ws}`, async () => {',
      '    await db.membership.create({ data: { ws } });',
      '  });',
      '}',
    ].join('\n');
    expect(concurrencyAt('s.ts', text, 2)).toMatchObject({ checkThenAct: true, protection: null });
  });

  it('a handled unique-constraint violation protects a check-then-insert', () => {
    const f = concurrencyAt('s.ts', UNIQUE, lineOf(UNIQUE, 'const existing'))!;
    expect(f.protection).toBe('unique_constraint');
    expect(f.protectionLines[0]).toBe(lineOf(UNIQUE, '} catch (error) {'));
  });

  it('an atomic conditional write protects it; the read-then-write version does not', () => {
    expect(concurrencyAt('t.ts', ATOMIC, lineOf(ATOMIC, 'updateMany'))!.protection).toBe(
      'atomic_update',
    );
    const before = concurrencyAt('t.ts', ATOMIC_BASE, lineOf(ATOMIC_BASE, 'event.update'))!;
    expect(before).toMatchObject({ checkThenAct: true, protection: null });
  });

  it('a default-isolation transaction groups writes but does not isolate a read-check-write', () => {
    const f = concurrencyAt('w.ts', TX_WEAK, lineOf(TX_WEAK, 'tx.account.update'))!;
    expect(f).toMatchObject({ checkThenAct: true, protection: 'transaction' });
    const strict = TX_WEAK.replace('  });\n}', "  }, { isolationLevel: 'Serializable' });\n}");
    expect(strict).not.toBe(TX_WEAK);
    expect(concurrencyAt('w.ts', strict, lineOf(strict, 'tx.account.update'))!.protection).toBe(
      'serializable_transaction',
    );
    const rowLocked = TX_WEAK.replace(
      'const account = await tx.account.findUnique({ where: { id: accountId } });',
      'const [account] = await tx.$queryRaw`SELECT * FROM "Account" WHERE id = ${accountId} FOR UPDATE`;',
    );
    expect(
      concurrencyAt('w.ts', rowLocked, lineOf(rowLocked, 'tx.account.update'))!.protection,
    ).toBe('serializable_transaction');
  });

  it('both writes in one transaction are atomic', () => {
    const f = concurrencyAt('t.ts', TX_GROUPED, lineOf(TX_GROUPED, 'id: toId'))!;
    expect(f.atomicWrites).toBe(true);
    expect(f.transactionLines).toEqual([lineOf(TX_GROUPED, 'await db.$transaction')]);
  });
});

describe('resourceRelated: does the authorization concern the resource acted on?', () => {
  const text = [
    'export class Docs {', // 1
    '  async remove(userId: string, workspaceId: string, docId: string) {', // 2
    '    const membership = await this.db.member.findFirst({ where: { workspaceId, userId } });', // 3
    '    if (!membership) throw new ForbiddenException();', // 4
    '    await this.db.doc.delete({ where: { id: docId } });', // 5
    '  }', // 6
    '  async removeScoped(userId: string, workspaceId: string, docId: string) {', // 7
    '    const membership = await this.db.member.findFirst({ where: { workspaceId, userId } });', // 8
    '    if (!membership) throw new ForbiddenException();', // 9
    '    await this.db.doc.deleteMany({ where: { id: docId, workspaceId } });', // 10
    '  }', // 11
    '  async removeViaNote(userId: string, noteId: string) {', // 12
    '    const note = await this.db.note.findUnique({ where: { id: noteId } });', // 13
    '    const membership = await this.db.member.findFirst({ where: { workspaceId: note.workspaceId, userId } });', // 14
    '    if (!membership) throw new ForbiddenException();', // 15
    '    await this.db.note.delete({ where: { id: noteId } });', // 16
    '  }', // 17
    '}', // 18
  ].join('\n');

  it('membership of a workspace says nothing about a document addressed only by its id', () => {
    expect(resourceRelated('d.ts', text, [3], 5)).toBe(false);
  });

  it('related through a shared tenant key or through the loaded resource', () => {
    expect(resourceRelated('d.ts', text, [8], 10)).toBe(true);
    expect(resourceRelated('d.ts', text, [14], 16)).toBe(true);
  });

  it('unknown across functions (no claim either way)', () => {
    expect(resourceRelated('d.ts', text, [3], 10)).toBeNull();
  });
});

describe('path guards: swallowed denials do not stop the site', () => {
  it('a denial inside a try whose catch swallows it is not a guard; a rethrowing catch is', () => {
    const text = [
      'export async function f(db: Db, userId: string) {', // 1
      '  try {', // 2
      '    if (!(await db.m.findFirst({ where: { userId } }))) throw new ForbiddenException();', // 3
      '  } catch {}', // 4
      '  try {', // 5
      '    if (!(await isMember(userId))) throw new ForbiddenException();', // 6
      '  } catch (e) {', // 7
      '    throw e;', // 8
      '  }', // 9
      '  void assertMember(userId);', // 10
      '  await assertOwner(userId).catch(() => undefined);', // 11
      '  await db.doc.delete({ where: {} });', // 12
      '}',
    ].join('\n');
    const scan = guardsBeforeSite('f.ts', text, 12);
    expect(scan.status).toBe('ok');
    const guards = scan.status === 'ok' ? scan.guards : [];
    const exits = guards.filter((g) => g.kind === 'exit').map((g) => g.conditionLine);
    const calls = guards.filter((g) => g.kind === 'call').map((g) => g.name);
    expect(exits).toEqual([6]);
    expect(calls).toContain('isMember');
    expect(calls).not.toContain('findFirst');
    expect(calls).not.toContain('assertMember');
    expect(calls).not.toContain('assertOwner');
  });
});

// ── verdict rules for sequence (concurrency / atomicity) claims ───────────────────────

function assess(
  path: string,
  text: string,
  focus: number,
  claim: { title: string; explanation: string; category?: 'data_integrity' | 'correctness' },
  output: Partial<VerificationOutput>,
) {
  const lines = text.split('\n');
  const section: CodeSection = {
    path,
    label: 'code at PR head',
    lines: lines.map((t, i) => ({ tag: 'HEAD' as const, n: i + 1, old: null, text: t })),
    focus: focus - 1,
  };
  const finding = validatedFinding({
    path,
    category: claim.category ?? 'data_integrity',
    title: claim.title,
    explanation: claim.explanation,
    lineStart: focus,
    lineEnd: focus,
    headLine: focus,
    evidence: lines[focus - 1]!.trim(),
  });
  const { provided } = buildVerificationContent({
    finding,
    sections: [section],
    fileTexts: new Map([[path, text]]),
  });
  return assessVerdict(
    {
      verdict: 'refuted',
      severity: 'low',
      reasoning: 'r',
      decisiveCode: '',
      failureSite: '',
      dependsOnCodeNotShown: false,
      reachableTrigger: '',
      violatedInvariant: '',
      triggerSource: '',
      guardsOnPath: [],
      ...output,
    },
    finding,
    provided,
  );
}

const RACE = {
  title: 'Seat count and insert can race under concurrent invitations',
  explanation: 'Two concurrent requests read the same count before either inserts.',
};

describe('verdicts on concurrency claims', () => {
  it('a refutation citing the enclosing lock dismisses a false race claim', () => {
    const v = assess('s.ts', LOCKED, lineOf(LOCKED, 'membership.count'), RACE, {
      decisiveCode: 'await db.lock(`seats:${workspaceId}`, async () => {',
    });
    expect(v).toMatchObject({ verdict: 'refuted', audit: { rule: 'refuted' } });
  });

  it('quoting the check itself does not refute a real race (no protection)', () => {
    const v = assess('s.ts', UNLOCKED, lineOf(UNLOCKED, 'membership.count'), RACE, {
      decisiveCode: "if (count >= limit) {\nthrow new Error('SEAT_LIMIT');",
    });
    expect(v).toMatchObject({
      verdict: 'insufficient_context',
      audit: { rule: 'refute_concurrency_gap' },
    });
  });

  it('a protection that exists but is not cited does not refute (the answer must rest on it)', () => {
    const v = assess('s.ts', LOCKED, lineOf(LOCKED, 'membership.count'), RACE, {
      decisiveCode: "if (count >= limit) {\nthrow new Error('SEAT_LIMIT');",
    });
    expect(v.verdict).toBe('insufficient_context');
    expect(v.reason).toContain('does not cite');
  });

  it('"it runs in a transaction" does not refute a lost update at default isolation', () => {
    const v = assess(
      'w.ts',
      TX_WEAK,
      lineOf(TX_WEAK, 'tx.account.update'),
      {
        title: 'Concurrent withdrawals can overdraw',
        explanation: 'Two withdrawals read the same balance concurrently and both pass.',
      },
      { decisiveCode: 'await db.$transaction(async (tx) => {' },
    );
    expect(v.verdict).toBe('insufficient_context');
    expect(v.reason).toContain('default isolation');
  });

  it('a race confirmation on code serialized by a lock is not accepted', () => {
    const at = lineOf(LOCKED, 'membership.create');
    const v = assess('s.ts', LOCKED, at, RACE, {
      verdict: 'confirmed',
      severity: 'medium',
      decisiveCode:
        "if (count >= limit) {\nawait db.membership.create({ data: { workspaceId, userId, role: 'member' } });",
      failureSite: `s.ts:${at}`,
      reachableTrigger: 'Two invitations for the last seat at the same time',
      violatedInvariant: 'Members never exceed the seat limit',
      triggerSource: 'limit: number,',
    });
    expect(v).toMatchObject({
      verdict: 'insufficient_context',
      audit: { rule: 'concurrency_protected' },
    });
  });

  it('a correctness-category race is judged the same way (not by "any grounded line")', () => {
    const v = assess(
      's.ts',
      UNLOCKED,
      lineOf(UNLOCKED, 'membership.count'),
      { ...RACE, category: 'correctness' },
      { decisiveCode: 'const count = await db.membership.count({ where: { workspaceId } });' },
    );
    expect(v.audit.rule).toBe('refute_concurrency_gap');
  });
});

describe('verdicts on atomicity claims', () => {
  const PARTIAL = {
    title: 'Credit failure leaves the debit applied (partial transfer)',
    explanation: 'If the credit update fails after the debit, the sender loses credits.',
  };

  it('both writes in one transaction: a refutation citing it dismisses the claim', () => {
    const v = assess('t.ts', TX_GROUPED, lineOf(TX_GROUPED, 'id: toId'), PARTIAL, {
      decisiveCode: 'await db.$transaction(async (tx) => {',
    });
    expect(v.verdict).toBe('refuted');
  });

  it('separate writes: "refuted" is not accepted', () => {
    const separate = TX_GROUPED.replace('await db.$transaction(async (tx) => {', '{').replace(
      /tx\./g,
      'db.',
    );
    const v = assess('t.ts', separate, lineOf(separate, 'id: toId'), PARTIAL, {
      decisiveCode:
        'await db.account.update({ where: { id: toId }, data: { credits: { increment: amount } } });',
    });
    expect(v).toMatchObject({
      verdict: 'insufficient_context',
      audit: { rule: 'refute_concurrency_gap' },
    });
  });
});
