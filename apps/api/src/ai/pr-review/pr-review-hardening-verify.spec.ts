/**
 * Regression tests for verdict assessment: refutations must rest on a guard that actually
 * protects the vulnerable path, confirmations must address guards and cite the change, and
 * pre-verification dedup must not drop findings. Tests named `KNOWN LIMITATION:` pin
 * behaviour that is still not the desired one.
 */
import { describe, expect, it } from 'vitest';

import type { CodeSection } from './pr-review-context';
import { DependencyCache, resolveDependencies } from './pr-review-deps';
import { DEFENSIVE_EVIDENCE_RE, mergeFindings } from './pr-review-findings';
import {
  assessVerdict,
  buildVerificationContent,
  SECURITY_CATEGORIES,
  type AssessedVerdict,
  type VerificationOutput,
} from './pr-review-verify';
import { validatedFinding } from './pr-review-fixtures';

const P = 'src/docs.service.ts';

function windowOf(path: string, text: string, tag: 'HEAD' | 'ADD' = 'HEAD'): CodeSection {
  const lines = text.split('\n');
  return {
    path,
    label: 'code at PR head around the finding',
    lines: lines.map((t, i) => ({ tag, n: i + 1, old: null, text: t })),
    focus: 0,
  };
}

async function assess(input: {
  text: string;
  focusMarker: string;
  category?: 'security' | 'data_integrity' | 'correctness';
  changeType?: 'introduced' | 'exposed_existing';
  tag?: 'HEAD' | 'ADD';
  title?: string;
  explanation?: string;
  output: Partial<VerificationOutput>;
}): Promise<AssessedVerdict> {
  const text = input.text;
  const lines = text.split('\n');
  const focus = lines.findIndex((l) => l.includes(input.focusMarker)) + 1;
  expect(focus).toBeGreaterThan(0);
  const window = windowOf(P, text, input.tag);
  const category = input.category ?? 'security';
  const evidence = lines[focus - 1]!.trim();
  const deps = await resolveDependencies({
    originPath: P,
    originText: text,
    windowLines: window.lines,
    focusLine: focus,
    cache: new DependencyCache(async (p: string) => (p === P ? text : null)),
    maxChars: 9_000,
    securityFinding: SECURITY_CATEGORIES.has(category),
  });
  const finding = validatedFinding({
    path: P,
    category,
    severity: 'high',
    lineStart: focus,
    lineEnd: focus,
    headLine: focus,
    evidence,
    changeType: input.changeType ?? 'introduced',
    ...(input.title ? { title: input.title } : {}),
    ...(input.explanation ? { explanation: input.explanation } : {}),
    gateNotes: DEFENSIVE_EVIDENCE_RE.test(evidence) ? ['defensive_evidence'] : [],
  });
  const { provided } = buildVerificationContent({
    finding,
    sections: [window],
    dependencies: deps,
    fileTexts: new Map([[P, text]]),
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
      ...input.output,
    },
    finding,
    provided,
  );
}

describe('pr-review hardening: security refutations need an on-path guard for the resource', () => {
  it('a guard on a different resource (workspace membership) does not refute an IDOR on a doc', async () => {
    const text = [
      'export class DocsService {',
      '  constructor(private readonly prisma: any) {}',
      '  async remove(userId: string, workspaceId: string, docId: string) {',
      '    const membership = await this.prisma.member.findFirst({ where: { workspaceId, userId } });',
      "    if (!membership) throw new ForbiddenException('not a member');",
      '    await this.prisma.doc.delete({ where: { id: docId } }); // FOCUS',
      '  }',
      '}',
    ].join('\n');
    const r = await assess({
      text,
      focusMarker: 'FOCUS',
      output: { decisiveCode: "if (!membership) throw new ForbiddenException('not a member');" },
    });
    expect(r.verdict).toBe('insufficient_context');
    expect(r.audit.rule).toBe('refute_security_gap');
  });

  it('a guard in another method above the vulnerable method is not on the path', async () => {
    const text = [
      'export class DocsService {',
      '  constructor(private readonly prisma: any) {}',
      '  async read(userId: string, workspaceId: string) {',
      '    const membership = await this.prisma.member.findFirst({ where: { workspaceId, userId } });',
      "    if (!membership) throw new ForbiddenException('not a member');",
      '    return membership;',
      '  }',
      '  async remove(userId: string, docId: string) {',
      '    await this.prisma.doc.delete({ where: { id: docId } }); // FOCUS',
      '  }',
      '}',
    ].join('\n');
    const r = await assess({
      text,
      focusMarker: 'FOCUS',
      output: { decisiveCode: "if (!membership) throw new ForbiddenException('not a member');" },
    });
    expect(r.verdict).toBe('insufficient_context');
    expect(r.audit.rule).toBe('refute_security_gap');
  });

  it('an owner-scoped query whose result is ignored is not a denial', async () => {
    const text = [
      'export class DocsService {',
      '  constructor(private readonly prisma: any) {}',
      '  async remove(userId: string, docId: string) {',
      '    await this.prisma.doc.findFirst({ where: { id: docId, ownerId: userId } });',
      '    await this.prisma.doc.delete({ where: { id: docId } }); // FOCUS',
      '  }',
      '}',
    ].join('\n');
    const r = await assess({
      text,
      focusMarker: 'FOCUS',
      output: {
        decisiveCode: 'await this.prisma.doc.findFirst({ where: { id: docId, ownerId: userId } });',
      },
    });
    expect(r.verdict).toBe('insufficient_context');
    expect(r.audit.rule).toBe('refute_security_gap');
  });

  it('a denial swallowed by a one-line try/catch is not a guard', async () => {
    const text = [
      'export class DocsService {',
      '  constructor(private readonly prisma: any) {}',
      '  async remove(userId: string, workspaceId: string, docId: string) {',
      '    const membership = await this.prisma.member.findFirst({ where: { workspaceId, userId } });',
      '    try { if (!membership) throw new ForbiddenException(); } catch { /* ignore */ }',
      '    await this.prisma.doc.delete({ where: { id: docId, workspaceId } }); // FOCUS',
      '  }',
      '}',
    ].join('\n');
    const r = await assess({
      text,
      focusMarker: 'FOCUS',
      output: {
        decisiveCode:
          'try { if (!membership) throw new ForbiddenException(); } catch { /* ignore */ }',
      },
    });
    expect(r.verdict).toBe('insufficient_context');
    expect(r.audit.rule).toBe('refute_security_gap');
  });

  it('a check-then-act race (data_integrity) is not refuted by quoting the check itself', async () => {
    const text = [
      'export class CouponService {',
      '  constructor(private readonly prisma: any) {}',
      '  async redeem(userId: string, code: string) {',
      '    const existing = await this.prisma.redemption.findFirst({ where: { code, userId } });',
      "    if (existing !== null) throw new ConflictException('already redeemed');",
      '    await this.prisma.redemption.create({ data: { code, userId } }); // FOCUS',
      '  }',
      '}',
    ].join('\n');
    const r = await assess({
      text,
      focusMarker: 'FOCUS',
      category: 'data_integrity',
      title: 'Concurrent redemptions can both pass the check',
      explanation:
        'Two concurrent requests both read no existing redemption before either insert commits, so the coupon is redeemed twice.',
      output: {
        decisiveCode: "if (existing !== null) throw new ConflictException('already redeemed');",
      },
    });
    expect(r.verdict).toBe('insufficient_context');
    expect(r.audit.rule).toBe('refute_concurrency_gap');
  });

  it('a correctness-category race is not refuted by quoting the check itself', async () => {
    const text = [
      'export class WalletService {',
      '  constructor(private readonly prisma: any) {}',
      '  async withdraw(userId: string, amount: number) {',
      '    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });',
      "    if (wallet.balance < amount) throw new BadRequestException('insufficient');",
      '    await this.prisma.wallet.update({ where: { userId }, data: { balance: wallet.balance - amount } }); // FOCUS',
      '  }',
      '}',
    ].join('\n');
    const r = await assess({
      text,
      focusMarker: 'FOCUS',
      category: 'correctness',
      title: 'Concurrent withdrawals can both pass the balance check',
      explanation:
        'Two concurrent requests both read the same balance before either update commits, so the wallet is overdrawn.',
      output: {
        decisiveCode: "if (wallet.balance < amount) throw new BadRequestException('insufficient');",
      },
    });
    expect(r.verdict).toBe('insufficient_context');
    expect(r.audit.rule).toBe('refute_concurrency_gap');
  });
});

describe('pr-review hardening: confirmations must address guards and cite the change', () => {
  const guarded = [
    'export class DocsService {',
    '  constructor(private readonly prisma: any) {}',
    '  async remove(userId: string, docId: string) {',
    '    const doc = await this.prisma.doc.findUnique({ where: { id: docId } });',
    "    if (!doc || doc.ownerId !== userId) throw new ForbiddenException('not owner');",
    '    await this.prisma.doc.delete({ where: { id: docId } }); // FOCUS',
    '  }',
    '}',
  ].join('\n');

  it('a failure site placed before the guard does not skip guard coverage', async () => {
    const r = await assess({
      text: guarded,
      focusMarker: 'FOCUS',
      output: {
        verdict: 'confirmed',
        severity: 'high',
        decisiveCode: 'const doc = await this.prisma.doc.findUnique({ where: { id: docId } });',
        failureSite: `${P}:4`,
        reachableTrigger: 'Any authenticated user passes another user docId',
        violatedInvariant: 'Only the owner may delete a document',
        triggerSource: 'async remove(userId: string, docId: string) {',
        guardsOnPath: [],
      },
    });
    // The guard at line 5 sits between the claimed site and the finding line 6.
    expect(r.verdict).toBe('insufficient_context');
    // A site before the finding's own line is not where the failure happens (checked first);
    // the guard coverage check would also reject it.
    expect(r.audit.rule).toBe('site_before_finding');
  });

  it('a signature that marks the entry of an unguarded path counts as independent code (guard scan verifies the path)', async () => {
    const text = [
      'export class DocsService {',
      '  constructor(private readonly prisma: any) {}',
      '  async remove(userId: string, docId: string) {',
      '    await this.prisma.doc.delete({ where: { id: docId } }); // FOCUS',
      '  }',
      '}',
    ].join('\n');
    const r = await assess({
      text,
      focusMarker: 'FOCUS',
      category: 'correctness',
      output: {
        verdict: 'confirmed',
        severity: 'medium',
        decisiveCode:
          'async remove(userId: string, docId: string) {\nawait this.prisma.doc.delete({ where: { id: docId } }); // FOCUS',
        failureSite: `${P}:4`,
        reachableTrigger: 'if the caller passes an id that was already deleted',
        violatedInvariant: 'delete must be idempotent',
        triggerSource: 'async remove(userId: string, docId: string) {',
        guardsOnPath: [],
      },
    });
    expect(r.verdict).toBe('confirmed');
    expect(r.audit).toMatchObject({ rule: 'confirmed', guardCoverage: 'none_found' });
  });

  it('exposed_existing: an added "}" line does not count as citing the change', async () => {
    const text = [
      'export class DocsService {',
      '  constructor(private readonly prisma: any) {}',
      '  async remove(userId: string, docId: string) {',
      '    const n = await this.prisma.doc.count({ where: { id: docId } });',
      '    await this.prisma.doc.delete({ where: { id: docId } }); // FOCUS',
      '  }',
      '}',
    ].join('\n');
    const lines = text.split('\n');
    const lines2 = lines.map((t, i) => ({
      tag: (i === 5 ? 'ADD' : 'HEAD') as 'ADD' | 'HEAD',
      n: i + 1,
      old: null,
      text: t,
    }));
    const finding = validatedFinding({
      path: P,
      category: 'correctness',
      severity: 'medium',
      lineStart: 5,
      lineEnd: 5,
      headLine: 5,
      evidence: lines[4]!.trim(),
      changeType: 'exposed_existing',
      gateNotes: [],
    });
    const { provided } = buildVerificationContent({
      finding,
      sections: [{ path: P, label: 'w', lines: lines2, focus: 0 }],
      fileTexts: new Map([[P, text]]),
    });
    const r = assessVerdict(
      {
        verdict: 'confirmed',
        severity: 'medium',
        reasoning: 'r',
        decisiveCode: 'const n = await this.prisma.doc.count({ where: { id: docId } });',
        failureSite: `${P}:5`,
        dependsOnCodeNotShown: false,
        reachableTrigger: 'a docId that does not exist is passed',
        violatedInvariant: 'delete throws on missing row',
        triggerSource: 'async remove(userId: string, docId: string) {',
        guardsOnPath: [],
      },
      finding,
      provided,
    );
    // The only ADD line is "  }" — the quote does not cite the change.
    expect(r.verdict).toBe('insufficient_context');
    expect(r.audit.rule).toBe('exposed_change_not_cited');
  });
});

async function assessMulti(input: {
  files: Record<string, string>;
  focusMarker: string;
  category?: 'security' | 'correctness';
  output: Partial<VerificationOutput>;
}) {
  const text = input.files[P]!;
  const lines = text.split('\n');
  const focus = lines.findIndex((l) => l.includes(input.focusMarker)) + 1;
  const window = windowOf(P, text);
  const category = input.category ?? 'security';
  const deps = await resolveDependencies({
    originPath: P,
    originText: text,
    windowLines: window.lines,
    focusLine: focus,
    cache: new DependencyCache(async (p: string) => input.files[p] ?? null),
    maxChars: 9_000,
    securityFinding: SECURITY_CATEGORIES.has(category),
  });
  const finding = validatedFinding({
    path: P,
    category,
    severity: 'high',
    lineStart: focus,
    lineEnd: focus,
    headLine: focus,
    evidence: lines[focus - 1]!.trim(),
    changeType: 'introduced',
    gateNotes: [],
  });
  const { provided } = buildVerificationContent({
    finding,
    sections: [window],
    dependencies: deps,
    fileTexts: new Map([[P, text]]),
  });
  const r = assessVerdict(
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
      ...input.output,
    },
    finding,
    provided,
  );
  return { r, deps };
}

describe('pr-review hardening: dependency guards must be effective at the call site', () => {
  const guard = [
    'export async function assertMember(prisma: any, userId: string, workspaceId: string) {',
    '  const m = await prisma.member.findFirst({ where: { workspaceId, userId } });',
    "  if (!m) throw new ForbiddenException('not a member');",
    '}',
  ].join('\n');

  it('a helper denial swallowed by .catch() at the call site does not refute', async () => {
    const svc = [
      "import { assertMember } from './guard';",
      'export class DocsService {',
      '  constructor(private readonly prisma: any) {}',
      '  async remove(userId: string, workspaceId: string, docId: string) {',
      '    await assertMember(this.prisma, userId, workspaceId).catch(() => undefined);',
      '    await this.prisma.doc.delete({ where: { id: docId, workspaceId } }); // FOCUS',
      '  }',
      '}',
    ].join('\n');
    const { r, deps } = await assessMulti({
      files: { [P]: svc, 'src/guard.ts': guard },
      focusMarker: 'FOCUS',
      output: { decisiveCode: "if (!m) throw new ForbiddenException('not a member');" },
    });
    expect(deps.resolved.map((d) => d.name)).toContain('assertMember');
    expect(r.verdict).toBe('insufficient_context');
    expect(r.audit.rule).toBe('refute_security_gap');
  });

  it('a helper denial swallowed by try/catch at the call site does not refute', async () => {
    const svc = [
      "import { assertMember } from './guard';",
      'export class DocsService {',
      '  constructor(private readonly prisma: any) {}',
      '  async remove(userId: string, workspaceId: string, docId: string) {',
      '    try { await assertMember(this.prisma, userId, workspaceId); } catch (e) { this.log(e); }',
      '    await this.prisma.doc.delete({ where: { id: docId, workspaceId } }); // FOCUS',
      '  }',
      '}',
    ].join('\n');
    const { r } = await assessMulti({
      files: { [P]: svc, 'src/guard.ts': guard },
      focusMarker: 'FOCUS',
      output: { decisiveCode: "if (!m) throw new ForbiddenException('not a member');" },
    });
    expect(r.verdict).toBe('insufficient_context');
    expect(r.audit.rule).toBe('refute_security_gap');
  });

  it('a confirmation whose trigger comes from an unreadable imported helper is not accepted', async () => {
    const svc = [
      "import { loadUser } from './users';",
      'export class DocsService {',
      '  async greet(id: string) {',
      '    const user = await loadUser(id);',
      '    return user.name.toUpperCase(); // FOCUS',
      '  }',
      '}',
    ].join('\n');
    const { r, deps } = await assessMulti({
      files: { [P]: svc },
      focusMarker: 'FOCUS',
      category: 'correctness',
      output: {
        verdict: 'confirmed',
        severity: 'medium',
        decisiveCode: 'const user = await loadUser(id);',
        failureSite: `${P}:5`,
        reachableTrigger: 'loadUser returns null for an unknown id',
        violatedInvariant: 'user must be non-null before dereference',
        triggerSource: 'const user = await loadUser(id);',
        guardsOnPath: [],
      },
    });
    expect(deps.resolved.length).toBe(0);
    expect(r.verdict).toBe('insufficient_context');
    expect(r.audit.rule).toBe('trigger_unresolved');
  });
});

describe('pr-review hardening: pre-verification dedup', () => {
  it('two distinct defects on the same evidence line are both kept for verification', () => {
    const ev = 'const rows = await this.db.query(`SELECT * FROM docs WHERE id = ${req.query.id}`);';
    const a = validatedFinding({
      path: P,
      category: 'security',
      severity: 'high',
      title: 'Missing workspace authorization on document read',
      evidence: ev,
      lineStart: 10,
      lineEnd: 10,
      batchId: 'b1',
      ordinal: 0,
    });
    const b = validatedFinding({
      path: P,
      category: 'security',
      severity: 'high',
      title: 'SQL injection via interpolated query parameter',
      evidence: ev,
      lineStart: 10,
      lineEnd: 10,
      batchId: 'b1',
      ordinal: 1,
    });
    // Authorization and SQL injection are distinct defects on one line.
    const out = mergeFindings([a, b], new Map(), ['b1']);
    expect(out.findings.map((f) => f.title).sort()).toEqual([b.title, a.title].sort());
    expect(out.duplicates).toBe(0);
    // The same defect reported twice (similar title) is still one finding.
    const again = mergeFindings(
      [a, { ...a, title: 'Missing workspace authorization on the document read', ordinal: 1 }],
      new Map(),
      ['b1'],
    );
    expect(again.findings).toHaveLength(1);
    expect(again.duplicates).toBe(1);
  });
});
