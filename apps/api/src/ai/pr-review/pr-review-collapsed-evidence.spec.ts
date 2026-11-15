/**
 * Collapsed multi-line evidence in candidate generation (live capture 1d1332, clean-defensive
 * run 1 quoted `if (…) { throw …; }` on one line): accepted only when it equals the whole
 * lines of one contiguous source run; fabricated, reordered, non-contiguous, partial and
 * deleted+added stitched quotes stay ungrounded.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { matchEvidenceAll, parsePatch } from './diff-hunks';
import { extractCalls } from './pr-review-deps';

const PATCH = [
  '@@ -10,6 +10,8 @@ export async function removeMember(',
  '   const actor = await db.membership.findFirst({ where: { workspaceId, userId: actorId } });',
  '-  if (!actor) {',
  "-    throw new Error('NOT_A_MEMBER');",
  '-  }',
  "+  if (!actor || actor.role !== 'owner') {",
  "+    throw new Error('FORBIDDEN');",
  '+  }',
  '   const target = await db.membership.findFirst({ where: { workspaceId, userId: memberId } });',
  '+  if (!target) {',
  '+    return { removed: false };',
  '+  }',
].join('\n');
const lines = parsePatch(PATCH).flatMap((h) => h.lines);
const match = (evidence: string) => matchEvidenceAll(lines, evidence)[0] ?? null;

describe('collapsed multi-line evidence', () => {
  it('a block collapsed onto one line matches its exact source lines', () => {
    const m = match("if (!actor || actor.role !== 'owner') { throw new Error('FORBIDDEN'); }");
    // The closing brace carries no content and is not a separate evidence line.
    expect(m?.map((x) => [x.line.kind, x.line.newLine])).toEqual([
      ['+', 11],
      ['+', 12],
    ]);
    // Whitespace does not matter; the quote must still cover whole lines.
    expect(match("if(!actor||actor.role!=='owner'){throw new Error('FORBIDDEN');}")).not.toBeNull();
  });

  it('a collapsed DELETED block matches deleted lines (removed-safeguard evidence)', () => {
    const m = match("-  if (!actor) { throw new Error('NOT_A_MEMBER'); }");
    expect(m?.map((x) => [x.line.kind, x.line.oldLine])).toEqual([
      ['-', 11],
      ['-', 12],
    ]);
  });

  it.each([
    [
      'fabricated content',
      "if (!actor || actor.role !== 'admin') { throw new Error('FORBIDDEN'); }",
    ],
    ['reordered lines', "throw new Error('FORBIDDEN'); if (!actor || actor.role !== 'owner') {"],
    [
      'non-contiguous lines',
      "if (!actor || actor.role !== 'owner') { return { removed: false }; }",
    ],
    ['a partial line', "actor.role !== 'owner') { throw new Error('FORBIDDEN');"],
    ['deleted + added stitched', "if (!actor) { throw new Error('FORBIDDEN'); }"],
  ])('%s is not grounded', (_label, evidence) => {
    expect(match(evidence)).toBeNull();
  });
});

describe('dependency calls', () => {
  it('a method signature in a type is not a call (no phantom unresolved dependency)', () => {
    const calls = extractCalls('s.ts', [
      { n: 6, text: '  lock<R>(key: string, fn: () => Promise<R>): Promise<R>;' },
      { n: 7, text: '  find?(id: string): Promise<Row | null>' },
      { n: 15, text: '  await lockSeats(workspaceId);' },
    ]);
    expect(calls.map((c) => `${c.site.line}:${c.name}`)).toEqual(['15:lockSeats']);
  });
});

// ── inline diff markers at line boundaries (live capture 904aa9, authz-bypass run 0) ─────

const AUTHZ_PATCH = readFileSync(
  join(__dirname, '../../../test/benchmark/corpus/authz-bypass/diff.patch'),
  'utf8',
);
const authzLines = parsePatch(AUTHZ_PATCH.slice(AUTHZ_PATCH.indexOf('\n@@') + 1)).flatMap(
  (h) => h.lines,
);
const authzMatch = (evidence: string) => matchEvidenceAll(authzLines, evidence)[0] ?? null;

/** Exactly as the model returned it: six deleted lines joined, each keeping its `-` marker. */
const CAPTURED_904AA9_RUN0 =
  "-  const membership = await db.membership.findFirst({ -    where: { workspaceId: note.workspaceId, userId }, -  }); -  if (!membership) { -    throw new Error('FORBIDDEN'); -  }";

describe('collapsed evidence with inline diff markers', () => {
  it('the captured authz-bypass run 0 evidence matches the removed membership check', () => {
    const m = authzMatch(CAPTURED_904AA9_RUN0);
    expect(m).not.toBeNull();
    expect(m!.every((x) => x.line.kind === '-')).toBe(true);
    const old = m!.map((x) => x.line.oldLine!);
    expect(old[0]).toBe(12);
    expect(old).toEqual(old.map((_, i) => 12 + i)); // contiguous deleted lines
  });

  it('the first marker is optional; every later boundary marker must be present and correct', () => {
    expect(authzMatch(CAPTURED_904AA9_RUN0.slice(1))).not.toBeNull();
    // `+` markers on deleted lines are not their markers.
    expect(authzMatch(CAPTURED_904AA9_RUN0.replace(/ - {2}/g, ' +  '))).toBeNull();
  });

  it.each([
    [
      'reordered lines',
      "-  if (!membership) { -  const membership = await db.membership.findFirst({ -    throw new Error('FORBIDDEN');",
    ],
    [
      'a skipped line (non-contiguous)',
      '-  const membership = await db.membership.findFirst({ -  }); -  if (!membership) {',
    ],
    [
      'a partial last line',
      '-  const membership = await db.membership.findFirst({ -    where: { workspaceId',
    ],
    [
      'a fabricated line',
      '-  const membership = await db.membership.findFirst({ -    where: { workspaceId: note.workspaceId }, -  });',
    ],
    [
      'deleted + head lines joined',
      "-  if (!membership) { -    throw new Error('FORBIDDEN'); -  }   await db.note.delete({ where: { id: noteId } });",
    ],
  ])('%s is not grounded', (_label, evidence) => {
    expect(authzMatch(evidence)).toBeNull();
  });
});

describe('minus signs that are not diff markers', () => {
  const ARITH = [
    '@@ -1,2 +1,3 @@',
    '-  const total = price - discount;',
    '-  return total;',
    '+  const total = price - discount - fee;',
    "+  const label = 'price -  discount';",
    '+  return total;',
  ].join('\n');
  const arith = parsePatch(ARITH).flatMap((h) => h.lines);
  const m = (evidence: string) => matchEvidenceAll(arith, evidence)[0] ?? null;

  it('arithmetic minus inside a quoted line is code, not a line boundary', () => {
    const one = m('+  const total = price - discount - fee;');
    expect(one?.map((x) => [x.line.kind, x.line.newLine])).toEqual([['+', 1]]);
    const del = m('-  const total = price - discount;');
    expect(del?.map((x) => [x.line.kind, x.line.oldLine])).toEqual([['-', 1]]);
  });

  it('a string literal containing " -  " is matched as written', () => {
    const lit = m("+  const label = 'price -  discount';");
    expect(lit?.map((x) => x.line.newLine)).toEqual([2]);
  });

  it('collapsed added lines with their markers match (arithmetic and strings intact)', () => {
    const both = m(
      "+  const total = price - discount - fee; +  const label = 'price -  discount';",
    );
    expect(both?.map((x) => [x.line.kind, x.line.newLine])).toEqual([
      ['+', 1],
      ['+', 2],
    ]);
  });

  it.each([
    ['an arithmetic minus used as a fake join', '+  const total = price - return total;'],
    ['a string literal spliced into another line', "+  const label = 'price - +  return total;"],
    [
      'deleted markers on added lines',
      "-  const total = price - discount - fee; -  const label = 'price -  discount';",
    ],
    ['mixed deleted and added lines', '-  return total; +  const total = price - discount - fee;'],
    ['a dropped arithmetic term', '+  const total = price - fee; +  return total;'],
  ])('%s is not grounded', (_label, evidence) => {
    expect(m(evidence)).toBeNull();
  });
});
