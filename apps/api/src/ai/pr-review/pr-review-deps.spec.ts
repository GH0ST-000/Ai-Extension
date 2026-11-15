import { zodSchema } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { CodeSection } from './pr-review-context';
import {
  DEP_MAX_DEPTH,
  DEP_MAX_FUNCTIONS,
  DEP_MAX_SECURITY_DEPTH,
  DependencyCache,
  functionEnd,
  isSafeSourcePath,
  stripJsonComments,
  normalizeRepoPath,
  resolveDependencies,
} from './pr-review-deps';
import { validatedFinding } from './pr-review-fixtures';
import {
  assessVerdict,
  buildVerificationContent,
  VERIFY_REQUEST_OVERHEAD_CHARS,
  verificationSchema,
  type VerificationOutput,
} from './pr-review-verify';

// ── a small repository at the PR head (only memory.service.ts is "in the diff") ──

const filler = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `    const ${tag}${i} = ${i};`);

const REPO: Record<string, string> = {
  'apps/api/tsconfig.json':
    '{\n  // aliases\n  "compilerOptions": { "baseUrl": "./", "paths": { "@/*": ["src/*"] } },\n}',
  'apps/api/src/memory/memory.service.ts': [
    "import { WorkspaceAuthorizationService } from '@/workspaces/workspace-authorization.service';", // 1
    "import { resolveWorkspaceIdForUser } from '../workspaces/resolve-workspace-id';", // 2
    "import { assertBig } from '../workspaces/big-guard';", // 3
    'export class MemoryService {', // 4
    '  constructor(private readonly access: WorkspaceAuthorizationService) {}', // 5
    '  async list(userId: string) {', // 6
    "    const workspaceId = await this.authorize(userId, 'memory:read');", // 7
    '    return this.prisma.memory.findMany({ where: { workspaceId } });', // 8
    '  }', // 9
    '  async exportAll(userId: string, opts: { debug: boolean }) {', // 10
    '    if (opts.debug) {', // 11
    "      await this.authorize(userId, 'memory:read');", // 12
    '    }', // 13
    '    return this.prisma.memory.findMany({});', // 14
    '  }', // 15
    '  async exportUnsafe(userId: string) {', // 16
    '    return this.prisma.memory.findMany({});', // 17
    '  }', // 18
    '  async late(userId: string) {', // 19
    '    const rows = await this.prisma.memory.findMany({});', // 20
    "    await this.authorize(userId, 'memory:read');", // 21
    '    return rows;', // 22
    '  }', // 23
    '  async bulk(userId: string) {', // 24
    '    assertBig(userId);', // 25
    '    return this.prisma.memory.deleteMany({});', // 26
    '  }', // 27
    '  private async authorize(userId: string, permission: string): Promise<string> {', // 28
    '    const workspaceId = await resolveWorkspaceIdForUser(this.prisma, userId);', // 29
    '    await this.access.assertAccess({ userId, workspaceId, permission });', // 30
    '    return workspaceId;', // 31
    '  }', // 32
    '}', // 33
  ].join('\n'),
  // Unchanged file (not in the PR diff), reached through the "@/" alias.
  'apps/api/src/workspaces/workspace-authorization.service.ts': [
    'export class WorkspaceAuthorizationService {', // 1
    '  async assertAccess(input: { userId: string; workspaceId: string; permission?: string }) {', // 2
    '    const membership = await this.prisma.membership.findFirst({ where: { userId: input.userId, workspaceId: input.workspaceId } });', // 3
    '    if (!membership) {', // 4
    "      throw workspaceException('WORKSPACE_ACCESS_DENIED', 'Not a member.');", // 5
    '    }', // 6
    '    if (input.permission && !roleHasPermission(membership.role, input.permission)) {', // 7
    "      throw workspaceException('WORKSPACE_ACCESS_DENIED', 'Missing permission.');", // 8
    '    }', // 9
    '    return membership;', // 10
    '  }', // 11
    '}', // 12
  ].join('\n'),
  'apps/api/src/workspaces/resolve-workspace-id.ts': [
    'export async function resolveWorkspaceIdForUser(prisma: Prisma, userId: string, requested?: string): Promise<string> {', // 1
    '  const membership = await prisma.membership.findFirst({ where: { userId, workspaceId: requested } });', // 2
    '  if (!membership) {', // 3
    "    throw workspaceException('WORKSPACE_CONTEXT_UNAVAILABLE', 'Not available.');", // 4
    '  }', // 5
    '  return membership.workspaceId;', // 6
    '}', // 7
  ].join('\n'),
  // A guard longer than the function-line limit → PARTIAL slice.
  'apps/api/src/workspaces/big-guard.ts': [
    'export function assertBig(userId: string): void {',
    ...filler(70, 'step'),
    '    if (!userId) {',
    "      throw new ForbiddenException('denied');",
    '    }',
    '}',
  ].join('\n'),
  // GitHub token resolution chain.
  'apps/api/src/ai/pr-review/pull-request-diff.service.ts': [
    "import { GithubAccessService } from '@/github-app/github-access.service';", // 1
    'export class PullRequestDiffService {', // 2
    '  constructor(private readonly githubAccess: GithubAccessService) {}', // 3
    '  private async fetchFromGitHub(userId: string, workspaceId: string) {', // 4
    '    const resolved = await this.githubAccess.resolveApiToken(userId, workspaceId);', // 5
    "    if (!resolved) throw new GitHubDiffFetchError('not_connected');", // 6
    "    return this.getJson('https://api.github.com/x', resolved.token);", // 7
    '  }', // 8
    '}', // 9
  ].join('\n'),
  'apps/api/src/github-app/github-access.service.ts': [
    "import { resolveWorkspaceIdForUser } from '../workspaces/resolve-workspace-id';", // 1
    'export class GithubAccessService {', // 2
    '  async resolveApiToken(userId: string, explicitWorkspaceId?: string) {', // 3
    '    const workspaceId = await this.resolveWorkspaceId(userId, explicitWorkspaceId);', // 4
    '    const installationId = await this.installations.getActiveInstallationId(workspaceId);', // 5
    "    if (installationId) return { token: await this.appTokens.mint(installationId), source: 'installation' };", // 6
    "    const debugToken = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';", // 7
    '    return null;', // 8
    '  }', // 9
    '  private async resolveWorkspaceId(userId: string, explicitWorkspaceId?: string): Promise<string> {', // 10
    '    return resolveWorkspaceIdForUser(this.prisma, userId, explicitWorkspaceId);', // 11
    '  }', // 12
    '}', // 13
  ].join('\n'),
  // Cycle a → b → a.
  'apps/api/src/cyc/a.ts': [
    "import { b } from './b';",
    'export function a(n: number): number {',
    '  return n > 0 ? b(n - 1) : 0;',
    '}',
  ].join('\n'),
  'apps/api/src/cyc/b.ts': [
    "import { a } from './a';",
    'export function b(n: number): number {',
    '  return n > 0 ? a(n - 1) : 0;',
    '}',
  ].join('\n'),
  'apps/api/src/cyc/entry.ts': [
    "import { a } from './a';",
    'export function entry() {',
    '  return a(3);',
    '}',
  ].join('\n'),
  // Unsafe / missing imports.
  'apps/api/src/unsafe/entry.ts': [
    "import { authorizeEscape } from '../../../../../../etc/passwd';", // 1
    "import { checkSecret } from './config/secrets';", // 2
    "import { checkAccess } from 'some-auth-lib';", // 3
    "import { verifyMissing } from './missing-guard';", // 4
    'export async function run(u: string) {', // 5
    '  authorizeEscape(u);', // 6
    '  checkSecret(u);', // 7
    '  checkAccess(u);', // 8
    '  verifyMissing(u);', // 9
    '  return db.memory.deleteMany({});', // 10
    '}', // 11
  ].join('\n'),
  'apps/api/src/unsafe/config/secrets.ts': "export function checkSecret() { const apiKey = 'x'; }",
  'apps/api/src/keys/entry.ts': [
    "import { loadKey } from './key-loader';",
    'export function sign() {',
    '  return loadKey();',
    '}',
  ].join('\n'),
  'apps/api/src/keys/key-loader.ts': [
    'export function loadKey() {',
    "  return '-----BEGIN RSA PRIVATE KEY-----\\nMIIabc\\n-----END RSA PRIVATE KEY-----';",
    '}',
  ].join('\n'),
};

function providerFor(files: Record<string, string>) {
  return vi.fn(async (path: string) => files[path] ?? null);
}

/** Window = the finding's file at head around the focus line (like buildVerificationContext). */
function windowFor(path: string, from: number, to: number): CodeSection {
  const lines = REPO[path]!.split('\n');
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

async function verify(input: {
  path: string;
  from: number;
  to: number;
  focus: number;
  output: Partial<VerificationOutput>;
  cache?: DependencyCache;
  category?: 'security' | 'correctness';
}) {
  const cache = input.cache ?? new DependencyCache(providerFor(REPO));
  const window = windowFor(input.path, input.from, input.to);
  const deps = await resolveDependencies({
    originPath: input.path,
    originText: REPO[input.path]!,
    windowLines: window.lines,
    focusLine: input.focus,
    cache,
    maxChars: 8_000,
  });
  const finding = validatedFinding({
    path: input.path,
    category: input.category ?? 'security',
    severity: 'high',
    lineStart: input.focus,
    lineEnd: input.focus,
    headLine: input.focus,
    evidence: REPO[input.path]!.split('\n')[input.focus - 1]!.trim(),
  });
  const { content, provided } = buildVerificationContent({
    finding,
    sections: [window],
    dependencies: deps,
    fileTexts: new Map([[input.path, REPO[input.path]!]]),
  });
  const output: VerificationOutput = {
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
  };
  return { deps, content, assessed: assessVerdict(output, finding, provided) };
}

const MEMORY = 'apps/api/src/memory/memory.service.ts';

describe('cross-file dependency resolution', () => {
  it('valid authorization: authorize → assertAccess (unchanged file via "@/") → refuted by the membership denial', async () => {
    const { deps, assessed, content } = await verify({
      path: MEMORY,
      from: 6,
      to: 9,
      focus: 8,
      output: {
        decisiveCode: "throw workspaceException('WORKSPACE_ACCESS_DENIED', 'Not a member.');",
      },
    });
    expect(deps.resolved.map((d) => [d.name, d.depth, d.partial])).toEqual(
      expect.arrayContaining([
        ['authorize', 1, false],
        ['WorkspaceAuthorizationService.assertAccess', 2, false],
        ['resolveWorkspaceIdForUser', 2, false],
      ]),
    );
    expect(content).toContain(
      'dependency authorize → WorkspaceAuthorizationService.assertAccess() — complete',
    );
    expect(assessed.verdict).toBe('refuted');
  });

  it('cross-workspace denial: refuted by resolveWorkspaceIdForUser rejecting a foreign workspace', async () => {
    const { assessed } = await verify({
      path: MEMORY,
      from: 6,
      to: 9,
      focus: 8,
      output: {
        decisiveCode:
          "throw workspaceException('WORKSPACE_CONTEXT_UNAVAILABLE', 'Not available.');",
      },
    });
    expect(assessed.verdict).toBe('refuted');
  });

  it('a denial whose condition depends on an uninspected decision helper is NOT accepted', async () => {
    const { deps, assessed } = await verify({
      path: MEMORY,
      from: 6,
      to: 9,
      focus: 8,
      output: {
        decisiveCode: "throw workspaceException('WORKSPACE_ACCESS_DENIED', 'Missing permission.');",
      },
    });
    expect(deps.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'roleHasPermission', reason: 'depth_limit' }),
      ]),
    );
    expect(assessed).toMatchObject({ verdict: 'insufficient_context' });
    expect(assessed.reason).toContain('roleHasPermission');
  });

  it('an ambiguous quote matching several denials cannot borrow the safest one', async () => {
    // Matches both the membership denial (sound) and the permission denial (depends on the
    // uninspected roleHasPermission): every occurrence must establish the path.
    const { assessed } = await verify({
      path: MEMORY,
      from: 6,
      to: 9,
      focus: 8,
      output: { decisiveCode: "throw workspaceException('WORKSPACE_ACCESS_DENIED'," },
    });
    expect(assessed.verdict).toBe('insufficient_context');
    expect(assessed.reason).toContain('roleHasPermission');
  });

  it('missing authorization: no guard on the path → a grounded confirmation stands', async () => {
    const { deps, assessed } = await verify({
      path: MEMORY,
      from: 16,
      to: 18,
      focus: 17,
      output: {
        verdict: 'confirmed',
        severity: 'high',
        decisiveCode:
          'async exportUnsafe(userId: string) {\nreturn this.prisma.memory.findMany({});',
        failureSite: `${MEMORY}:17`,
        reachableTrigger: 'Any authenticated user calls exportUnsafe',
        triggerSource: 'async exportUnsafe(userId: string) {',
        violatedInvariant: 'Reads are limited to the caller workspace',
      },
    });
    expect(deps.resolved).toEqual([]);
    expect(assessed.verdict).toBe('confirmed');
  });

  it.each([
    ['inside an unrelated branch (if (opts.debug))', 10, 15, 14],
    ['after the vulnerable operation', 19, 23, 20],
  ])(
    'guard present but unreachable — %s: refutation is not accepted',
    async (_l, from, to, focus) => {
      const { assessed } = await verify({
        path: MEMORY,
        from,
        to,
        focus,
        output: {
          decisiveCode: "throw workspaceException('WORKSPACE_ACCESS_DENIED', 'Not a member.');",
        },
      });
      expect(assessed.verdict).toBe('insufficient_context');
      expect(assessed.reason).toMatch(/not shown to run before the vulnerable line/);
    },
  );

  it('partial guard slice: marked PARTIAL and cannot refute', async () => {
    const { deps, content, assessed } = await verify({
      path: MEMORY,
      from: 24,
      to: 27,
      focus: 26,
      output: { decisiveCode: "throw new ForbiddenException('denied');" },
    });
    expect(deps.resolved.find((d) => d.name === 'assertBig')).toMatchObject({ partial: true });
    expect(content).toMatch(
      /dependency assertBig\(\) — PARTIAL guard slice \(\d+ of 75 lines; omitted lines may change control flow\)/,
    );
    expect(assessed.verdict).toBe('insufficient_context');
    expect(assessed.reason).toContain('partial context');
  });

  it('GitHub token resolution: field type + "@/" alias → resolveApiToken → resolveWorkspaceId; tokens redacted', async () => {
    const path = 'apps/api/src/ai/pr-review/pull-request-diff.service.ts';
    const { deps, content } = await verify({ path, from: 4, to: 8, focus: 5, output: {} });
    expect(deps.resolved.map((d) => d.name)).toEqual(
      expect.arrayContaining(['GithubAccessService.resolveApiToken', 'resolveWorkspaceId']),
    );
    expect(deps.resolved.find((d) => d.name === 'GithubAccessService.resolveApiToken')!.path).toBe(
      'apps/api/src/github-app/github-access.service.ts',
    );
    // Uninspectable collaborators are listed explicitly, with a reason.
    expect(content).toContain('## Dependencies not shown');
    expect(content).toMatch(
      /this\.installations\.getActiveInstallationId\(\) called at apps\/api\/src\/github-app\/github-access\.service\.ts:5 — NOT SHOWN: definition not found/,
    );
    // Secrets in fetched source never reach the prompt.
    expect(content).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(content).toContain('[REDACTED]');
  });

  it('unchanged helper files are read only through the authorized provider, exactly once per review', async () => {
    const provider = providerFor(REPO);
    const cache = new DependencyCache(provider);
    await verify({ path: MEMORY, from: 6, to: 9, focus: 8, output: {}, cache });
    await verify({ path: MEMORY, from: 6, to: 9, focus: 8, output: {}, cache });
    const reads = provider.mock.calls.map((c) => c[0]);
    expect(reads).toContain('apps/api/src/workspaces/workspace-authorization.service.ts');
    expect(
      reads.filter((p) => p === 'apps/api/src/workspaces/workspace-authorization.service.ts'),
    ).toHaveLength(1);
    expect(reads.every((p) => isSafeSourcePath(p) || /(?:tsconfig|package)\.json$/.test(p))).toBe(
      true,
    );
    // Counters logged per review: distinct requests, cache hits, and split budgets — config
    // reads and missing-file probes are not charged to the source-file budget.
    const isConfig = (p: string) => /(?:tsconfig|package)\.json$/.test(p);
    expect(cache.attempted).toBe(new Set(reads).size);
    expect(cache.hits).toBeGreaterThan(0);
    expect(cache.configReads).toBe(reads.filter(isConfig).length);
    expect(cache.probes).toBe(reads.filter((p) => !isConfig(p) && REPO[p] == null).length);
    expect(cache.sourceFiles).toBe(reads.filter((p) => !isConfig(p) && REPO[p] != null).length);
  });

  it('cyclic dependencies: each function appears once and traversal terminates', async () => {
    const { deps } = await verify({
      path: 'apps/api/src/cyc/entry.ts',
      from: 2,
      to: 4,
      focus: 3,
      output: {},
      category: 'correctness',
    });
    expect(deps.resolved.map((d) => d.name)).toEqual(['a', 'b']);
  });

  it('missing / unsafe sources are unresolved with precise reasons and block security verdicts', async () => {
    const { deps, assessed } = await verify({
      path: 'apps/api/src/unsafe/entry.ts',
      from: 5,
      to: 11,
      focus: 10,
      output: {
        verdict: 'confirmed',
        severity: 'high',
        decisiveCode: 'checkAccess(u);\nreturn db.memory.deleteMany({});',
        failureSite: 'apps/api/src/unsafe/entry.ts:10',
        reachableTrigger: 'Any caller deletes every row',
        violatedInvariant: 'Deletes are scoped to the workspace',
      },
    });
    const reasons = Object.fromEntries(deps.unresolved.map((u) => [u.name, u.reason]));
    expect(reasons).toEqual({
      authorizeEscape: 'outside_repository',
      checkSecret: 'unsafe_path',
      checkAccess: 'external_package',
      verifyMissing: 'not_found_or_inaccessible',
    });
    // A guard before the deleteMany could not be inspected → confirmation is not accepted.
    expect(assessed.verdict).toBe('insufficient_context');
  });

  it('a function containing a private key is never included', async () => {
    const { deps, content } = await verify({
      path: 'apps/api/src/keys/entry.ts',
      from: 2,
      to: 4,
      focus: 3,
      output: {},
      category: 'correctness',
    });
    expect(deps.resolved).toEqual([]);
    expect(content).not.toContain('PRIVATE KEY');
  });

  it('dependency budget exhaustion: the file budget and function limit are enforced and reported', async () => {
    // One source file (config reads are no longer charged to it): the second helper file
    // must hit the source-file budget.
    const tiny = new DependencyCache(providerFor(REPO), 1);
    const { deps } = await verify({
      path: MEMORY,
      from: 6,
      to: 9,
      focus: 8,
      output: {},
      cache: tiny,
    });
    expect(tiny.sourceFiles).toBeLessThanOrEqual(1);
    expect(deps.unresolved.some((u) => u.reason === 'file_budget')).toBe(true);

    const many = Array.from(
      { length: 9 },
      (_, i) => `  async checkThing${i}(u: string) {\n    if (!u) throw new Error('x');\n  }`,
    ).join('\n');
    const calls = Array.from({ length: 9 }, (_, i) => `    await this.checkThing${i}(u);`).join(
      '\n',
    );
    const file = `export class S {\n  async run(u: string) {\n${calls}\n    return db.x.deleteMany({});\n  }\n${many}\n}`;
    const res = await resolveDependencies({
      originPath: 'apps/api/src/s.ts',
      originText: file,
      windowLines: file.split('\n').map((text, i) => ({ n: i + 1, text })),
      focusLine: 12,
      cache: new DependencyCache(providerFor({})),
      maxChars: 20_000,
    });
    expect(res.resolved).toHaveLength(DEP_MAX_FUNCTIONS);
    expect(res.unresolved.filter((u) => u.reason === 'function_limit')).toHaveLength(3);
  });

  it('cancellation during dependency fetch returns promptly and marks the rest cancelled', async () => {
    const controller = new AbortController();
    const hanging = vi.fn(
      (_path: string, signal?: AbortSignal) =>
        new Promise<string | null>((resolve) =>
          signal?.addEventListener('abort', () => resolve(null)),
        ),
    );
    setTimeout(() => controller.abort(), 5);
    const started = Date.now();
    const res = await resolveDependencies({
      originPath: MEMORY,
      originText: REPO[MEMORY]!,
      windowLines: windowFor(MEMORY, 6, 9).lines,
      focusLine: 8,
      cache: new DependencyCache(hanging),
      maxChars: 8_000,
      signal: controller.signal,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(hanging.mock.calls[0]![1]).toBe(controller.signal); // the fetch itself is aborted
    expect(res.unresolved.some((u) => u.reason === 'cancelled')).toBe(true);
  });
});

describe('path safety', () => {
  it.each([
    ['apps/api/src/a.ts', 'apps/api/src/a.ts'],
    ['apps/api/src/../src/./a.ts', 'apps/api/src/a.ts'],
    ['../outside.ts', null],
    ['/etc/passwd', null],
    ['https://evil.example/x.ts', null],
    ['apps\\api\\a.ts', null],
    ['apps/api/src/a b.ts', null],
  ])('normalizeRepoPath(%j) → %j', (input, expected) => {
    expect(normalizeRepoPath(input)).toBe(expected);
  });

  it.each([
    ['apps/api/src/auth/guard.ts', true],
    ['apps/web/src/page.tsx', true],
    ['apps/api/.env.local', false],
    ['apps/api/src/config/secrets.ts', false],
    ['apps/api/src/credentials.ts', false],
    ['apps/api/node_modules/x/index.js', false],
    ['apps/api/dist/main.js', false],
    ['apps/api/certs/server.pem', false],
    ['apps/api/src/types.d.ts', false],
    ['apps/api/src/data.json', false],
  ])('isSafeSourcePath(%j) → %s', (path, expected) => {
    expect(isSafeSourcePath(path)).toBe(expected);
  });
});

describe('regressions found on the real PR #48 code', () => {
  it('tsconfig with "@/*" and "**/*" parses (comment-like text inside strings is not a comment)', () => {
    const text =
      '{\n  // c\n  "compilerOptions": { "baseUrl": "./", "paths": { "@/*": ["src/*"] } },\n  "include": ["src/**/*", "test/**/*"], /* x */\n}';
    expect(JSON.parse(stripJsonComments(text))).toMatchObject({
      compilerOptions: { paths: { '@/*': ['src/*'] } },
      include: ['src/**/*', 'test/**/*'],
    });
  });

  it('a multi-line signature with an object parameter type is not mistaken for the function end', () => {
    const lines = [
      '  async assertAccess(input: {', // 1
      '    userId: string;', // 2
      '    workspaceId: string;', // 3
      '  }): Promise<Ctx> {', // 4
      "    const s = '}';", // 5  (brace inside a string)
      '    if (!input.userId) {', // 6
      "      throw new Error('denied');", // 7
      '    }', // 8
      '    return ctx; // }', // 9 (brace inside a comment)
      '  }', // 10
      '  other() {}', // 11
    ];
    expect(functionEnd(lines, 0)).toBe(10);
  });

  it('an unclosed body is reported PARTIAL, never "complete"', async () => {
    const file = [
      'export class S {',
      '  async run(u: string) {',
      '    await this.check(u);',
      '  }',
      '  async check(u: string) {',
      '    if (!u) {',
    ].join('\n');
    const res = await resolveDependencies({
      originPath: 'apps/api/src/s.ts',
      originText: file,
      windowLines: [{ n: 3, text: '    await this.check(u);' }],
      focusLine: 3,
      cache: new DependencyCache(providerFor({})),
      maxChars: 5_000,
    });
    expect(res.resolved[0]).toMatchObject({ name: 'check', partial: true });
    expect(res.sections[0]!.label).toContain('PARTIAL (end of function not found');
  });

  it('only the repository’s own package scope is mapped into the repo (@nestjs/… is external)', async () => {
    const provider = providerFor({
      'apps/api/package.json': '{ "name": "@project-x/api" }',
      'apps/api/tsconfig.json': '{ "compilerOptions": {} }',
      'packages/shared/src/index.ts': "export * from './roles';",
      'packages/shared/src/roles.ts':
        'export function roleHasPermission(role: string, p: string): boolean {\n  return role === p;\n}',
    });
    const origin = [
      "import { Injectable } from '@nestjs/common';",
      "import { roleHasPermission } from '@project-x/shared';",
      'export function guard(role: string) {',
      '  Injectable();',
      "  if (!roleHasPermission(role, 'x')) throw new Error('denied');",
      '}',
    ].join('\n');
    const res = await resolveDependencies({
      originPath: 'apps/api/src/g.ts',
      originText: origin,
      windowLines: origin.split('\n').map((text, i) => ({ n: i + 1, text })),
      focusLine: 5,
      cache: new DependencyCache(provider),
      maxChars: 5_000,
    });
    expect(res.resolved.map((d) => [d.name, d.path])).toEqual([
      ['roleHasPermission', 'packages/shared/src/roles.ts'],
    ]);
    expect(provider.mock.calls.map((c) => c[0]).some((p) => p.startsWith('packages/common'))).toBe(
      false,
    );
  });
});

// ── depth 3: authorization chains of security findings ──────────────────────────────────

const NOTES = 'apps/api/src/notes/notes.service.ts';
const ACCESS = 'apps/api/src/auth/access.service.ts';

const DEEP: Record<string, string> = {
  'apps/api/package.json': '{ "name": "@project-x/api" }',
  'apps/api/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }',
  [NOTES]: [
    "import { AccessService } from '@/auth/access.service';", // 1
    "import { formatTitle } from './format';", // 2
    'export class NotesService {', // 3
    '  constructor(private readonly access: AccessService) {}', // 4
    '  async list(userId: string, workspaceId: string) {', // 5
    '    const title = formatTitle(workspaceId);', // 6
    '    this.logger.log(title);', // 7
    '    await this.authorize(userId, workspaceId);', // 8
    '    return this.prisma.note.findMany({ where: { workspaceId } });', // 9
    '  }', // 10
    '  async listOpen(userId: string, workspaceId: string) {', // 11
    '    await this.access.checkNothing(userId, workspaceId);', // 12
    '    return this.prisma.note.findMany({ where: { workspaceId } });', // 13
    '  }', // 14
    '  async listDeep(userId: string, workspaceId: string) {', // 15
    '    await this.access.assertViaChain(userId, workspaceId);', // 16
    '    return this.prisma.note.findMany({ where: { workspaceId } });', // 17
    '  }', // 18
    '  async listDebug(userId: string, workspaceId: string) {', // 19
    '    await this.access.assertWhenDebug(userId, workspaceId);', // 20
    '    return this.prisma.note.findMany({ where: { workspaceId } });', // 21
    '  }', // 22
    '  async listAudited(userId: string, workspaceId: string) {', // 23
    '    await this.access.audit(userId, workspaceId);', // 24
    '    return this.prisma.note.findMany({ where: { workspaceId } });', // 25
    '  }', // 26
    '  private async authorize(userId: string, workspaceId: string) {', // 27
    '    await this.access.assertMember(userId, workspaceId);', // 28
    '  }', // 29
    '}', // 30
  ].join('\n'),
  'apps/api/src/notes/format.ts': [
    'export function formatTitle(workspaceId: string): string {',
    '  return describeWorkspace(workspaceId).trim();',
    '}',
    'function describeWorkspace(workspaceId: string): string {',
    '  return `Notes of ${workspaceId}`;',
    '}',
  ].join('\n'),
  [ACCESS]: [
    "import { roleHasPermission } from '@project-x/shared';", // 1
    "import { requireMembership, lookupMembership, strictCheck, recordAccess, describeAccess } from './membership';", // 2
    'export class AccessService {', // 3
    '  async assertMember(userId: string, workspaceId: string) {', // 4
    '    const role = await requireMembership(userId, workspaceId);', // 5
    "    if (!roleHasPermission(role, 'notes:read')) {", // 6
    "      throw new ForbiddenException('Missing permission.');", // 7
    '    }', // 8
    '  }', // 9
    '  async checkNothing(userId: string, workspaceId: string) {', // 10
    '    await recordAccess(userId, workspaceId);', // 11
    '  }', // 12
    '  async assertViaChain(userId: string, workspaceId: string) {', // 13
    '    const membership = await lookupMembership(userId, workspaceId);', // 14
    '    if (!membership) {', // 15
    "      throw new ForbiddenException('Chain denied.');", // 16
    '    }', // 17
    '  }', // 18
    '  async assertWhenDebug(userId: string, workspaceId: string) {', // 19
    '    if (process.env.DEBUG_ACCESS) {', // 20
    '      await strictCheck(userId, workspaceId);', // 21
    '    }', // 22
    '  }', // 23
    '  async audit(userId: string, workspaceId: string) {', // 24
    '    const text = describeAccess(userId, workspaceId);', // 25
    '    this.logger.log(text);', // 26
    '  }', // 27
    '}', // 28
  ].join('\n'),
  'apps/api/src/auth/membership.ts': [
    'export async function requireMembership(userId: string, workspaceId: string): Promise<string> {', // 1
    '  const m = await prisma.membership.findFirst({ where: { userId, workspaceId } });', // 2
    '  if (!m) {', // 3
    "    throw new ForbiddenException('Not a member.');", // 4
    '  }', // 5
    '  return m.role;', // 6
    '}', // 7
    'export async function recordAccess(userId: string, workspaceId: string): Promise<void> {', // 8
    '  auditLog.push({ userId, workspaceId });', // 9
    '}', // 10
    'export async function lookupMembership(userId: string, workspaceId: string) {', // 11
    '  return queryMembership(userId, workspaceId);', // 12
    '}', // 13
    'export async function strictCheck(userId: string, workspaceId: string): Promise<void> {', // 14
    '  const m = await prisma.membership.findFirst({ where: { userId, workspaceId } });', // 15
    '  if (!m) {', // 16
    "    throw new ForbiddenException('Strict denied.');", // 17
    '  }', // 18
    '}', // 19
    'export function describeAccess(userId: string, workspaceId: string): string {', // 20
    '  return checkPermissionLabel(userId, workspaceId);', // 21
    '}', // 22
    'function checkPermissionLabel(userId: string, workspaceId: string): string {', // 23
    '  return `${userId}@${workspaceId}`;', // 24
    '}', // 25
    'async function queryMembership(userId: string, workspaceId: string) {', // 26
    '  return prisma.membership.findFirst({ where: { userId, workspaceId } });', // 27
    '}', // 28
  ].join('\n'),
  // Two barrel levels, as in packages/shared: index → access/index → access/permissions.
  'packages/shared/src/index.ts': "export { roleHasPermission } from './access';",
  'packages/shared/src/access/index.ts': "export { roleHasPermission } from './permissions';",
  'packages/shared/src/access/permissions.ts': [
    "const READ = ['notes:read'];", // 1
    'const ROLE_PERMISSIONS: Record<string, string[]> = {', // 2
    '  owner: [...READ, "notes:manage"],', // 3
    '  member: READ,', // 4
    '  guest: [],', // 5
    '};', // 6
    'export function roleHasPermission(role: string, permission: string): boolean {', // 7
    '  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);', // 8
    '}', // 9
  ].join('\n'),
};

async function verifyDeep(input: {
  repo?: Record<string, string>;
  path: string;
  from: number;
  to: number;
  focus: number;
  output: Partial<VerificationOutput>;
  securityFinding?: boolean;
  category?: 'security' | 'correctness';
  maxChars?: number;
  maxFunctions?: number;
  cache?: DependencyCache;
}) {
  const repo = input.repo ?? DEEP;
  const lines = repo[input.path]!.split('\n');
  const window: CodeSection = {
    path: input.path,
    label: 'code at PR head around the finding',
    lines: Array.from({ length: input.to - input.from + 1 }, (_, i) => ({
      tag: 'HEAD' as const,
      n: input.from + i,
      old: null,
      text: lines[input.from + i - 1]!,
    })),
    focus: 0,
  };
  const deps = await resolveDependencies({
    originPath: input.path,
    originText: repo[input.path]!,
    windowLines: window.lines,
    focusLine: input.focus,
    cache: input.cache ?? new DependencyCache(providerFor(repo)),
    maxChars: input.maxChars ?? 12_000,
    securityFinding: input.securityFinding ?? true,
    ...(input.maxFunctions ? { maxFunctions: input.maxFunctions } : {}),
  });
  const finding = validatedFinding({
    path: input.path,
    category: input.category ?? 'security',
    severity: 'high',
    lineStart: input.focus,
    lineEnd: input.focus,
    headLine: input.focus,
    evidence: lines[input.focus - 1]!.trim(),
  });
  const { content, provided } = buildVerificationContent({
    finding,
    sections: [window],
    dependencies: deps,
    fileTexts: new Map([[input.path, repo[input.path]!]]),
  });
  const output: VerificationOutput = {
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
  };
  return { deps, content, assessed: assessVerdict(output, finding, provided) };
}

const names = (deps: { resolved: { name: string; depth: number }[] }) =>
  deps.resolved.map((d) => `${d.depth}:${d.name}`);

describe('depth 3 for security authorization chains', () => {
  it('constants: default depth stays 2; security chains may reach 3', () => {
    expect(DEP_MAX_DEPTH).toBe(2);
    expect(DEP_MAX_SECURITY_DEPTH).toBe(3);
    expect(DEP_MAX_FUNCTIONS).toBe(6);
  });

  it('authorization denial at depth 3: requireMembership() is resolved and the denial refutes', async () => {
    const { deps, assessed } = await verifyDeep({
      path: NOTES,
      from: 5,
      to: 10,
      focus: 9,
      output: { decisiveCode: "throw new ForbiddenException('Not a member.');" },
    });
    expect(names(deps)).toEqual(
      expect.arrayContaining([
        '1:authorize',
        '2:AccessService.assertMember',
        '3:requireMembership',
        '3:roleHasPermission',
      ]),
    );
    expect(deps.resolved.find((d) => d.name === 'requireMembership')).toMatchObject({
      edge: 'guard',
      authPath: true,
      partial: false,
    });
    expect(assessed.verdict).toBe('refuted');
  });

  it('the same denial at the default depth (non-security finding) is out of reach', async () => {
    const { deps, assessed } = await verifyDeep({
      path: NOTES,
      from: 5,
      to: 10,
      focus: 9,
      securityFinding: false,
      output: { decisiveCode: "throw new ForbiddenException('Not a member.');" },
    });
    expect(deps.resolved.every((d) => d.depth <= 2)).toBe(true);
    expect(deps.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'requireMembership', reason: 'depth_limit', depth: 3 }),
      ]),
    );
    expect(assessed.verdict).toBe('insufficient_context');
  });

  it('permission check through roleHasPermission: two barrel levels + its role table → refutes', async () => {
    const { deps, content, assessed } = await verifyDeep({
      path: NOTES,
      from: 5,
      to: 10,
      focus: 9,
      output: {
        decisiveCode:
          "if (!roleHasPermission(role, 'notes:read')) {\nthrow new ForbiddenException('Missing permission.');",
      },
    });
    expect(deps.resolved.find((d) => d.name === 'roleHasPermission')).toMatchObject({
      path: 'packages/shared/src/access/permissions.ts',
      depth: 3,
      partial: false,
    });
    expect(content).toContain(
      'roleHasPermission() (+ constants ROLE_PERMISSIONS, READ) — complete',
    );
    expect(content).toContain('member: READ,');
    expect(assessed.verdict).toBe('refuted');
  });

  it('permission check whose role table is imported (not shown) is PARTIAL and cannot refute', async () => {
    const repo = {
      ...DEEP,
      'packages/shared/src/access/permissions.ts': [
        "import { ROLE_PERMISSIONS } from './table';",
        'export function roleHasPermission(role: string, permission: string): boolean {',
        '  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);',
        '}',
      ].join('\n'),
    };
    const { content, assessed } = await verifyDeep({
      repo,
      path: NOTES,
      from: 5,
      to: 10,
      focus: 9,
      output: {
        decisiveCode:
          "if (!roleHasPermission(role, 'notes:read')) {\nthrow new ForbiddenException('Missing permission.');",
      },
    });
    expect(content).toContain('PARTIAL (constants not shown: ROLE_PERMISSIONS');
    expect(assessed.verdict).toBe('insufficient_context');
    expect(assessed.reason).toContain('roleHasPermission() is only partially shown');
  });

  it('missing guard at depth 3: the whole chain is shown, nothing denies → a grounded confirmation stands', async () => {
    const { deps, assessed } = await verifyDeep({
      path: NOTES,
      from: 11,
      to: 14,
      focus: 13,
      output: {
        verdict: 'confirmed',
        severity: 'high',
        decisiveCode:
          'await this.access.checkNothing(userId, workspaceId);\nreturn this.prisma.note.findMany({ where: { workspaceId } });',
        failureSite: `${NOTES}:13`,
        reachableTrigger: 'A non-member passes another workspaceId',
        triggerSource: 'async listOpen(userId: string, workspaceId: string) {',
        violatedInvariant: 'Only members read a workspace’s notes',
      },
    });
    expect(names(deps)).toEqual(['1:AccessService.checkNothing', '2:recordAccess']);
    expect(deps.unresolved).toEqual([]);
    expect(assessed.verdict).toBe('confirmed');
  });

  it('security chain exceeding depth 3: the decision at depth 4 is reported and blocks the refutation', async () => {
    const { deps, assessed } = await verifyDeep({
      path: NOTES,
      from: 15,
      to: 18,
      focus: 17,
      output: { decisiveCode: "throw new ForbiddenException('Chain denied.');" },
    });
    // listDeep → assertViaChain (1) → lookupMembership (2) → queryMembership (3): depth 3 is
    // within reach here; add one more hop to exceed it.
    expect(names(deps)).toContain('3:queryMembership');
    const longer = {
      ...DEEP,
      [NOTES]: DEEP[NOTES]!.replace(
        '    await this.access.assertViaChain(userId, workspaceId);',
        '    await this.authorizeDeep(userId, workspaceId);',
      ).replace(
        '  private async authorize(',
        '  private async authorizeDeep(userId: string, workspaceId: string) {\n    await this.access.assertViaChain(userId, workspaceId);\n  }\n  private async authorize(',
      ),
    };
    const deeper = await verifyDeep({
      repo: longer,
      path: NOTES,
      from: 15,
      to: 18,
      focus: 17,
      output: { decisiveCode: "throw new ForbiddenException('Chain denied.');" },
    });
    expect(deeper.deps.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'queryMembership', reason: 'depth_limit', depth: 4 }),
      ]),
    );
    expect(deeper.assessed.verdict).toBe('insufficient_context');
    expect(deeper.assessed.reason).toMatch(
      /lookupMembership\(\), whose result comes from queryMembership\(\).*depth limit/,
    );
    // Within reach (depth 3), the whole decision — down to the user-scoped query — is shown.
    expect(assessed.verdict).toBe('refuted');
  });

  it('guard present but unreachable at depth 3: a check only under a debug flag cannot refute', async () => {
    const { deps, assessed } = await verifyDeep({
      path: NOTES,
      from: 19,
      to: 22,
      focus: 21,
      output: { decisiveCode: "throw new ForbiddenException('Strict denied.');" },
    });
    expect(names(deps)).toContain('2:strictCheck');
    const viaWrapper = await verifyDeep({
      repo: {
        ...DEEP,
        [NOTES]: DEEP[NOTES]!.replace(
          '    await this.access.assertWhenDebug(userId, workspaceId);',
          '    await this.authorizeDebug(userId, workspaceId);',
        ).replace(
          '  private async authorize(',
          '  private async authorizeDebug(userId: string, workspaceId: string) {\n    await this.access.assertWhenDebug(userId, workspaceId);\n  }\n  private async authorize(',
        ),
      },
      path: NOTES,
      from: 19,
      to: 22,
      focus: 21,
      output: { decisiveCode: "throw new ForbiddenException('Strict denied.');" },
    });
    expect(names(viaWrapper.deps)).toContain('3:strictCheck');
    for (const a of [assessed, viaWrapper.assessed]) {
      expect(a.verdict).toBe('insufficient_context');
      expect(a.reason).toMatch(
        /strictCheck\(\) is not shown to run on every path through AccessService\.assertWhenDebug\(\)/,
      );
    }
  });

  it('relevance comes from behavior, not names: a security-named helper on a logging path stays at depth 2', async () => {
    const { deps } = await verifyDeep({
      path: NOTES,
      from: 23,
      to: 26,
      focus: 25,
      output: {},
    });
    expect(deps.resolved.find((d) => d.name === 'describeAccess')).toMatchObject({
      depth: 2,
      edge: 'other',
      authPath: false,
    });
    // checkPermissionLabel() sounds like a check, but describeAccess()'s result is only logged.
    expect(names(deps)).not.toContain('3:checkPermissionLabel');
    expect(deps.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'checkPermissionLabel', reason: 'depth_limit' }),
      ]),
    );
  });

  it('budget pressure: authorization guards are resolved before unrelated helpers', async () => {
    const { deps } = await verifyDeep({
      path: NOTES,
      from: 5,
      to: 10,
      focus: 9,
      maxFunctions: 4,
      output: {},
    });
    expect(names(deps)).toEqual([
      '1:authorize',
      '2:AccessService.assertMember',
      '3:roleHasPermission',
      '3:requireMembership',
    ]);
    expect(names(deps)).not.toContain('1:formatTitle');
  });

  it.each([
    ['function limit', { maxFunctions: 2 }, 'function_limit'],
    ['context budget', { maxChars: 900 }, 'context_budget'],
    ['file budget', { cache: new DependencyCache(providerFor(DEEP), 3) }, 'file_budget'],
  ] as const)(
    'budget exhaustion (%s) leaves the depth-3 permission check unresolved → Needs Investigation',
    async (_label, limits, reason) => {
      const { deps, assessed } = await verifyDeep({
        path: NOTES,
        from: 5,
        to: 10,
        focus: 9,
        ...limits,
        output: {
          decisiveCode:
            "if (!roleHasPermission(role, 'notes:read')) {\nthrow new ForbiddenException('Missing permission.');",
        },
      });
      expect(deps.unresolved.some((u) => u.reason === reason)).toBe(true);
      expect(assessed.verdict).toBe('insufficient_context');
    },
  );
});

describe('GitHub workspace authorization (shape of PR #48 resolveApiToken)', () => {
  const PR_DIFF = 'apps/api/src/ai/pr-review/pull-request-diff.service.ts';

  it('a base-level membership denial at depth 3 is reachable for security findings and refutes', async () => {
    // fetchFromGitHub → resolveApiToken (1) → resolveWorkspaceId (2) → resolveWorkspaceIdForUser (3)
    const output = {
      decisiveCode: "throw workspaceException('WORKSPACE_CONTEXT_UNAVAILABLE', 'Not available.');",
    };
    const security = await verifyDeep({
      repo: REPO,
      path: PR_DIFF,
      from: 4,
      to: 8,
      focus: 5,
      output,
    });
    expect(names(security.deps)).toEqual(
      expect.arrayContaining([
        '1:GithubAccessService.resolveApiToken',
        '2:resolveWorkspaceId',
        '3:resolveWorkspaceIdForUser',
      ]),
    );
    expect(
      security.deps.resolved.find((d) => d.name === 'resolveWorkspaceIdForUser'),
    ).toMatchObject({
      depth: 3,
      edge: 'return',
      authPath: true,
    });
    expect(security.content).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(security.assessed.verdict).toBe('refuted');

    const correctness = await verifyDeep({
      repo: REPO,
      path: PR_DIFF,
      from: 4,
      to: 8,
      focus: 5,
      output,
      securityFinding: false,
      category: 'correctness',
    });
    expect(names(correctness.deps)).not.toContain('3:resolveWorkspaceIdForUser');
  });

  it('a membership denial only on the "workspace requested" branch, deciding via a depth-4 query, stays Needs Investigation', async () => {
    const repo = {
      ...REPO,
      'apps/api/src/workspaces/resolve-workspace-id.ts': [
        'export async function resolveWorkspaceIdForUser(prisma: Prisma, userId: string, requested?: string): Promise<string> {', // 1
        '  const candidate = requested ?? peekRequestWorkspaceId();', // 2
        '  if (candidate) {', // 3
        '    const membership = await findActiveMembership(prisma, userId, candidate);', // 4
        '    if (!membership) {', // 5
        "      throw workspaceException('WORKSPACE_CONTEXT_UNAVAILABLE', 'Not available.');", // 6
        '    }', // 7
        '    return membership.workspaceId;', // 8
        '  }', // 9
        '  return `ws_${userId}`;', // 10
        '}', // 11
        'function findActiveMembership(prisma: Prisma, userId: string, workspaceId: string) {', // 12
        '  return prisma.membership.findFirst({ where: { workspaceId, userId } });', // 13
        '}', // 14
        'function peekRequestWorkspaceId(): string | undefined {', // 15
        '  return undefined;', // 16
        '}', // 17
      ].join('\n'),
    };
    const { deps, assessed } = await verifyDeep({
      repo,
      path: PR_DIFF,
      from: 4,
      to: 8,
      focus: 5,
      output: {
        decisiveCode:
          "if (!membership) {\nthrow workspaceException('WORKSPACE_CONTEXT_UNAVAILABLE', 'Not available.');",
      },
    });
    expect(deps.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'findActiveMembership', reason: 'depth_limit', depth: 4 }),
      ]),
    );
    expect(assessed.verdict).toBe('insufficient_context');
    expect(assessed.reason).toMatch(/only applies on a sub-branch/);
  });
});

describe('verification input ceiling', () => {
  it('the request overhead covers the structured-output schema sent with each call', async () => {
    const schema: unknown = await zodSchema(verificationSchema as never).jsonSchema;
    expect(JSON.stringify(schema).length + 200).toBeLessThanOrEqual(VERIFY_REQUEST_OVERHEAD_CHARS);
  });
});
