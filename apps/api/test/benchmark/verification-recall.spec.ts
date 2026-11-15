/**
 * Verification recall without weakening safety — regressions from Live Benchmark #2
 * (capture 2026-11-13T16-03-19-088Z-gpt-4o-mini-1d1332), run through the REAL pipeline
 * (context builder, dependency resolution, verdict rules) on the benchmark corpus.
 *
 * The verifier answers reproduce the captured failure patterns: a correct confirmation that
 * ALSO sets `dependsOnCodeNotShown` (5 of 8 live bug verifications), failure sites given as a
 * quoted line or `function:line`, guard lists that skip guards unrelated to the claim. The same
 * kind of answer on SAFE corpus implementations (proven safe by their witnesses) must never
 * become Confirmed.
 */
import { describe, expect, it, vi } from 'vitest';

import type { BatchFindingInput } from '../../src/ai/pr-review/pr-review-findings';
import type { VerificationOutput } from '../../src/ai/pr-review/pr-review-verify';
import { loadCorpus, runCase, type CandidateTrace } from './harness';

const generateTextMock = vi.fn();
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: (...args: unknown[]) => generateTextMock(...args) };
});

const corpus = new Map(loadCorpus().map((c) => [c.id, c]));

/** The case's own scripted (diff-grounded) batch finding, optionally re-described. */
function findingOf(caseId: string, over: Partial<BatchFindingInput> = {}): BatchFindingInput {
  const c = corpus.get(caseId)!;
  return { ...c.responses.runs[0]!.batch.findings[0]!, ...over };
}

function confirmation(over: Partial<VerificationOutput>): VerificationOutput {
  return {
    verdict: 'confirmed',
    severity: 'high',
    reasoning: 'captured-style confirmation',
    decisiveCode: '',
    failureSite: '',
    dependsOnCodeNotShown: false,
    reachableTrigger: 'Two requests for the last seat arrive at the same time',
    violatedInvariant: 'The documented invariant must hold for every request',
    triggerSource: '',
    guardsOnPath: [],
    ...over,
  };
}

/** Run one case with one batch finding and one verifier answer; return its trace. */
async function verify(
  caseId: string,
  finding: BatchFindingInput,
  answer: VerificationOutput,
): Promise<CandidateTrace> {
  const c = corpus.get(caseId)!;
  const run = await runCase(c, 'recall', generateTextMock, {
    responder: async (call) => ({
      output:
        call.stage === 'batch'
          ? {
              summary: 's',
              findings: (call.identity.files ?? []).includes(finding.path) ? [finding] : [],
            }
          : answer,
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  });
  return run!.candidates[0]!;
}

const decision = (t: CandidateTrace) => t.verification?.decision;

// ── 1. genuine bugs: the flag yields to a grounded failure mechanism ─────────────────

describe('captured patterns: correct confirmations that also set dependsOnCodeNotShown', () => {
  it('race-condition (removed lock): unserialized check-then-act is grounded → confirmed', async () => {
    // The live finding (capture 1d1332 run 0): evidence is the deleted lock line.
    const f = findingOf('race-condition', {
      title: 'Removed Locking Mechanism',
      explanation:
        'The removed lock allows concurrent execution of addMember, so members can be added beyond the limit.',
      category: 'data_integrity',
      changeType: 'removed_safeguard',
      evidence: '-  await db.lock(`seats:${workspaceId}`, async () => {',
      lineStart: 12,
      lineEnd: 12,
    });
    for (const failureSite of [
      'if (count >= limit) {', // captured run 0: the site as a quoted line
      'addMember:15', // captured run 1: function:line
    ]) {
      const t = await verify(
        'race-condition',
        f,
        confirmation({
          dependsOnCodeNotShown: true,
          decisiveCode:
            "const count = await db.membership.count({ where: { workspaceId } });\nawait db.membership.create({ data: { workspaceId, userId, role: 'member' } });",
          failureSite,
          triggerSource: 'limit: number,',
          guardsOnPath: [],
        }),
      );
      expect([failureSite, t.final, decision(t)]).toEqual([failureSite, 'confirmed', 'confirmed']);
    }
  });

  it('webhook-idempotency (removed duplicate check): removed safeguard not replaced → confirmed', async () => {
    const f = findingOf('webhook-idempotency');
    const t = await verify(
      'webhook-idempotency',
      f,
      confirmation({
        dependsOnCodeNotShown: true,
        decisiveCode:
          'const account = await db.account.findUnique({ where: { id: event.accountId } });\nawait db.account.update({ where: { id: account.id }, data: { credits: account.credits + event.amount } });',
        failureSite: 'apps/api/src/billing/payment-webhook.ts:19',
        reachableTrigger: 'The provider redelivers the same payment.succeeded event',
        triggerSource: 'event: PaymentEvent,',
        // Captured run 1 explained only the event-type check; `if (!account)` is unrelated.
        guardsOnPath: [
          {
            code: "if (event.type !== 'payment.succeeded') {",
            whyNotPreventing: 'It only filters the event type, not repeated events.',
          },
        ],
      }),
    );
    expect([t.final, decision(t)]).toEqual(['confirmed', 'confirmed']);
  });

  it('helper-never-denies (ignored helper result): grounded → confirmed, and `if (!note)` need not be answered', async () => {
    const f = findingOf('helper-never-denies');
    for (const dependsOnCodeNotShown of [true, false]) {
      const t = await verify(
        'helper-never-denies',
        f,
        confirmation({
          dependsOnCodeNotShown,
          decisiveCode:
            'return membership != null;\nawait db.note.delete({ where: { id: noteId } });',
          failureSite: 'apps/api/src/notes/notes.service.ts:14',
          reachableTrigger: 'A user who is not a member deletes a note by id',
          triggerSource:
            'export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {',
          // Captured run 1: only a comment, the existence check was not explained.
          guardsOnPath: [
            {
              code: '// There are no checks on the output of assertMember',
              whyNotPreventing: 'The boolean result is discarded before the delete.',
            },
          ],
        }),
      );
      expect([dependsOnCodeNotShown, t.final]).toEqual([dependsOnCodeNotShown, 'confirmed']);
    }
  });

  it('helper-unavailable: relevant code is genuinely missing → stays Needs Investigation', async () => {
    const f = findingOf('helper-unavailable');
    const t = await verify(
      'helper-unavailable',
      f,
      confirmation({
        dependsOnCodeNotShown: true,
        decisiveCode:
          'await requireWorkspaceMember(db, note.workspaceId, userId);\nawait db.note.delete({ where: { id: noteId } });',
        failureSite: 'apps/api/src/notes/notes.service.ts:14',
        reachableTrigger: 'A non-member deletes a note by id',
        triggerSource:
          'export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {',
      }),
    );
    expect(t.final).toBe('needs_investigation');
    expect(decision(t)).toMatch(
      /depends_on_code_not_shown|guard_unresolved|security_guard_uninspected/,
    );
  });
});

// ── 2. safe implementations: the same kind of answer never becomes Confirmed ──────────

describe('adversarial: flagged confirmations of SAFE implementations stay unconfirmed', () => {
  const race = {
    title: 'Concurrent requests can exceed the limit (check-then-act)',
    explanation: 'Two concurrent requests read the same state before either writes.',
  };

  it.each([
    [
      'race-locked',
      "const count = await db.membership.count({ where: { workspaceId } });\nawait db.membership.create({ data: { workspaceId, userId, role: 'member' } });",
      'apps/api/src/workspaces/seats.ts:21',
    ],
    [
      'atomic-conditional-update',
      'const reserved = await db.event.updateMany({\nif (reserved.count === 0) {',
      'apps/api/src/events/tickets.ts:8',
    ],
    [
      'race-unique-constraint',
      "const existing = await db.invite.findFirst({ where: { workspaceId, email } });\nreturn await db.invite.create({ data: { workspaceId, email, status: 'pending' } });",
      'apps/api/src/invites/invites.service.ts:18',
    ],
  ])(
    '%s: a race claim confirmed with the flag is not confirmed',
    async (caseId, decisiveCode, site) => {
      const f = findingOf(caseId, { ...race, category: 'data_integrity' });
      const t = await verify(
        caseId,
        f,
        confirmation({ dependsOnCodeNotShown: true, decisiveCode, failureSite: site }),
      );
      // It reached verification (not trivially rejected) and a deterministic rule held it back.
      expect(t.validation).toBe('passed');
      expect(t.verification).not.toBeNull();
      expect(t.final).not.toBe('confirmed');
      console.info(`SAFE ${caseId}: ${String(decision(t))} -> ${t.final}`);
    },
  );

  it.each([
    ['moved-guard', 'apps/api/src/notes/notes.service.ts'],
    ['request-principal-userid', 'apps/api/src/notes/notes.handler.ts'],
    ['clean-defensive', 'apps/api/src/members/members.service.ts'],
    ['role-check-correct', 'apps/api/src/notes/notes.service.ts'],
  ])('%s: an authorization claim confirmed with the flag is not confirmed', async (caseId) => {
    const f = findingOf(caseId, {
      category: 'security',
      title: 'Missing membership authorization before the write',
      explanation: 'Any user can act on another workspace without membership.',
      changeType: 'removed_safeguard',
    });
    const t = await verify(
      caseId,
      f,
      confirmation({
        dependsOnCodeNotShown: true,
        decisiveCode: f.evidence,
        failureSite: `${f.path}:${f.lineStart}`,
        reachableTrigger: 'A user who is not a member sends the request',
      }),
    );
    // It reached verification (not trivially rejected) and a deterministic rule held it back.
    expect(t.validation).toBe('passed');
    expect(t.verification).not.toBeNull();
    expect(t.final).not.toBe('confirmed');
    console.info(`SAFE ${caseId}: ${String(decision(t))} -> ${t.final}`);
  });
});

// ── 3. failure-site resolution is strict ─────────────────────────────────────────────

describe('failure site formats', () => {
  const answer = (failureSite: string) =>
    confirmation({
      decisiveCode:
        "const count = await db.membership.count({ where: { workspaceId } });\nawait db.membership.create({ data: { workspaceId, userId, role: 'member' } });",
      failureSite,
      triggerSource: 'limit: number,',
    });

  it.each([
    ['a function that does not contain the line', 'removeMember:15'],
    ['a quote that is not in the code', 'await db.membership.createMany({ data: rows });'],
    ['a trivial quote', '}'],
  ])('%s is not a failure site', async (_label, site) => {
    const t = await verify('race-condition', findingOf('race-condition'), answer(site));
    expect(decision(t)).toBe('no_failure_site');
  });
});

// ── 4. answer quality: the exact live-#3 failure patterns (capture abd2cc) ──────────────

describe('captured answer-quality failures stay unconfirmed; well-formed answers confirm', () => {
  it('an empty trigger (authz-bypass run 1) is not confirmed; with the trigger it is', async () => {
    const f = findingOf('authz-bypass');
    const answer = (reachableTrigger: string) =>
      confirmation({
        decisiveCode: 'await db.note.delete({ where: { id: noteId } });',
        failureSite: 'apps/api/src/notes/notes.service.ts:12',
        reachableTrigger,
        violatedInvariant: 'Only members of the note workspace can delete it',
        triggerSource:
          'export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {',
      });
    expect(decision(await verify('authz-bypass', f, answer('')))).toBe('no_trigger');
    expect(
      (await verify('authz-bypass', f, answer('A user who is not a member deletes a note by id')))
        .final,
    ).toBe('confirmed');
  });

  it('evidence that only restates the count line (race-condition run 0) is not confirmed; with the sink it is', async () => {
    const f = findingOf('race-condition', {
      category: 'availability',
      title: 'Concurrently Adding Members May Exceed Seat Limit',
      explanation: 'Concurrent calls read the same count before either inserts.',
      changeType: 'removed_safeguard',
      evidence: '+  const count = await db.membership.count({ where: { workspaceId } });',
      lineStart: 15,
      lineEnd: 15,
    });
    const answer = (decisiveCode: string) =>
      confirmation({
        decisiveCode,
        failureSite: 'apps/api/src/workspaces/seats.ts:19',
        triggerSource: 'limit: number,',
      });
    const count = 'const count = await db.membership.count({ where: { workspaceId } });';
    expect(decision(await verify('race-condition', f, answer(count)))).toBe('restates_evidence');
    const sink = "await db.membership.create({ data: { workspaceId, userId, role: 'member' } });";
    expect((await verify('race-condition', f, answer(`${count}\n${sink}`))).final).toBe(
      'confirmed',
    );
  });

  it('a refutation that quotes the vulnerable operation (helper-never-denies run 0) never dismisses the bug', async () => {
    const t = await verify('helper-never-denies', findingOf('helper-never-denies'), {
      ...confirmation({}),
      verdict: 'refuted',
      decisiveCode: 'await db.note.delete({ where: { id: noteId } });',
    });
    expect(t.final).toBe('needs_investigation');
    expect(decision(t)).toBe('refute_security_gap');
  });

  it('a failure site before the sink (webhook-idempotency run 0, line 12) is not confirmed; the sink (19) is', async () => {
    const f = findingOf('webhook-idempotency');
    const answer = (failureSite: string) =>
      confirmation({
        decisiveCode:
          'const account = await db.account.findUnique({ where: { id: event.accountId } });\nawait db.account.update({ where: { id: account.id }, data: { credits: account.credits + event.amount } });',
        failureSite,
        reachableTrigger: 'The provider redelivers the same payment.succeeded event',
        triggerSource: 'event: PaymentEvent,',
      });
    expect(
      decision(
        await verify(
          'webhook-idempotency',
          f,
          answer('apps/api/src/billing/payment-webhook.ts:12'),
        ),
      ),
    ).toBe('site_before_finding');
    expect(
      (await verify('webhook-idempotency', f, answer('apps/api/src/billing/payment-webhook.ts:19')))
        .final,
    ).toBe('confirmed');
  });

  it('safe counterexamples: correct refutations of safe code are still accepted', async () => {
    const clean = await verify('clean-defensive', findingOf('clean-defensive'), {
      ...confirmation({}),
      verdict: 'refuted',
      decisiveCode: "if (!actor || actor.role !== 'owner') {\nthrow new Error('FORBIDDEN');",
    });
    expect(clean.final).toBe('dismissed');
    const locked = await verify('race-locked', findingOf('race-locked'), {
      ...confirmation({}),
      verdict: 'refuted',
      decisiveCode: 'await db.lock(`seats:${workspaceId}`, async () => {',
    });
    expect(locked.final).toBe('dismissed');
  });
});

// ── 5. live #4 miss (capture 904aa9, authz-bypass run 0): inline diff markers ────────────

describe('collapsed evidence with inline diff markers reaches verification', () => {
  it('the exact captured authz-bypass run 0 finding passes validation and can be confirmed', async () => {
    const f = findingOf('authz-bypass', {
      title: 'Missing Workspace Membership Check',
      category: 'security',
      severity: 'high',
      changeType: 'removed_safeguard',
      lineStart: 10,
      lineEnd: 15,
      evidence:
        "-  const membership = await db.membership.findFirst({ -    where: { workspaceId: note.workspaceId, userId }, -  }); -  if (!membership) { -    throw new Error('FORBIDDEN'); -  }",
    });
    const t = await verify(
      'authz-bypass',
      f,
      confirmation({
        decisiveCode: 'await db.note.delete({ where: { id: noteId } });',
        failureSite: 'apps/api/src/notes/notes.service.ts:12',
        reachableTrigger: 'A user who is not a member deletes a note by id',
        violatedInvariant: 'Only members of the note workspace can delete it',
        triggerSource:
          'export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {',
      }),
    );
    expect(t.validation).toBe('passed');
    expect(t.truth).toBe('authz-bypass/delete-without-membership');
    expect(t.final).toBe('confirmed');
  });
});
