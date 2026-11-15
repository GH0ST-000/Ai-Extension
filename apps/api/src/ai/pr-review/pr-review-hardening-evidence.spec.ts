/**
 * Regression tests for evidence parsing / grounding in batch finding validation and for
 * pre-verification dedup. Each case pins the corrected behaviour of a defect found in an
 * audit; tests named `KNOWN LIMITATION:` pin behaviour that is still not the desired one.
 */
import { describe, expect, it } from 'vitest';

import { chunkPatch } from './diff-hunks';
import {
  DEFENSIVE_EVIDENCE_RE,
  mergeFindings,
  validateBatchFindings,
  type BatchFindingInput,
} from './pr-review-findings';
import { rawFinding, validatedFinding } from './pr-review-fixtures';
import type { PlannedBatch } from './pr-review-plan';

const batchOf = (patch: string): PlannedBatch => ({
  id: 'b1',
  diffChars: patch.length,
  units: [{ path: 'src/a.ts', chunkIndex: 0, chunkCount: 1, chunk: chunkPatch(patch, 10_000)[0]! }],
});
const run = (patch: string, findings: BatchFindingInput[]) =>
  validateBatchFindings({ summary: 's', findings }, batchOf(patch));

const PATCH = [
  '@@ -10,7 +50,9 @@ export class MemoryService {',
  '   async list(userId: string, workspaceId: string) {',
  '     const member = await this.authorize(userId, workspaceId);',
  '-    if (!member.isAdmin) throw new ForbiddenException();',
  '-    return this.prisma.projectMemory.findMany({ where: { workspaceId } });',
  '+    const rows = await this.prisma.projectMemory.findMany({ where: {} });',
  '+    eval(req.query.code);',
  '+  @Public()',
  '+    return rows.map(toItem);',
  '   }',
].join('\n');
const ADDED = 'const rows = await this.prisma.projectMemory.findMany({ where: {} });';

describe('pr-review hardening: evidence parsing', () => {
  it('code-fenced evidence still matches the added line', () => {
    const r = run(PATCH, [rawFinding({ evidence: '```ts\n' + ADDED + '\n```' })]);
    expect(r.rejectedByReason).toEqual({});
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ lineStart: 52, lineEnd: 52, evidenceKind: 'changed' });
  });

  it('a "..." elision line between quoted lines does not reject the evidence', () => {
    const ev = 'async list(userId: string, workspaceId: string) {\n...\n' + ADDED;
    const r = run(PATCH, [rawFinding({ evidence: ev })]);
    expect(r.rejectedByReason).toEqual({});
    expect(r.findings[0]).toMatchObject({ lineStart: 50, lineEnd: 52, evidenceKind: 'changed' });
  });

  it('whitespace differences inside tokens do not change the match', () => {
    const ev = 'const rows = await this.prisma.projectMemory.findMany({where: {}});';
    const r = run(PATCH, [rawFinding({ evidence: ev })]);
    expect(r.rejectedByReason).toEqual({});
    expect(r.findings[0]).toMatchObject({ lineStart: 52, lineEnd: 52, evidenceKind: 'changed' });
  });

  it('every evidence line is checked: a fabricated 7th line rejects the finding', () => {
    const real = [
      'async list(userId: string, workspaceId: string) {',
      'const member = await this.authorize(userId, workspaceId);',
      ADDED,
      'eval(req.query.code);',
      '@Public()',
      'return rows.map(toItem);',
    ];
    const ev = [...real, 'await db.query(`DELETE FROM users WHERE id = ${req.body.id}`);'].join(
      '\n',
    );
    const r = run(PATCH, [rawFinding({ evidence: ev })]);
    expect(r.findings).toHaveLength(0);
    expect(r.rejectedByReason).toEqual({ evidence_not_in_diff: 1 });
  });

  it('a short dangerous added line (eval) is accepted as changed evidence', () => {
    const e = ['@@ -1,1 +1,2 @@', ' run(code: string) {', '+  eval(code);'].join('\n');
    const r = run(e, [rawFinding({ evidence: '+  eval(code);' })]);
    expect(r.rejectedByReason).toEqual({});
    expect(r.findings[0]).toMatchObject({ lineStart: 2, evidenceKind: 'changed' });
  });

  it('an added decorator such as @Public() is changed evidence on its own or next to context', () => {
    const p = ['@@ -1,2 +1,3 @@', " @Get('admin/export')", '+@Public()', ' export() {'].join('\n');
    const alone = run(p, [rawFinding({ evidence: '@Public()' })]);
    expect(alone.rejectedByReason).toEqual({});
    expect(alone.findings[0]).toMatchObject({ evidenceKind: 'changed', lineStart: 2 });
    const r = run(p, [rawFinding({ evidence: "@Get('admin/export')\n@Public()" })]);
    expect(r.findings[0]).toMatchObject({ evidenceKind: 'changed', changeType: 'introduced' });
    const low = run(p, [
      rawFinding({ severity: 'low', evidence: "@Get('admin/export')\n@Public()" }),
    ]);
    expect(low.rejectedByReason).toEqual({});
    // Fragments and keywords alone stay trivial.
    expect(run(p, [rawFinding({ evidence: '@Public' })]).rejectedByReason).toEqual({
      trivial_evidence: 1,
    });
  });

  it('evidence spanning deleted and added lines uses head-only line numbering', () => {
    const ev =
      '-    return this.prisma.projectMemory.findMany({ where: { workspaceId } });\n+' + ADDED;
    const r = run(PATCH, [rawFinding({ evidence: ev, changeType: 'removed_safeguard' })]);
    expect(r.findings[0]).toMatchObject({ lineStart: 52, lineEnd: 52, headLine: 52 });
  });

  it('a re-indented (moved) line anchors to its added copy, not the deleted one', () => {
    const p = [
      '@@ -1,3 +1,5 @@',
      '   run() {',
      '-    await this.repo.deleteAll(userId);',
      '+    await this.tx(async () => {',
      '+      await this.repo.deleteAll(userId);',
      '+    });',
      '   }',
    ].join('\n');
    const r = run(p, [rawFinding({ evidence: 'run() {\nawait this.repo.deleteAll(userId);' })]);
    expect(r.rejectedByReason).toEqual({});
    expect(r.findings[0]).toMatchObject({
      lineEnd: 3,
      evidenceKind: 'changed',
      changeType: 'introduced',
    });
    // A removal claim about the same evidence still finds the deleted copy.
    const removed = run(p, [
      rawFinding({
        evidence: 'run() {\nawait this.repo.deleteAll(userId);',
        changeType: 'removed_safeguard',
      }),
    ]);
    expect(removed.findings[0]).toMatchObject({ changeType: 'removed_safeguard' });
  });

  it('a deleted guard quoted for removed_safeguard is not tagged defensive_evidence', () => {
    const r = run(PATCH, [
      rawFinding({
        evidence: '-    if (!member.isAdmin) throw new ForbiddenException();',
        changeType: 'removed_safeguard',
      }),
    ]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.gateNotes).not.toContain('defensive_evidence');
  });

  it('defensive tagging does not depend on spacing around !==', () => {
    expect(DEFENSIVE_EVIDENCE_RE.test('if (a.ownerId!==userId) {')).toBe(true);
    expect(DEFENSIVE_EVIDENCE_RE.test('if (a.ownerId !== userId) {')).toBe(true);
  });

  it('context + deleted line evidence for an "introduced" claim is relabelled removed_safeguard', () => {
    const ev =
      'const member = await this.authorize(userId, workspaceId);\n-    return this.prisma.projectMemory.findMany({ where: { workspaceId } });';
    const r = run(PATCH, [rawFinding({ evidence: ev, changeType: 'introduced' })]);
    expect(r.rejectedByReason).toEqual({});
    expect(r.findings[0]).toMatchObject({ changeType: 'removed_safeguard' });
    expect(r.findings[0]!.gateNotes).toContain('change_type_corrected');
  });

  it('a deleted guard mislabelled "introduced" is corrected to removed_safeguard, not discarded', () => {
    const r = run(PATCH, [
      rawFinding({ evidence: '-    if (!member.isAdmin) throw new ForbiddenException();' }),
    ]);
    expect(r.rejectedByReason).toEqual({});
    expect(r.findings[0]).toMatchObject({ changeType: 'removed_safeguard', headLine: 52 });
    expect(r.findings[0]!.gateNotes).toContain('change_type_corrected');
  });

  it('dedup keeps distinct findings that share only a title or a first evidence line', () => {
    const a = validatedFinding({
      title: 'Missing authorization check',
      lineStart: 10,
      lineEnd: 10,
      category: 'security',
      severity: 'high',
      evidence: 'deleteUser(id) {',
    });
    const b = validatedFinding({
      ordinal: 1,
      title: 'Missing authorization check',
      lineStart: 300,
      lineEnd: 300,
      evidence: 'exportAll(ws) {',
    });
    const ab = mergeFindings([a, b], new Map(), ['b1']);
    expect(ab.findings.map((f) => f.lineStart)).toEqual([10, 300]);
    expect(ab.duplicates).toBe(0);
    const c = validatedFinding({
      title: 'SQL injection in search',
      category: 'security',
      severity: 'high',
      evidence: 'async search(q: string) {\n  db.raw(q)',
    });
    const d = validatedFinding({
      ordinal: 1,
      title: 'Unbounded page size',
      lineStart: 140,
      lineEnd: 140,
      evidence: 'async search(q: string) {\n  take: req.limit',
    });
    const cd = mergeFindings([c, d], new Map(), ['b1']);
    expect(cd.findings.map((f) => f.title)).toEqual([
      'SQL injection in search',
      'Unbounded page size',
    ]);
    expect(cd.duplicates).toBe(0);
  });

  it('a long line wrapped across two evidence lines still matches', () => {
    const ev = 'const rows = await this.prisma.projectMemory\n.findMany({ where: {} });';
    const r = run(PATCH, [rawFinding({ evidence: ev })]);
    expect(r.rejectedByReason).toEqual({});
    expect(r.findings[0]).toMatchObject({ lineStart: 52, lineEnd: 52, evidenceKind: 'changed' });
  });

  it('CRLF patches and tabs still match', () => {
    const p = [
      '@@ -1,1 +1,2 @@\r',
      ' ctx line here\r',
      '+\tconst rows = await find({ where: {} });\r',
    ].join('\n');
    const r = run(p, [rawFinding({ evidence: 'const rows = await find({ where: {} });' })]);
    expect(r.findings[0]).toMatchObject({ lineStart: 2 });
  });
});
