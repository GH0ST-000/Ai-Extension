import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsePatch, type DiffLine } from './diff-hunks';
import { findCallers } from './pr-review-callers';
import type { CodeSection } from './pr-review-context';
import { DependencyCache, resolveDependencies } from './pr-review-deps';
import { DEFENSIVE_EVIDENCE_RE } from './pr-review-findings';
import { validatedFinding } from './pr-review-fixtures';
import {
  assessVerdict,
  buildVerificationContent,
  SECURITY_CATEGORIES,
  type AssessedVerdict,
  type VerificationOutput,
} from './pr-review-verify';

// Exact PR #48 sources at head 69e1fc4 (see test/fixtures/pr48-69e1fc4/README.md).
const FIXTURES = join(__dirname, '../../../test/fixtures/pr48-69e1fc4');
const head = (path: string) =>
  readFileSync(join(FIXTURES, `${path.replace(/\//g, '_')}.head`), 'utf8');
const diffLines = (path: string): DiffLine[] => {
  const raw = readFileSync(join(FIXTURES, `${path.replace(/\//g, '_')}.patch`), 'utf8');
  return parsePatch(raw.slice(raw.indexOf('\n@@') + 1)).flatMap((h) => h.lines);
};

const RESOLVE = 'apps/api/src/workspaces/resolve-workspace-id.ts';
const CONTEXT = 'apps/api/src/observability/request-context.service.ts';
const ERRORS = 'apps/api/src/workspaces/workspace.errors.ts';
const DIFF = 'apps/api/src/ai/pr-review/pull-request-diff.service.ts';
const BUDGET = 'apps/api/src/ai/pr-review/pr-diff-budget.ts';
const ACCESS = 'apps/api/src/github-app/github-access.service.ts';
const STORE = 'apps/extension/lib/project-memory/project-memory.store.ts';

const LIVE: Record<string, string> = Object.fromEntries(
  [
    RESOLVE,
    CONTEXT,
    ERRORS,
    DIFF,
    BUDGET,
    ACCESS,
    STORE,
    'apps/api/tsconfig.json',
    'apps/api/package.json',
    'apps/extension/tsconfig.json',
    'apps/extension/package.json',
    'packages/shared/src/index.ts',
    'packages/shared/src/project-memory/index.ts',
    'packages/shared/src/project-memory/categories.ts',
  ].map((p) => [p, head(p)]),
);

function windowOf(path: string, text: string, from: number, to: number): CodeSection {
  const lines = text.split('\n');
  return {
    path,
    label: 'code at PR head around the finding',
    lines: Array.from({ length: to - from + 1 }, (_, i) => ({
      tag: 'HEAD' as const,
      n: from + i,
      old: null,
      text: lines[from + i - 1]!,
    })),
    focus: 0,
  };
}

async function assess(input: {
  files?: Record<string, string>;
  path: string;
  from: number;
  to: number;
  focus: number;
  evidence?: string;
  category?: 'security' | 'correctness';
  callers?: CodeSection[];
  output: Partial<VerificationOutput>;
}): Promise<AssessedVerdict> {
  const files = input.files ?? LIVE;
  const text = files[input.path]!;
  const window = windowOf(input.path, text, input.from, input.to);
  const category = input.category ?? 'security';
  const evidence = input.evidence ?? text.split('\n')[input.focus - 1]!.trim();
  const deps = await resolveDependencies({
    originPath: input.path,
    originText: text,
    windowLines: window.lines,
    focusLine: input.focus,
    cache: new DependencyCache(async (p: string) => files[p] ?? null),
    maxChars: 9_000,
    securityFinding: SECURITY_CATEGORIES.has(category),
  });
  const finding = validatedFinding({
    path: input.path,
    category,
    severity: 'medium',
    lineStart: input.focus,
    lineEnd: input.focus,
    headLine: input.focus,
    evidence,
    gateNotes: DEFENSIVE_EVIDENCE_RE.test(evidence) ? ['defensive_evidence'] : [],
  });
  const { provided } = buildVerificationContent({
    finding,
    sections: [window],
    dependencies: deps,
    fileTexts: new Map([[input.path, text]]),
    callers: input.callers ?? [],
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

const C1 = { path: RESOLVE, from: 17, to: 54, focus: 35 };
const GUARD = 'if (!membership) {';
const DENIAL = "if (!membership) {\nthrow workspaceException(\n'WORKSPACE_CONTEXT_UNAVAILABLE',";
const variant = (from: string, to: string) => ({
  ...LIVE,
  [RESOLVE]: LIVE[RESOLVE]!.replace(from, to),
});

describe('guard-as-evidence refutation (live #6 C1, exact 69e1fc4 source)', () => {
  it('a correct guard followed by its denial refutes the claim about that guard', async () => {
    const a = await assess({ ...C1, output: { decisiveCode: DENIAL } });
    expect(a).toMatchObject({ verdict: 'refuted', audit: { guardRelation: 'focus_guard_branch' } });
    expect(a.audit.quoteLines).toEqual(expect.arrayContaining([`${RESOLVE}:35`, `${RESOLVE}:36`]));
  });

  it('quoting only the guard line is enough: its branch denial is verified on the AST', async () => {
    const a = await assess({ ...C1, output: { decisiveCode: GUARD } });
    expect(a).toMatchObject({ verdict: 'refuted', audit: { guardRelation: 'focus_guard_branch' } });
  });

  it('an inverted (wrong-condition) guard does not refute', async () => {
    const files = variant('    if (!membership) {', '    if (membership) {');
    const a = await assess({
      ...C1,
      files,
      output: { decisiveCode: 'if (membership) {\nthrow workspaceException(' },
    });
    expect(a).toMatchObject({
      verdict: 'insufficient_context',
      audit: { rule: 'refute_security_gap', guardRelation: 'not_established' },
    });
    expect(a.reason).toContain('not negated');
  });

  it('a guard on a value no tenant lookup or decision establishes does not refute', async () => {
    const files = variant('    if (!membership) {', '    if (!userId) {');
    const a = await assess({
      ...C1,
      files,
      output: { decisiveCode: 'if (!userId) {\nthrow workspaceException(' },
    });
    expect(a).toMatchObject({ verdict: 'insufficient_context' });
    expect(a.reason).toContain('not established by a lookup bound to the requesting user');
  });

  it('an unrelated earlier throw (malformed-header check) does not refute a membership claim', async () => {
    const a = await assess({
      ...C1,
      output: {
        decisiveCode:
          "if (!candidate && peekRequestWorkspaceHeaderInvalid()) {\nthrow workspaceException('WORKSPACE_ID_INVALID', 'X-Workspace-Id header is malformed.');",
      },
    });
    expect(a).toMatchObject({
      verdict: 'insufficient_context',
      audit: { guardRelation: 'not_established' },
    });
  });

  it('a later guard does not refute a finding before it', async () => {
    const a = await assess({ ...C1, focus: 34, output: { decisiveCode: DENIAL } });
    expect(a.verdict).toBe('insufficient_context');
    expect(a.reason).toContain('does not run before the vulnerable line');
  });

  it('a denial nested on an unrelated path inside the guard branch does not count', async () => {
    const files = variant(
      '    if (!membership) {\n      throw workspaceException(',
      '    if (!membership) {\n      if (process.env.DEBUG_MEMBERSHIP) throw workspaceException(',
    );
    const a = await assess({ ...C1, files, output: { decisiveCode: GUARD } });
    expect(a).toMatchObject({ verdict: 'insufficient_context' });
    expect(a.reason).toContain('does not quote the branch that denies access');
  });

  const WHERE = "where: {\nworkspaceId,\nuserId,\nstatus: 'active',";
  it('a multi-line tenant-scoped Prisma where clause is a denial (helper on the path)', async () => {
    const a = await assess({ ...C1, output: { decisiveCode: WHERE } });
    expect(a).toMatchObject({ verdict: 'refuted', audit: { guardRelation: 'dependency' } });
  });

  it('a where clause missing the tenant filter is not a denial', async () => {
    const files = variant(
      "      workspaceId,\n      userId,\n      status: 'active',",
      "      status: 'active',",
    );
    const a = await assess({
      ...C1,
      files,
      output: { decisiveCode: "where: {\nstatus: 'active',\nworkspace: { status: 'active' }," },
    });
    expect(a.verdict).toBe('insufficient_context');
  });
});

describe('execution-path dependency priority (live #6 C2, exact source)', () => {
  const text = LIVE[DIFF]!;
  const window = windowOf(DIFF, text, 71, 123).lines;
  const resolve = (maxChars: number) =>
    resolveDependencies({
      originPath: DIFF,
      originText: text,
      windowLines: window,
      focusLine: 104,
      cache: new DependencyCache(async (p: string) => LIVE[p] ?? null),
      maxChars,
    });

  it('the helper on the failure path comes first; the token chain of another function is deprioritized', async () => {
    const deps = await resolve(9_000);
    expect(deps.resolved[0]).toMatchObject({ name: 'scopeFromPageFiles', pathRank: 1 });
    const token = deps.resolved.findIndex((d) => d.name.endsWith('resolveApiToken'));
    expect(token === -1 || token > 0).toBe(true);
  });

  it('under token pressure the relevant helper is retained and the unrelated chain is not', async () => {
    const deps = await resolve(1_400);
    expect(deps.resolved.map((d) => d.name)).toContain('scopeFromPageFiles');
    expect(deps.resolved.some((d) => d.name.endsWith('resolveApiToken'))).toBe(false);
  });

  it('the exception factory behind a visible throw is not followed (C1)', async () => {
    const deps = await resolveDependencies({
      originPath: RESOLVE,
      originText: LIVE[RESOLVE]!,
      windowLines: windowOf(RESOLVE, LIVE[RESOLVE]!, 17, 54).lines,
      focusLine: 35,
      cache: new DependencyCache(async (p: string) => LIVE[p] ?? null),
      maxChars: 9_000,
      securityFinding: true,
    });
    expect(deps.resolved.map((d) => d.name)).not.toContain('workspaceException');
    expect(deps.resolved.map((d) => d.name)).toContain('findActiveMembership');
  });
});

describe('dependency file budget (separate caps)', () => {
  const resolveStore = (cache: DependencyCache) =>
    resolveDependencies({
      originPath: STORE,
      originText: LIVE[STORE]!,
      windowLines: windowOf(STORE, LIVE[STORE]!, 60, 110).lines,
      focusLine: 108,
      cache,
      maxChars: 9_000,
    });

  it('config reads and missing-file probes are not charged to the source-file budget', async () => {
    const cache = new DependencyCache(async (p: string) => LIVE[p] ?? null);
    await resolveStore(cache);
    expect(cache.configReads).toBeGreaterThan(0);
    expect(cache.probes).toBeGreaterThan(0); // shared/src/project-memory.ts(x) do not exist
    expect(cache.sourceFiles).toBe(cache.requests - cache.configReads - cache.probes);
  });

  it('missing-file probes stop at their strict cap (no unbounded guessing)', async () => {
    const requested: string[] = [];
    const cache = new DependencyCache(
      async (p: string) => {
        requested.push(p);
        return LIVE[p] ?? null;
      },
      16,
      { config: 6, probes: 1, requests: 30 },
    );
    const deps = await resolveStore(cache);
    expect(cache.probes).toBeLessThanOrEqual(1);
    expect(requested).not.toContain('packages/shared/src/project-memory.tsx');
    // The helper behind the refused guesses stays unresolved (never fetched by brute force).
    expect(deps.resolved.map((d) => d.name)).not.toContain('memoryCapabilityForAiAction');
  });

  it('the total request cap is enforced across all kinds of reads', async () => {
    const cache = new DependencyCache(async (p: string) => LIVE[p] ?? null, 16, {
      config: 6,
      probes: 8,
      requests: 2,
    });
    await resolveStore(cache);
    expect(cache.requests).toBeLessThanOrEqual(2);
  });
});

describe('caller context for return-value claims', () => {
  const LIB = 'src/repo.ts';
  const libText = [
    'export function pickRepo(url: string): string | null {', // 1
    '  const m = /github.com\\/([^/]+\\/[^/]+)/.exec(url);', // 2
    '  return m ? m[1]! : null;', // 3
    '}', // 4
  ].join('\n');
  const callerOk = [
    "import { pickRepo } from './repo';", // 1
    'export function memoryFor(url: string) {', // 2
    '  const repo = pickRepo(url);', // 3
    '  if (!repo) return { status: "skipped", reason: "no_repository" };', // 4
    '  return load(repo);', // 5
    '}', // 6
  ];
  const callerBad = [
    "import { pickRepo } from './repo';", // 1
    'export function ownerOf(url: string) {', // 2
    '  const repo = pickRepo(url);', // 3
    "  return repo.split('/')[0].trim();", // 4
    '}', // 5
  ];
  const added = (lines: string[]): DiffLine[] =>
    lines.map((text, i) => ({ kind: '+', text, oldLine: null, newLine: i + 1 }));

  const callersFor = async (callerPath: string, callerLines: string[]) =>
    findCallers({
      name: 'pickRepo',
      definitionPath: LIB,
      definitionRange: [1, 4],
      diffLinesByPath: new Map([
        [LIB, added(libText.split('\n'))],
        [callerPath, added(callerLines)],
        ['src/repo.spec.ts', added(['pickRepo("x");'])],
      ]),
      provider: async (p: string) =>
        p === callerPath ? callerLines.join('\n') : p === LIB ? libText : null,
      maxChars: 1_800,
    });

  it('finds direct callers in changed files (not imports, definitions or tests)', async () => {
    const found = await callersFor('src/memory.ts', callerOk);
    expect(found).toMatchObject({ status: 'found', found: 1 });
    expect(found.sections[0]!.label).toContain('caller of pickRepo()');
    expect(found.sections[0]!.label).toContain('does not prove this path runs');
  });

  it('no caller in the changed files is reported as such (uncertainty preserved)', async () => {
    const found = await findCallers({
      name: 'pickRepo',
      definitionPath: LIB,
      definitionRange: [1, 4],
      diffLinesByPath: new Map([[LIB, added(libText.split('\n'))]]),
      maxChars: 1_800,
    });
    expect(found).toMatchObject({ status: 'none_in_changed_files', sections: [] });
  });

  it('a caller that handles null correctly lets a grounded refutation stand', async () => {
    const { sections } = await callersFor('src/memory.ts', callerOk);
    const a = await assess({
      files: { [LIB]: libText },
      path: LIB,
      from: 1,
      to: 4,
      focus: 3,
      category: 'correctness',
      callers: sections,
      output: {
        decisiveCode:
          'const repo = pickRepo(url);\nif (!repo) return { status: "skipped", reason: "no_repository" };',
      },
    });
    expect(a.verdict).toBe('refuted');
  });

  it('a caller that mishandles null keeps a real bug confirmable (failure in the caller)', async () => {
    const { sections } = await callersFor('src/owner.ts', callerBad);
    const a = await assess({
      files: { [LIB]: libText },
      path: LIB,
      from: 1,
      to: 4,
      focus: 3,
      category: 'correctness',
      callers: sections,
      output: {
        verdict: 'confirmed',
        severity: 'medium',
        decisiveCode: "return m ? m[1]! : null;\nreturn repo.split('/')[0].trim();",
        failureSite: 'src/owner.ts:4',
        reachableTrigger: 'An issue URL outside github.com is passed to ownerOf',
        violatedInvariant: 'ownerOf never dereferences a missing repository',
        triggerSource: 'export function ownerOf(url: string) {',
        guardsOnPath: [
          {
            code: 'return m ? m[1]! : null;',
            whyNotPreventing: 'It returns null for a non-GitHub URL and ownerOf calls split on it.',
          },
        ],
      },
    });
    expect(a).toMatchObject({ verdict: 'confirmed', audit: { rule: 'confirmed' } });
  });

  it('live #6 C4: the two callers of memoryRepositoryForRequest in the PR are found', async () => {
    const callerPaths = [
      'apps/extension/lib/selection/store.ts',
      'apps/extension/lib/selection/workflow/workflow.store.ts',
    ];
    const found = await findCallers({
      name: 'memoryRepositoryForRequest',
      definitionPath: STORE,
      definitionRange: [98, 109],
      diffLinesByPath: new Map([STORE, ...callerPaths].map((p) => [p, diffLines(p)] as const)),
      provider: async (p: string) => (callerPaths.includes(p) ? head(p) : null),
      maxChars: 1_800,
    });
    expect(found).toMatchObject({ status: 'found', found: 2 });
    // Shown within the caller budget (1,800 chars): the first caller fits; never unbounded.
    expect(found.sections[0]!.path).toBe(callerPaths[0]);
    expect(
      found.sections[0]!.lines.some((l) => l.text.includes('memoryRepositoryForRequest({')),
    ).toBe(true);
    expect(
      found.sections.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.text.length, 0), 0),
    ).toBeLessThanOrEqual(1_800);
  });
});

describe('defensive-code evidence', () => {
  const SVC = 'src/notes.service.ts';
  const svc = [
    'export class NotesService {', // 1
    '  async remove(userId: string, noteId: string) {', // 2
    '    const note = await this.prisma.note.findUnique({ where: { id: noteId } });', // 3
    '    if (!note.authorId) {', // 4  checks the wrong field: any note with an author passes
    "      throw new ForbiddenException('No author.');", // 5
    '    }', // 6
    '    return this.prisma.note.delete({ where: { id: noteId } });', // 7
    '  }', // 8
    '}', // 9
  ].join('\n');
  const confirm = {
    verdict: 'confirmed' as const,
    severity: 'high' as const,
    decisiveCode:
      'if (!note.authorId) {\nreturn this.prisma.note.delete({ where: { id: noteId } });',
    failureSite: `${SVC}:7`,
    reachableTrigger: 'A user deletes another user’s note by id',
    violatedInvariant: 'Only the author may delete a note',
    triggerSource: 'async remove(userId: string, noteId: string) {',
  };

  it('a real bug inside defensive code stays confirmable when the answer explains how it fails', async () => {
    const a = await assess({
      files: { [SVC]: svc },
      path: SVC,
      from: 1,
      to: 9,
      focus: 4,
      output: {
        ...confirm,
        guardsOnPath: [
          {
            code: 'if (!note.authorId) {',
            whyNotPreventing:
              'It only rejects notes without an author; it never compares authorId with userId.',
          },
        ],
      },
    });
    expect(a).toMatchObject({ verdict: 'confirmed' });
  });

  it('a confirmation that does not explain the defensive code is not proof', async () => {
    const a = await assess({
      files: { [SVC]: svc },
      path: SVC,
      from: 1,
      to: 9,
      focus: 4,
      output: confirm,
    });
    expect(a.verdict).toBe('insufficient_context');
    // The guard before the site is also unaddressed; either rule blocks the bare claim.
    expect(['defensive_not_explained', 'guard_not_addressed']).toContain(a.audit.rule);
  });

  it('defensive evidence is recognised (guards, throws, catch, logging, fallbacks, null returns)', () => {
    for (const line of [
      'if (!membership) {',
      "throw new ForbiddenException('x');",
      '} catch (error) {',
      "this.logger.warn({ msg: 'x' });",
      "const name = input.name ?? 'anonymous';",
      'return repo ? `${repo.owner}/${repo.repo}` : null;',
      'setError(MANAGE_DENIED_MESSAGE);',
    ]) {
      expect(DEFENSIVE_EVIDENCE_RE.test(line)).toBe(true);
    }
    expect(DEFENSIVE_EVIDENCE_RE.test('return this.prisma.note.delete({ where: { id } });')).toBe(
      false,
    );
  });
});
