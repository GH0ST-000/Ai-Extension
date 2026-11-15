/**
 * Regression tests for the two deterministic verification defects found by the first captured
 * live benchmark (capture 2026-11-13T14-00-09-949Z-gpt-4o-mini-255fd1), using the exact corpus
 * sources the model reviewed and the verifier answers it gave.
 *
 * 1. A structural evidence line (`});`) made independent decisive code look like a restatement.
 * 2. A quote that collapses consecutive source lines onto one line was treated as ungrounded.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CodeLine, CodeSection } from './pr-review-context';
import { validatedFinding } from './pr-review-fixtures';
import {
  assessVerdict,
  buildVerificationContent,
  decisiveCodeIsGrounded,
  expandJoinedQuote,
  restatesLine,
  type VerificationOutput,
} from './pr-review-verify';

const CORPUS = join(__dirname, '../../../test/benchmark/corpus');
const NOTES = 'apps/api/src/notes/notes.service.ts';
const MEMBERS = 'apps/api/src/members/members.service.ts';
const notesHead = readFileSync(join(CORPUS, 'authz-bypass/head/notes.service.ts'), 'utf8');
const membersHead = readFileSync(join(CORPUS, 'clean-defensive/head/members.service.ts'), 'utf8');

const head = (text: string, from: number, to: number): CodeLine[] =>
  text
    .split('\n')
    .slice(from - 1, to)
    .map((t, i) => ({ tag: 'HEAD' as const, n: from + i, old: null, text: t }));

const section = (path: string, lines: CodeLine[], label = 'code at PR head'): CodeSection => ({
  path,
  label,
  lines,
  focus: 0,
});

const answer = (over: Partial<VerificationOutput>): VerificationOutput => ({
  verdict: 'refuted',
  severity: 'medium',
  reasoning: 'r',
  decisiveCode: '',
  failureSite: '',
  dependsOnCodeNotShown: false,
  reachableTrigger: '',
  violatedInvariant: '',
  triggerSource: '',
  guardsOnPath: [],
  ...over,
});

// The authz-bypass PR: the membership lookup and its guard were deleted before the delete.
const DELETED_GUARD = [
  '  const membership = await db.membership.findFirst({',
  '    where: { workspaceId: note.workspaceId, userId },',
  '  });',
  '  if (!membership) {',
  "    throw new Error('FORBIDDEN');",
  '  }',
];
function authzDiffSection(): CodeSection {
  return section(NOTES, [
    ...head(notesHead, 7, 11).map((l) => ({ ...l, tag: 'CTX' as const })),
    ...DELETED_GUARD.map((text, i) => ({ tag: 'DEL' as const, n: null, old: 12 + i, text })),
    ...head(notesHead, 12, 13).map((l) => ({ ...l, tag: 'CTX' as const })),
  ]);
}

function assessAuthz(output: VerificationOutput, evidence: string) {
  const finding = validatedFinding({
    path: NOTES,
    category: 'security',
    severity: 'high',
    lineStart: 12,
    lineEnd: 12,
    headLine: 12,
    changeType: 'removed_safeguard',
    evidence,
  });
  const { provided } = buildVerificationContent({
    finding,
    sections: [authzDiffSection()],
    fileTexts: new Map([[NOTES, notesHead]]),
  });
  return assessVerdict(output, finding, provided);
}

function assessMembers(output: VerificationOutput, category: 'security' | 'availability') {
  const finding = validatedFinding({
    path: MEMBERS,
    category,
    severity: 'medium',
    lineStart: 14,
    lineEnd: 14,
    headLine: 14,
    evidence: "if (!actor || actor.role !== 'owner') {",
  });
  const { provided } = buildVerificationContent({
    finding,
    sections: [section(MEMBERS, head(membersHead, 6, 28))],
    fileTexts: new Map([[MEMBERS, membersHead]]),
  });
  return assessVerdict(output, finding, provided);
}

// Verbatim verifier answer of authz-bypass run 0 (confirmed, independent decisive code).
const AUTHZ_RUN0 = answer({
  verdict: 'confirmed',
  severity: 'high',
  decisiveCode: 'await db.note.delete({ where: { id: noteId } });',
  failureSite: 'apps/api/src/notes/notes.service.ts:12',
  reachableTrigger: 'A user attempts to delete a note without being a member of the workspace.',
  violatedInvariant:
    'Authorization check for workspace membership is missing before deleting a note.',
  triggerSource: 'const note = await db.note.findUnique({ where: { id: noteId } });',
  guardsOnPath: [
    {
      code: "if (!note) {\n    throw new Error('NOT_FOUND');\n}",
      whyNotPreventing: 'This guard only checks if the note exists, not if the user is authorized.',
    },
  ],
});
// Its batch evidence: three deleted lines ending in the structural `});`.
const AUTHZ_RUN0_EVIDENCE =
  '-  const membership = await db.membership.findFirst({\n-    where: { workspaceId: note.workspaceId, userId },\n-  });';

describe('restates_evidence compares substantive code only', () => {
  it('a structural evidence line never makes independent code a restatement', () => {
    expect(restatesLine('await db.note.delete({ where: { id: noteId } });', '});')).toBe(false);
    expect(restatesLine('await db.note.delete({ where: { id: noteId } });', '}')).toBe(false);
    expect(restatesLine('await db.note.delete({ where: { id: noteId } });', 'return;')).toBe(false);
  });

  it('the same line, any part of it, or a line that is mostly it is a restatement', () => {
    const line = 'const count = await db.membership.count({ where: { workspaceId } });';
    expect(restatesLine(line, line)).toBe(true);
    expect(
      restatesLine('const count  =  await db.membership.count({where:{workspaceId}})', line),
    ).toBe(true);
    expect(restatesLine('db.membership.count({ where: { workspaceId } })', line)).toBe(true);
    expect(restatesLine(`${line} // seats`, line)).toBe(true);
    // Independent code sharing a short identifier is not a restatement.
    expect(
      restatesLine('await db.membership.create({ data: { workspaceId, userId } });', line),
    ).toBe(false);
  });

  it('authz-bypass run 0: an independent confirmation is no longer blocked by `});`', () => {
    const v = assessAuthz(AUTHZ_RUN0, AUTHZ_RUN0_EVIDENCE);
    expect(v.audit.rule).not.toBe('restates_evidence');
    expect(v.verdict).toBe('confirmed');
  });

  it('a verifier that only repeats the suspicious line is still blocked', () => {
    const repeat = assessAuthz(
      answer({
        ...AUTHZ_RUN0,
        decisiveCode: 'await db.note.delete({ where: { id: noteId } });',
      }),
      'await db.note.delete({ where: { id: noteId } });',
    );
    expect(repeat.verdict).toBe('insufficient_context');
    expect(repeat.audit.rule).toBe('restates_evidence');

    const fragment = assessAuthz(
      answer({ ...AUTHZ_RUN0, decisiveCode: 'db.note.delete({ where: { id: noteId } })' }),
      'await db.note.delete({ where: { id: noteId } });',
    );
    expect(fragment.audit.rule).toBe('restates_evidence');
  });

  it('an unsupported confirmation quoting code that is not shown stays blocked', () => {
    const v = assessAuthz(
      answer({ ...AUTHZ_RUN0, decisiveCode: 'await db.note.purgeAll({ force: true });' }),
      AUTHZ_RUN0_EVIDENCE,
    );
    expect(v.verdict).toBe('insufficient_context');
    expect(v.audit.rule).toBe('not_grounded');
  });
});

describe('joined decisive-code quotes', () => {
  const codeText = (sections: CodeSection[]) =>
    buildVerificationContent({
      finding: validatedFinding({ path: MEMBERS, lineStart: 14, headLine: 14 }),
      sections,
      fileTexts: new Map([[MEMBERS, membersHead]]),
    }).provided.codeText;
  const members = codeText([section(MEMBERS, head(membersHead, 6, 28))]);

  it('expands a quote that joins consecutive whole lines into those exact lines', () => {
    const joined = "if (!actor || actor.role !== 'owner') { throw new Error('FORBIDDEN'); }";
    expect(decisiveCodeIsGrounded(joined, members)).toBe(false);
    const expanded = expandJoinedQuote(joined, members);
    expect(expanded).toBe(
      "  if (!actor || actor.role !== 'owner') {\n    throw new Error('FORBIDDEN');\n  }",
    );
    expect(decisiveCodeIsGrounded(expanded, members)).toBe(true);
    // Whitespace and a trailing comma before a closer do not matter.
    expect(
      expandJoinedQuote("if(!actor||actor.role!=='owner'){throw new Error('FORBIDDEN');}", members),
    ).toBe(expanded);
  });

  it('keeps lines already present in the code unchanged', () => {
    const quote = "if (!actor || actor.role !== 'owner') {\nthrow new Error('FORBIDDEN');";
    expect(expandJoinedQuote(quote, members)).toBe(quote);
  });

  it('adversarial: fragments stitched from non-contiguous lines are not grounded', () => {
    // Guard condition (L14) + an unrelated branch body (L19) + a brace.
    const stitched = "if (!actor || actor.role !== 'owner') { return { removed: false }; }";
    expect(expandJoinedQuote(stitched, members)).toBe(stitched);
    expect(decisiveCodeIsGrounded(expandJoinedQuote(stitched, members), members)).toBe(false);
    // Lines in the wrong order.
    const reordered = "throw new Error('FORBIDDEN'); if (!actor || actor.role !== 'owner') {";
    expect(decisiveCodeIsGrounded(expandJoinedQuote(reordered, members), members)).toBe(false);
  });

  it('adversarial: partial lines joined together are not grounded', () => {
    const partial = "actor.role !== 'owner') { throw new Error('FORBIDDEN');";
    expect(expandJoinedQuote(partial, members)).toBe(partial);
    expect(decisiveCodeIsGrounded(partial, members)).toBe(false);
  });

  it('adversarial: lines across a gap, another section, or deleted + head lines are not joined', () => {
    // A gap: L14 and L16 are shown, L15 is not.
    const gapped = codeText([
      section(MEMBERS, [...head(membersHead, 13, 14), ...head(membersHead, 16, 18)]),
    ]);
    expect(expandJoinedQuote("if (!actor || actor.role !== 'owner') { }", gapped)).toBe(
      "if (!actor || actor.role !== 'owner') { }",
    );
    // Two sections: the end of one and the start of the next are not contiguous source.
    const split = codeText([
      section(MEMBERS, head(membersHead, 13, 14)),
      section(MEMBERS, head(membersHead, 15, 16), 'another window'),
    ]);
    const across = "if (!actor || actor.role !== 'owner') { throw new Error('FORBIDDEN');";
    expect(expandJoinedQuote(across, split)).toBe(across);
    // A deleted guard joined with the head line that follows it never ran together.
    const diff = codeText([authzDiffSection()]);
    const mixed = 'if (!membership) { await db.note.delete({ where: { id: noteId } });';
    expect(expandJoinedQuote(mixed, diff)).toBe(mixed);
    expect(decisiveCodeIsGrounded(mixed, diff)).toBe(false);
  });

  it('a joined quote may not exceed the contiguous-run limit', () => {
    const longJoin = membersHead.split('\n').slice(5, 28).join(' ');
    expect(expandJoinedQuote(longJoin, members)).toBe(longJoin);
  });
});

describe('captured clean-defensive run 0 and security refutation requirements', () => {
  // Verbatim verifier answer: a correct refutation quoting the owner guard on one line.
  const CLEAN_RUN0 = answer({
    verdict: 'refuted',
    reasoning: 'The guard ensures only an owner can remove members.',
    decisiveCode: "if (!actor || actor.role !== 'owner') { throw new Error('FORBIDDEN'); }",
    failureSite: 'apps/api/src/members/members.service.ts:14',
    guardsOnPath: [
      {
        code: "if (!actor || actor.role !== 'owner') { throw new Error('FORBIDDEN'); }",
        whyNotPreventing: 'This guard prevents unauthorized users from deleting members.',
      },
    ],
  });

  it('is refuted with the grounded multi-line quote (was refute_not_grounded)', () => {
    const v = assessMembers(CLEAN_RUN0, 'security');
    expect(v.verdict).toBe('refuted');
    expect(v.audit.rule).toBe('refuted');
  });

  it('a grounded joined quote that holds no denial does not refute a security claim', () => {
    const v = assessMembers(
      answer({
        decisiveCode:
          'try { await db.membership.delete({ where: { workspaceId, userId: memberId } }); } catch (error) {',
      }),
      'security',
    );
    expect(v.verdict).toBe('insufficient_context');
    expect(v.audit.rule).toBe('refute_security_gap');
  });

  it('a stitched refutation stays ungrounded (no dismissal)', () => {
    const v = assessMembers(
      answer({
        decisiveCode: "if (!actor || actor.role !== 'owner') { return { removed: false }; }",
      }),
      'security',
    );
    expect(v.verdict).toBe('insufficient_context');
    expect(v.audit.rule).toBe('refute_not_grounded');
  });

  it('a real authorization bug is not dismissed by a joined quote of an unrelated guard', () => {
    // Wrong refutation of authz-bypass: the note-existence guard, joined onto one line.
    const v = assessAuthz(
      answer({ decisiveCode: "if (!note) { throw new Error('NOT_FOUND'); }" }),
      AUTHZ_RUN0_EVIDENCE,
    );
    expect(v.verdict).toBe('insufficient_context');
    expect(v.audit.rule).toBe('refute_security_gap');
  });
});
