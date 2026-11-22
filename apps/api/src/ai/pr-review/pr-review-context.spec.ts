import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parsePatch } from './diff-hunks';
import {
  buildContextBlocks,
  buildVerificationContext,
  diffWindowSection,
  enclosingRange,
  findDefinition,
  helperCallNames,
} from './pr-review-context';
import { validatedFinding } from './pr-review-fixtures';
import { buildVerificationContent, decisiveCodeIsGrounded } from './pr-review-verify';
import { PullRequestDiffService } from './pull-request-diff.service';
import { repositoryAccessStub } from '../../github-app/github-access.test-helpers';

const SERVICE = [
  "import { Injectable } from '@nestjs/common';", // 1
  '', // 2
  '@Injectable()', // 3
  'export class MemoryService {', // 4
  '  constructor(private readonly prisma: Prisma) {}', // 5
  '', // 6
  '  async archive(userId: string, id: string) {', // 7
  '    const workspaceId = await this.authorize(userId, "memory:manage");', // 8
  '    const row = await this.prisma.memory.findFirst({ where: { id, workspaceId } });', // 9
  "    if (!row) throw new NotFoundException('missing');", // 10
  '    return this.prisma.memory.update({ where: { id: row.id }, data: { status: "archived" } });', // 11
  '  }', // 12
  '', // 13
  '  private async authorize(userId: string, permission: string): Promise<string> {', // 14
  '    const workspaceId = await resolveWorkspaceIdForUser(this.prisma, userId);', // 15
  '    await this.access.assertAccess({ userId, workspaceId, permission });', // 16
  '    return workspaceId;', // 17
  '  }', // 18
  '}', // 19
];
const TEXT = SERVICE.join('\n');

describe('enclosing code context', () => {
  it('finds the enclosing method of a changed line', () => {
    expect(enclosingRange(SERVICE, 9)).toEqual({ start: 7, end: 12 });
    expect(enclosingRange(SERVICE, 16)).toEqual({ start: 14, end: 18 });
  });

  it('falls back to a bounded window when no block is found', () => {
    const flat = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    expect(enclosingRange(flat, 150, 40)).toEqual({ start: 130, end: 170 });
  });

  it('identifies authorization helpers called on changed lines (not on context lines)', () => {
    const lines = parsePatch(
      [
        '@@ -7,3 +7,3 @@',
        '   async archive(userId: string, id: string) {',
        '+    const workspaceId = await this.authorize(userId, "memory:manage");',
        '     const row = await this.prisma.memory.findFirst({ where: { id, workspaceId } });',
      ].join('\n'),
    )[0]!.lines;
    expect(helperCallNames(lines)).toEqual(['authorize']);
  });

  it('finds a helper definition, not its call sites', () => {
    expect(findDefinition(SERVICE, 'authorize')).toEqual({ start: 14, end: 18 });
    expect(findDefinition(SERVICE, 'doesNotExist')).toBeNull();
  });

  it('builds enclosing + helper blocks within the character budget', async () => {
    const provider = vi.fn(async (path: string) =>
      path === 'src/memory.service.ts' ? TEXT : null,
    );
    const changed = [{ kind: '+' as const, text: SERVICE[7]!, newLine: 8, oldLine: null }];
    const blocks = await buildContextBlocks({
      path: 'src/memory.service.ts',
      changedLines: changed,
      provider,
      maxChars: 5_000,
    });
    expect(blocks.map((b) => b.label)).toEqual([
      'lines 7-12 (enclosing code at PR head)',
      'definition of authorize(), lines 14-18',
    ]);
    expect(blocks[1]!.text).toContain('16:     await this.access.assertAccess');

    const tiny = await buildContextBlocks({
      path: 'src/memory.service.ts',
      changedLines: changed,
      provider,
      maxChars: 400,
    });
    expect(tiny.reduce((n, b) => n + b.text.length, 0)).toBeLessThanOrEqual(400);
  });
});

describe('PullRequestDiffService.createFileProvider (read-only context at the PR head)', () => {
  const resolveApiToken = vi.fn();
  const accessDouble = repositoryAccessStub({}, () => resolveApiToken());
  const resolveAccess = vi.spyOn(accessDouble, 'resolveRepositoryAccess');
  const service = new PullRequestDiffService(accessDouble as never);
  const fetchMock = vi.fn();
  const realFetch = global.fetch;
  const base = {
    userId: 'u1',
    workspaceId: 'ws_team',
    owner: 'GH0ST-000',
    repository: 'Ai-Extension',
    ref: '69e1fc4abc',
    maxFiles: 2,
  };
  beforeEach(() => {
    resolveApiToken.mockReset().mockResolvedValue({ token: 't', source: 'installation' });
    fetchMock
      .mockReset()
      .mockImplementation(async () => new Response('file body', { status: 200 }));
    global.fetch = fetchMock as never;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('uses the acting workspace credentials, the head SHA and the contents API', async () => {
    const provider = service.createFileProvider(base);
    expect(await provider('apps/api/src/a b.ts')).toBe('file body');
    // H1: a repository-scoped READ for this exact repository and workspace.
    expect(resolveAccess).toHaveBeenCalledWith('u1', {
      owner: 'GH0ST-000',
      repository: 'Ai-Extension',
      access: 'read',
      workspaceId: 'ws_team',
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://api.github.com/repos/GH0ST-000/Ai-Extension/contents/apps/api/src/a%20b.ts?ref=69e1fc4abc',
    );
  });

  it('memoizes, caps distinct files and refuses traversal, binaries and non-SHA refs', async () => {
    const provider = service.createFileProvider(base);
    await provider('a.ts');
    await provider('a.ts');
    await provider('b.ts');
    expect(await provider('c.ts')).toBeNull(); // cap of 2 reached
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const bad of ['../secrets.env', '/etc/passwd', 'a/./b.ts', 'logo.png', '']) {
      expect(await provider(bad)).toBeNull();
    }
    const branchRef = service.createFileProvider({ ...base, ref: 'main' });
    expect(await branchRef('a.ts')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null (never throws) when GitHub fails or the file is too large', async () => {
    fetchMock.mockResolvedValueOnce(new Response('no', { status: 404 }));
    fetchMock.mockResolvedValueOnce(
      new Response('x'.repeat(10), { status: 200, headers: { 'content-length': '900000' } }),
    );
    const provider = service.createFileProvider({ ...base, maxFiles: 5 });
    expect(await provider('missing.ts')).toBeNull();
    expect(await provider('huge.ts')).toBeNull();
  });
});

describe('verification grounding', () => {
  const code = [
    '@@ -7,3 +7,3 @@',
    '+    const row = await this.prisma.memory.findFirst({ where: { id, workspaceId } });',
    '### context: src/memory.service.ts — definition of authorize()',
    '16:     await this.access.assertAccess({ userId, workspaceId, permission });',
  ].join('\n');

  it('accepts verdicts quoting substantive provided code (diff or numbered context)', () => {
    expect(
      decisiveCodeIsGrounded(
        'await this.access.assertAccess({ userId, workspaceId, permission });',
        code,
      ),
    ).toBe(true);
    expect(
      decisiveCodeIsGrounded(
        '+    const row = await this.prisma.memory.findFirst({ where: { id, workspaceId } });',
        code,
      ),
    ).toBe(true);
  });

  it('rejects ungrounded or trivial decisive code', () => {
    expect(
      decisiveCodeIsGrounded('if (!isAdmin(user)) throw new ForbiddenException();', code),
    ).toBe(false);
    expect(decisiveCodeIsGrounded('});', code)).toBe(false);
    expect(decisiveCodeIsGrounded('', code)).toBe(false);
  });

  it('the verifier prompt puts code first, the claim after it as untrusted data, and grounds only on code', () => {
    const finding = validatedFinding({
      title: 'Archive bypasses workspace check',
      evidence: 'await this.access.assertAccess({ userId, workspaceId, permission });',
    });
    const { content, provided } = buildVerificationContent({
      finding,
      sections: [
        {
          path: 'src/a.ts',
          label: 'diff around the finding',
          lines: [{ tag: 'ADD', n: 1, old: null, text: 'const a = computeThing(1);' }],
          focus: 0,
        },
      ],
    });
    expect(content.indexOf('## Code (read this first)')).toBeLessThan(
      content.indexOf('## Candidate finding (untrusted claim)'),
    );
    expect(content).toContain('ADD        1 | const a = computeThing(1);');
    expect(content).not.toContain('PROJECT_MEMORY source');
    expect(decisiveCodeIsGrounded(finding.evidence, provided.codeText)).toBe(false);
    expect(provided.headLines.get('src/a.ts')).toEqual(new Set([1]));
  });
});

describe('finding-centred verification context', () => {
  /** A 1,500-line service with the finding deep inside (line 1,200). */
  const big = Array.from({ length: 1_500 }, (_, i) => {
    const n = i + 1;
    if (n === 1_190) return '  async exportAll(workspaceId: string) {';
    if (n === 1_200) return '    return this.prisma.memory.findMany({ where: {} });';
    if (n === 1_201) return '  }';
    if (n === 40) return '  private async authorize(userId: string) {';
    if (n === 41) return '    return this.access.assertAccess({ userId });';
    if (n === 42) return '  }';
    return `    const filler${n} = ${n};`;
  }).join('\n');
  const patch = [
    '@@ -1,1500 +1,1500 @@',
    ...big.split('\n').map((l, i) => (i + 1 === 1_200 ? `+${l}` : ` ${l}`)),
  ].join('\n');
  const diffLines = parsePatch(patch)[0]!.lines;

  it('large file: the window is centred on the finding, not the top of the file', async () => {
    const ctx = await buildVerificationContext({
      path: 'src/big.ts',
      diffLinesByPath: new Map([['src/big.ts', diffLines]]),
      lineStart: 1_200,
      lineEnd: 1_200,
      headLine: 1_200,
      evidenceIndex: null,
      provider: async () => big,
      maxChars: 12_000,
    });
    expect(ctx.stats).toMatchObject({ diffWindow: true, headContext: true });
    const diff = ctx.sections[0]!;
    expect(diff.lines.some((l) => l.tag === 'ADD' && l.n === 1_200)).toBe(true);
    expect(Math.min(...diff.lines.map((l) => l.n ?? 0))).toBeGreaterThanOrEqual(1_140);
    const head = ctx.sections.find((s) => s.label.startsWith('code at PR head'))!;
    expect(head.lines.map((l) => l.n)).toContain(1_200);
    expect(head.lines.map((l) => l.n)).toContain(1_190); // enclosing function
    expect(head.lines.every((l) => (l.n ?? 0) >= 1_190 && (l.n ?? 0) <= 1_260)).toBe(true);
  });

  it('a tiny budget trims around the finding instead of dropping the file', async () => {
    const ctx = await buildVerificationContext({
      path: 'src/big.ts',
      diffLinesByPath: new Map([['src/big.ts', diffLines]]),
      lineStart: 1_200,
      lineEnd: 1_200,
      headLine: 1_200,
      evidenceIndex: null,
      provider: async () => big,
      maxChars: 1_500,
    });
    expect(ctx.sections[0]!.lines.find((l) => l.n === 1_200)).toBeDefined();
    expect(ctx.sections[0]!.label).toContain('trimmed around the finding');
  });

  it('deleted lines are tagged DEL with old numbers and are not executable head lines', () => {
    const lines = parsePatch(
      ['@@ -10,3 +10,2 @@', ' keep()', '-guard();', ' run();'].join('\n'),
    )[0]!.lines;
    const section = diffWindowSection('src/x.ts', lines, 1);
    expect(section.lines.map((l) => [l.tag, l.n, l.old])).toEqual([
      ['CTX', 10, 10],
      ['DEL', null, 11],
      ['CTX', 11, 12],
    ]);
  });

  it('finds callees defined in OTHER changed files from the diff, then reads them at head', async () => {
    const controllerPatch = parsePatch(
      [
        '@@ -1,0 +1,2 @@',
        '+async list(req) {',
        '+  return this.memory.listForWorkspace(req.body.workspaceId);',
      ].join('\n'),
    )[0]!.lines;
    const servicePatch = parsePatch(
      [
        '@@ -1,0 +1,3 @@',
        '+async listForWorkspace(workspaceId: string) {',
        '+  return db.memory.findMany({ where: { workspaceId } });',
        '+}',
      ].join('\n'),
    )[0]!.lines;
    const files: Record<string, string> = {
      'src/controller.ts':
        'async list(req) {\n  return this.memory.listForWorkspace(req.body.workspaceId);\n}',
      'src/service.ts':
        'async listForWorkspace(workspaceId: string) {\n  return db.memory.findMany({ where: { workspaceId } });\n}',
    };
    const provider = vi.fn(async (p: string) => files[p] ?? null);
    const ctx = await buildVerificationContext({
      path: 'src/controller.ts',
      diffLinesByPath: new Map([
        ['src/controller.ts', controllerPatch],
        ['src/service.ts', servicePatch],
      ]),
      lineStart: 2,
      lineEnd: 2,
      headLine: 2,
      evidenceIndex: null,
      provider,
      maxChars: 8_000,
    });
    expect(ctx.stats.helpers).toBe(1);
    const def = ctx.sections.find((s) => s.path === 'src/service.ts')!;
    expect(def.label).toBe('definition of listForWorkspace() at PR head');
    expect(provider).not.toHaveBeenCalledWith('src/unrelated.ts');
  });
});
