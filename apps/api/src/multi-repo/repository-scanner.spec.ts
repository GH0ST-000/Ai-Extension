import { describe, expect, it, vi } from 'vitest';

import { RepositoryScanner, ScanBudget, classifyGithubResponse } from './repository-scanner';

const TOKEN = 'ghp_scanner_test_token_0123456789abcdef';
const sha = (n: number) => n.toString(16).padStart(40, '0');
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

type Route = (url: string) => Response | undefined;

function fakeGithub(
  files: Record<string, string>,
  opts: { truncated?: boolean; extra?: Route } = {},
) {
  const shaToPath = new Map<string, string>();
  const tree = Object.entries(files).map(([path, content], i) => {
    shaToPath.set(sha(i + 1), path);
    return { path, type: 'blob', size: Buffer.byteLength(content), sha: sha(i + 1) };
  });
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const custom = opts.extra?.(url);
    if (custom) return custom;
    if (url.endsWith('/repos/acme/api')) return Response.json({ default_branch: 'main' });
    if (url.endsWith('/git/trees/HEAD?recursive=1')) {
      return Response.json({ tree, truncated: opts.truncated === true });
    }
    if (url.endsWith('/git/trees/HEAD')) {
      return Response.json({ tree: tree.filter((t) => !t.path.includes('/')) });
    }
    const blob = url.match(/\/git\/blobs\/([0-9a-f]+)$/);
    if (blob && shaToPath.has(blob[1]!)) {
      return Response.json({ content: b64(files[shaToPath.get(blob[1]!)!]!), encoding: 'base64' });
    }
    return new Response('{}', { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const FILES = {
  'package.json': '{"name":"api"}',
  'openapi.yaml': 'openapi: 3.0.0\npaths:\n  /api/users:\n    get: {}\n',
  'src/server.ts': "app.get('/api/users', h)",
  'node_modules/x/index.js': 'ignored',
  'src/server.spec.ts': 'ignored',
};

describe('RepositoryScanner', () => {
  it('reads metadata, the HEAD tree and selected blobs only (complete scan)', async () => {
    const gh = fakeGithub(FILES);
    const budget = new ScanBudget(50);
    const result = await new RepositoryScanner(TOKEN, budget, gh.fetchImpl).scan('acme', 'api', 24);
    expect(result.status).toBe('complete');
    expect(result.branch).toBe('main');
    expect(result.files.map((f) => f.path)).toEqual([
      'openapi.yaml',
      'package.json',
      'src/server.ts',
    ]);
    expect(budget.requests).toBe(5);
    expect(gh.calls.every((u) => u.startsWith('https://api.github.com/repos/acme/api'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it.each([
    [404, {}, 'repository_inaccessible'],
    [403, {}, 'repository_inaccessible'],
    [401, {}, 'token_invalid'],
    [429, {}, 'rate_limited'],
    [403, { 'x-ratelimit-remaining': '0' }, 'rate_limited'],
    [502, {}, 'github_error'],
  ])('repository metadata %i → unavailable (%s)', async (status, headers, code) => {
    const gh = fakeGithub(FILES, {
      extra: (url) =>
        url.endsWith('/repos/acme/api') ? new Response('{}', { status, headers }) : undefined,
    });
    const budget = new ScanBudget(50);
    const result = await new RepositoryScanner(TOKEN, budget, gh.fetchImpl).scan('acme', 'api', 24);
    expect(result.status).toBe('unavailable');
    expect([...result.issues.keys()]).toEqual([code]);
    // A rate limit or revoked token halts every further request of the analysis.
    expect(budget.take()).toBe(!(code === 'rate_limited' || code === 'token_invalid'));
  });

  it('rate limit mid-scan stops reading and reports a partial scan', async () => {
    let blobs = 0;
    const gh = fakeGithub(FILES, {
      extra: (url) =>
        url.includes('/git/blobs/') && ++blobs >= 1
          ? new Response('{}', { status: 429 })
          : undefined,
    });
    const budget = new ScanBudget(50);
    const result = await new RepositoryScanner(TOKEN, budget, gh.fetchImpl).scan('acme', 'api', 24);
    expect(result.status).toBe('partial');
    expect(result.issues.get('rate_limited')).toBeGreaterThan(0);
    expect(budget.halted).toBe('rate_limited');
  });

  it('truncated trees are reported and the root listing is merged', async () => {
    const gh = fakeGithub(FILES, { truncated: true });
    const result = await new RepositoryScanner(TOKEN, new ScanBudget(50), gh.fetchImpl).scan(
      'acme',
      'api',
      24,
    );
    expect(result.status).toBe('partial');
    expect(result.issues.get('tree_truncated')).toBe(1);
    expect(gh.calls.some((u) => u.endsWith('/git/trees/HEAD'))).toBe(true);
  });

  it('size, file, request and byte budgets are enforced and reported', async () => {
    const big = { ...FILES, 'src/huge.ts': 'x'.repeat(600_000) };
    const sized = await new RepositoryScanner(
      TOKEN,
      new ScanBudget(50),
      fakeGithub(big).fetchImpl,
    ).scan('acme', 'api', 24);
    expect(sized.issues.get('file_too_large')).toBe(1);
    expect(sized.files.some((f) => f.path === 'src/huge.ts')).toBe(false);

    const capped = await new RepositoryScanner(
      TOKEN,
      new ScanBudget(50),
      fakeGithub(FILES).fetchImpl,
    ).scan('acme', 'api', 1);
    expect(capped.files).toHaveLength(1);
    expect(capped.issues.get('file_budget_reached')).toBe(2);

    const requests = await new RepositoryScanner(
      TOKEN,
      new ScanBudget(3),
      fakeGithub(FILES).fetchImpl,
    ).scan('acme', 'api', 24);
    expect(requests.issues.get('request_budget_reached')).toBeGreaterThan(0);
    expect(requests.status).toBe('partial');

    const bytes = await new RepositoryScanner(
      TOKEN,
      new ScanBudget(50, 20),
      fakeGithub(FILES).fetchImpl,
    ).scan('acme', 'api', 24);
    expect(bytes.issues.get('byte_budget_reached')).toBeGreaterThan(0);
  });

  it('unreadable files are counted, never silently ignored; unsafe SHAs are never requested', async () => {
    const gh = fakeGithub(FILES, {
      extra: (url) => {
        if (url.endsWith('/git/trees/HEAD?recursive=1')) {
          return Response.json({
            tree: [
              { path: 'package.json', type: 'blob', size: 10, sha: sha(999) },
              { path: 'README.md', type: 'blob', size: 10, sha: '../../evil' },
            ],
          });
        }
        return undefined;
      },
    });
    const result = await new RepositoryScanner(TOKEN, new ScanBudget(50), gh.fetchImpl).scan(
      'acme',
      'api',
      24,
    );
    expect(result.issues.get('file_unreadable')).toBe(1);
    expect(result.status).toBe('partial');
    expect(gh.calls.some((u) => u.includes('evil'))).toBe(false);
  });

  it('classifies GitHub responses', () => {
    expect(classifyGithubResponse(403, new Headers({ 'retry-after': '60' }))).toBe('rate_limited');
    expect(classifyGithubResponse(500, new Headers())).toBe('github_error');
  });
});
