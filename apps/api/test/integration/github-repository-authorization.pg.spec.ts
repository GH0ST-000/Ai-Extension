/**
 * H1 — the workspace GitHub App token never grants a Project X user more than their own GitHub
 * account allows. Real PostgreSQL (workspaces, memberships, installations), real services
 * (access resolution, comment / review / patch / content / diff services, contract-impact
 * access checks, security audit). GitHub is a local simulation (global fetch); nothing is
 * sent to github.com and no real write happens. Tokens are synthetic placeholders.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PullRequestDiffService } from '../../src/ai/pr-review/pull-request-diff.service';
import { ContractImpactService } from '../../src/contract-impact/contract-impact.service';
import { GithubAccessService } from '../../src/github-app/github-access.service';
import { GithubContentService } from '../../src/github/github-content.service';
import { attributionHeader } from '../../src/github/github-attribution';
import { GithubErrorNormalizer } from '../../src/github/github-error-normalizer';
import { GithubPatchService } from '../../src/github/github-patch.service';
import { GithubReviewService } from '../../src/github/github-review.service';
import { GithubWriteService } from '../../src/github/github-write.service';
import { RequestContextService } from '../../src/observability/request-context.service';
import { SecurityAuditService } from '../../src/observability/security-audit.service';
import { WorkspaceAuthorizationService } from '../../src/workspaces/workspace-authorization.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
const OWNER = 'acme';
const REPO = 'private-api';
const HEAD = 'a'.repeat(40);
const APP_TOKEN = (id: string) => `app-installation-token-${id}`;

type Permission = 'admin' | 'write' | 'read' | 'none';

describe.skipIf(!URL_ENV)(
  'GitHub repository authorization (H1, PostgreSQL, simulated GitHub)',
  () => {
    let prisma: PrismaClient;
    const ctx = new RequestContextService();
    const realFetch = globalThis.fetch;
    let run = 0;

    /** Personal tokens per user, and what each personal token may do per repository. */
    const pats = new Map<string, string>();
    /** Current GitHub logins answered by GET /user (Decision C); default from the user id; null = GitHub cannot answer. */
    const logins = new Map<string, string | null>();
    const permissions = new Map<string, Permission>(); // `${pat}|owner/repo`
    /** Repositories each App installation can see. */
    const installationRepos = new Map<string, Set<string>>();
    const calls: Array<{ method: string; path: string; auth: string; body?: string }> = [];
    /** Simulated GitHub state beyond permissions (reset per test). */
    const sim = {
      /** Public repositories (GitHub returns `private: false`); everything else is private. */
      publicRepos: new Set<string>(),
      /** The PR head repository when it differs from the base ("owner/name"). */
      headRepo: null as string | null,
      locked: false,
      /** Branches with classic protection ("owner/repo#branch"). */
      protectedBranches: new Set<string>(),
      /** Active ruleset rules per "owner/repo#branch". */
      rules: new Map<string, Array<{ type: string }>>(),
    };
    let nextId = 1000;

    function github(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = new URL(String(input));
      if (url.hostname !== 'api.github.com') throw new Error(`unexpected host ${url.hostname}`);
      const method = (init?.method ?? 'GET').toUpperCase();
      const auth = (new Headers(init?.headers).get('authorization') ?? '').replace(
        /^(Bearer|token) /,
        '',
      );
      calls.push({
        method,
        path: url.pathname,
        auth,
        ...(method !== 'GET' && typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      // GitHub's /user for a personal token: the user's CURRENT login (Decision C).
      if (url.pathname === '/user') {
        const owner = [...pats.entries()].find(([, pat]) => pat === auth)?.[0];
        if (!owner) return Promise.resolve(new Response('{}', { status: 401 }));
        const login = logins.has(owner) ? logins.get(owner) : `gh-${owner.slice(-8)}`;
        return Promise.resolve(
          login === null ? new Response('{}', { status: 502 }) : Response.json({ login }),
        );
      }
      const m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
      if (!m) return Promise.resolve(new Response('{}', { status: 404 }));
      const repoKey = `${m[1]}/${m[2]}`.toLowerCase();
      const rest = m[3] ?? '';
      const appId = [...installationRepos.keys()].find((id) => APP_TOKEN(id) === auth);
      const visible = appId
        ? installationRepos.get(appId)!.has(repoKey)
        : (permissions.get(`${auth}|${repoKey}`) ?? 'none') !== 'none';
      if (!visible) return Promise.resolve(new Response('{}', { status: 404 }));
      const p = permissions.get(`${auth}|${repoKey}`) ?? 'none';
      if (rest === '') {
        return Promise.resolve(
          Response.json({
            full_name: repoKey,
            private: !sim.publicRepos.has(repoKey),
            visibility: sim.publicRepos.has(repoKey) ? 'public' : 'private',
            permissions: appId
              ? undefined
              : { admin: p === 'admin', push: p === 'admin' || p === 'write', pull: true },
          }),
        );
      }
      if (/^\/pulls\/\d+$/.test(rest)) {
        const repo = { name: REPO, full_name: repoKey, owner: { login: OWNER } };
        const [headOwner, headName] = (sim.headRepo ?? `${OWNER}/${REPO}`).split('/');
        const headRepo = {
          name: headName,
          full_name: sim.headRepo ?? repoKey,
          owner: { login: headOwner },
        };
        return Promise.resolve(
          Response.json({
            state: 'open',
            merged: false,
            locked: sim.locked,
            head: { sha: HEAD, ref: 'feature', repo: headRepo },
            base: { sha: 'b'.repeat(40), ref: 'main', repo },
          }),
        );
      }
      const branch = rest.match(/^\/(?:rules\/)?branches\/(.+)$/);
      if (branch && method === 'GET') {
        const key = `${repoKey}#${decodeURIComponent(branch[1]!)}`;
        return Promise.resolve(
          rest.startsWith('/rules/')
            ? Response.json(sim.rules.get(key) ?? [])
            : Response.json({ name: branch[1], protected: sim.protectedBranches.has(key) }),
        );
      }
      if (/^\/pulls\/\d+\/files$/.test(rest)) {
        return Promise.resolve(
          Response.json([
            { filename: 'src/a.ts', status: 'modified', changes: 2, patch: '@@ -1 +1 @@\n-a\n+b' },
          ]),
        );
      }
      if (/^\/issues\/\d+\/comments$/.test(rest) && method === 'POST') {
        return Promise.resolve(
          Response.json({ id: nextId++, html_url: 'https://github.com/x' }, { status: 201 }),
        );
      }
      if (/^\/pulls\/\d+\/reviews$/.test(rest) && method === 'POST') {
        return Promise.resolve(
          Response.json({ id: nextId++, html_url: 'https://github.com/x', state: 'COMMENTED' }),
        );
      }
      if (rest.startsWith('/contents/') && method === 'GET') {
        return Promise.resolve(
          Response.json({
            sha: 'c'.repeat(40),
            encoding: 'base64',
            content: Buffer.from('old\n').toString('base64'),
          }),
        );
      }
      if (rest.startsWith('/contents/') && method === 'PUT') {
        return Promise.resolve(
          Response.json(
            { commit: { sha: 'd'.repeat(40), html_url: 'https://github.com/x' } },
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }

    // ── services wired as in production (doubles only for GitHub, Redis and the App) ─────────
    const redisData = new Map<string, string>();
    const redis = {
      status: 'ready',
      connect: async () => undefined,
      get: async (k: string) => redisData.get(k) ?? null,
      set: async (k: string, v: string, ...args: unknown[]) => {
        if (args.includes('NX') && redisData.has(k)) return null;
        redisData.set(k, v);
        return 'OK';
      },
      del: async (k: string) => (redisData.delete(k) ? 1 : 0),
      // The owned-lock scripts of the review service: extend / release only with our token.
      eval: async (script: string, _keys: number, k: string, token: string) => {
        if (redisData.get(k) !== token) return 0;
        if (script.includes("'DEL'")) redisData.delete(k);
        return 1;
      },
    };
    const audit = new SecurityAuditService(
      { get: (k: string) => (k === 'nodeEnv' ? 'test' : 'test') } as never,
      ctx,
    );
    let access: GithubAccessService;
    let comments: GithubWriteService;
    let reviews: GithubReviewService;
    let patches: GithubPatchService;
    let content: GithubContentService;

    beforeAll(async () => {
      const url = new URL(URL_ENV!);
      if (!url.pathname.endsWith('_it') || url.port === '5432') {
        throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
      }
      prisma = new PrismaClient({ datasourceUrl: URL_ENV });
      await prisma.$connect();
      globalThis.fetch = github as typeof fetch;
      access = new GithubAccessService(
        prisma as never,
        ctx,
        {
          isAppAuthEnabled: () => true,
          mintInstallationAccessToken: async (id: string) => APP_TOKEN(id),
        } as never,
        {
          // Same rule as production: only an ACTIVE installation linked to this workspace.
          getActiveInstallationId: async (workspaceId: string) => {
            const row = await prisma.gitHubAppInstallation.findUnique({ where: { workspaceId } });
            return row?.status === 'active' ? row.installationId : null;
          },
        } as never,
        {
          getDecryptedToken: async (userId: string) => pats.get(userId) ?? null,
          getConnectionVersion: async (userId: string) =>
            pats.has(userId) ? `conn:${userId}` : null,
        } as never,
      );
      const errors = new GithubErrorNormalizer();
      comments = new GithubWriteService(access, redis as never, errors, audit);
      reviews = new GithubReviewService(access, redis as never, errors, audit);
      patches = new GithubPatchService(access, redis as never, errors, audit);
      content = new GithubContentService(access, errors);
    });
    afterAll(async () => {
      globalThis.fetch = realFetch;
      await prisma?.$disconnect();
    });
    beforeEach(() => {
      calls.length = 0;
      redisData.clear();
      sim.publicRepos.clear();
      sim.headRepo = null;
      sim.locked = false;
      sim.protectedBranches.clear();
      sim.rules.clear();
      logins.clear();
    });

    /** A workspace with the App installed on `acme/private-api` and members of each role. */
    async function workspace(opts: { app?: boolean } = {}) {
      run += 1;
      const ws = `ws_h1_${run}_${Date.now()}`;
      await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      const users: Record<'owner' | 'admin' | 'member', string> = {} as never;
      for (const role of ['owner', 'admin', 'member'] as const) {
        const id = `h1_${role}_${run}_${Date.now()}`;
        await prisma.user.create({
          data: { id, email: `${id}@it.test`, passwordHash: 'x', lastWorkspaceId: ws },
        });
        await prisma.workspaceMembership.create({
          data: { workspaceId: ws, userId: id, role, status: 'active' },
        });
        users[role] = id;
      }
      const installationId = `${run}${Date.now()}`;
      if (opts.app !== false) {
        await prisma.gitHubAppInstallation.create({
          data: {
            workspaceId: ws,
            installationId,
            accountLogin: OWNER,
            accountType: 'Organization',
            status: 'active',
          },
        });
        installationRepos.set(installationId, new Set([`${OWNER}/${REPO}`]));
      }
      return { ws, installationId, ...users };
    }
    /** Give `user` a personal token with `permission` on acme/private-api. */
    function grant(user: string, permission: Permission, repo = `${OWNER}/${REPO}`) {
      const pat = pats.get(user) ?? `personal-token-${user}`;
      pats.set(user, pat);
      permissions.set(`${pat}|${repo}`, permission);
    }
    const as = <T>(ws: string, fn: () => Promise<T>) =>
      ctx.run({ workspaceId: ws, requestId: `r${Math.random()}` } as never, fn);
    const writes = () => calls.filter((c) => c.method !== 'GET');
    const auditLog = () => audit.exportNdjson({ limit: 5000 });

    const comment = (ws: string, user: string, key = `k${Math.random()}`) =>
      as(ws, () =>
        comments.postPullRequestComment(user, {
          owner: OWNER,
          repository: REPO,
          pullRequestNumber: 7,
          body: 'Looks good',
          idempotencyKey: key,
        } as never),
      );
    const review = (ws: string, user: string, event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE') =>
      as(ws, () =>
        reviews.submitPullRequestReview(user, OWNER, REPO, 7, {
          event,
          body: 'Review body',
          comments: [],
          clientRequestId: `c${Math.random()}`,
        } as never),
      );
    const prepare = (ws: string, user: string) =>
      as(ws, () =>
        patches.preparePullRequestPatch(user, OWNER, REPO, 7, {
          path: 'src/a.ts',
          newContent: 'new\n',
          commitMessage: 'fix',
        } as never),
      );
    const codeOf = (e: unknown) =>
      (e as { getResponse?: () => { code?: string } }).getResponse?.().code;

    // ── reads ────────────────────────────────────────────────────────────────────────────────

    it('members with their own read access can read; the check uses THEIR token, the read uses the App', async () => {
      const w = await workspace();
      grant(w.member, 'read');
      const text = await as(w.ws, () =>
        content.fetchRepositoryFileAtRef(w.member, OWNER, REPO, 'src/a.ts', HEAD),
      );
      expect(text).toBe('old\n');
      const check = calls.find((c) => c.path === `/repos/${OWNER}/${REPO}`)!;
      expect(check.auth).toBe(pats.get(w.member));
      expect(
        calls
          .filter((c) => c.path.includes('/contents/'))
          .every((c) => c.auth === APP_TOKEN(w.installationId)),
      ).toBe(true);
    });

    it('a member without access to the private repository is refused; the App token is never used', async () => {
      const w = await workspace();
      grant(w.member, 'none');
      await expect(comment(w.ws, w.member)).rejects.toSatisfy(
        (e) => codeOf(e) === 'REPOSITORY_NOT_ACCESSIBLE',
      );
      await expect(prepare(w.ws, w.member)).rejects.toSatisfy(
        (e) => codeOf(e) === 'REPOSITORY_NOT_ACCESSIBLE',
      );
      expect(writes()).toEqual([]);
      expect(calls.some((c) => c.auth === APP_TOKEN(w.installationId))).toBe(false);
    });

    it('no personal token (App only): identity required, nothing read or written', async () => {
      const w = await workspace();
      pats.delete(w.member);
      const error = await comment(w.ws, w.member).catch((e: unknown) => e);
      expect(codeOf(error)).toBe('NOT_CONNECTED');
      expect(JSON.stringify((error as { getResponse(): unknown }).getResponse())).toContain(
        'Connect your own GitHub token',
      );
      expect(calls).toEqual([]);
    });

    // ── writes ───────────────────────────────────────────────────────────────────────────────

    it('owner, admin and read-only member can comment (GitHub lets readers comment); audit attributes each', async () => {
      const w = await workspace();
      grant(w.owner, 'admin');
      grant(w.admin, 'write');
      grant(w.member, 'read');
      for (const user of [w.owner, w.admin, w.member]) {
        const result = await comment(w.ws, user);
        expect(result.deduplicated).toBe(false);
      }
      const events = auditLog()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((e) => e.workspaceId === w.ws);
      const success = events.filter(
        (e) => e.type === 'github.write.comment' && e.outcome === 'success',
      );
      expect(success).toHaveLength(3);
      expect(new Set(success.map((e) => e.actorUserIdHash)).size).toBe(3);
      expect(success[0].detail).toContain(`repo=${OWNER}/${REPO}`);
      expect(success[0].detail).toContain('credential=installation');
    });

    it('reviews: COMMENT needs read; REQUEST_CHANGES needs write; APPROVE via the App is refused for everyone', async () => {
      const w = await workspace();
      grant(w.member, 'read');
      grant(w.owner, 'admin');
      await expect(review(w.ws, w.member, 'COMMENT')).resolves.toMatchObject({
        deduplicated: false,
      });
      await expect(review(w.ws, w.member, 'REQUEST_CHANGES')).rejects.toSatisfy(
        (e) => codeOf(e) === 'INSUFFICIENT_PERMISSION',
      );
      await expect(review(w.ws, w.owner, 'REQUEST_CHANGES')).resolves.toMatchObject({
        deduplicated: false,
      });
      calls.length = 0;
      await expect(review(w.ws, w.owner, 'APPROVE')).rejects.toSatisfy(
        (e) => codeOf(e) === 'REVIEW_ACTION_NOT_ALLOWED',
      );
      expect(writes()).toEqual([]); // nothing was posted
    });

    it('APPROVE with the user own token (no App) is still the user acting as themselves', async () => {
      const w = await workspace({ app: false });
      grant(w.owner, 'admin');
      await expect(review(w.ws, w.owner, 'APPROVE')).resolves.toMatchObject({
        deduplicated: false,
      });
      expect(writes()[0]!.auth).toBe(pats.get(w.owner)); // the user's token, not a bot
    });

    it('patch: writers can prepare and apply; read-only members cannot; SHA checks stay in place', async () => {
      const w = await workspace();
      grant(w.admin, 'write');
      grant(w.member, 'read');
      await expect(prepare(w.ws, w.member)).rejects.toSatisfy(
        (e) => codeOf(e) === 'INSUFFICIENT_PERMISSION',
      );
      const prepared = await prepare(w.ws, w.admin);
      const applied = await as(w.ws, () =>
        patches.applyPullRequestPatch(w.admin, OWNER, REPO, 7, {
          preparedPatchId: prepared.preparedPatchId,
          commitMessage: 'fix',
          clientRequestId: `p${Math.random()}`,
        } as never),
      );
      expect(applied).toMatchObject({ success: true, commitSha: 'd'.repeat(40) });
      const put = writes().find((c) => c.method === 'PUT')!;
      expect(put.auth).toBe(APP_TOKEN(w.installationId));
      const patchAudit = auditLog()
        .split('\n')
        .filter((l) => l.includes('github.write.patch') && l.includes(w.ws));
      expect(patchAudit).toHaveLength(1);
    });

    it('revoked GitHub access is refused on the next request (no stale permission)', async () => {
      const w = await workspace();
      grant(w.member, 'read');
      await expect(comment(w.ws, w.member)).resolves.toBeTruthy();
      grant(w.member, 'none'); // removed from the repository on GitHub
      await expect(comment(w.ws, w.member)).rejects.toSatisfy(
        (e) => codeOf(e) === 'REPOSITORY_NOT_ACCESSIBLE',
      );
    });

    it('removed members and deleted / pending-deletion workspaces are refused before any GitHub call', async () => {
      const w = await workspace();
      grant(w.member, 'admin');
      await prisma.workspaceMembership.updateMany({
        where: { workspaceId: w.ws, userId: w.member },
        data: { status: 'removed' },
      });
      await expect(comment(w.ws, w.member)).rejects.toMatchObject({ status: 403 });
      grant(w.owner, 'admin');
      for (const status of ['deletion_pending', 'deleted']) {
        await prisma.workspace.update({ where: { id: w.ws }, data: { status } });
        await expect(comment(w.ws, w.owner)).rejects.toMatchObject({ status: 403 });
      }
      expect(calls).toEqual([]);
    });

    it('another workspace never gets this workspace installation; a repository outside the installation fails', async () => {
      const a = await workspace();
      const b = await workspace({ app: false });
      grant(b.owner, 'admin');
      await comment(b.ws, b.owner);
      // (B's own legitimate write above used B's personal token.)
      expect(calls.some((c) => c.auth === APP_TOKEN(a.installationId))).toBe(false);
      calls.length = 0;
      // A repository the user can access but the App installation cannot.
      grant(a.owner, 'admin', `${OWNER}/other-repo`);
      await expect(
        as(a.ws, () =>
          comments.postPullRequestComment(a.owner, {
            owner: OWNER,
            repository: 'other-repo',
            pullRequestNumber: 7,
            body: 'x',
            idempotencyKey: 'k-other',
          } as never),
        ),
      ).rejects.toBeTruthy();
      expect(writes()).toEqual([]);
    });

    it('idempotent retries write once and audit once; audit never contains credentials or bodies', async () => {
      const w = await workspace();
      grant(w.owner, 'admin');
      await comment(w.ws, w.owner, 'same-key');
      const again = await comment(w.ws, w.owner, 'same-key');
      expect(again.deduplicated).toBe(true);
      expect(writes()).toHaveLength(1);
      const log = auditLog();
      const mine = log
        .split('\n')
        .filter((l) => l.includes(w.ws) && l.includes('github.write.comment'));
      expect(mine).toHaveLength(1);
      expect(log).not.toContain(pats.get(w.owner)!);
      expect(log).not.toContain(APP_TOKEN(w.installationId));
      expect(log).not.toContain('Looks good'); // no comment body
      expect(log).not.toContain(w.owner); // user referenced by HMAC only
    });

    it('refusals are audited with safe metadata', async () => {
      const w = await workspace();
      grant(w.member, 'none');
      await comment(w.ws, w.member).catch(() => undefined);
      const denied = auditLog()
        .split('\n')
        .filter((l) => l.includes(w.ws) && l.includes('github.write.denied'));
      expect(denied).toHaveLength(1);
      expect(denied[0]).toContain('REPOSITORY_NOT_ACCESSIBLE');
      expect(denied[0]).not.toContain(pats.get(w.member)!);
    });

    // ── PR review diff and downstream impact ────────────────────────────────────────────────

    it('PR diff: authorized users load it through the App; others fall back to the page excerpt', async () => {
      const w = await workspace();
      grant(w.owner, 'read');
      grant(w.member, 'none');
      const diff = new PullRequestDiffService(access);
      const pageFiles = [{ path: 'a.ts', patchExcerpt: '@@ -1 +1 @@\n-a\n+b' }];
      const denied = await as(w.ws, () =>
        diff.resolve({
          userId: w.member,
          workspaceId: w.ws,
          owner: OWNER,
          repository: REPO,
          pullRequestNumber: 7,
          pageFiles,
        } as never),
      );
      expect(denied.source).toBe('page');
      expect(calls.some((c) => c.auth === APP_TOKEN(w.installationId))).toBe(false);

      const allowed = await as(w.ws, () =>
        diff.resolve({
          userId: w.owner,
          workspaceId: w.ws,
          owner: OWNER,
          repository: REPO,
          pullRequestNumber: 7,
          pageFiles,
        } as never),
      );
      expect(allowed.source).toBe('github_api');
      expect(allowed.files.map((f) => f.path)).toEqual(['src/a.ts']);
      expect(
        calls
          .filter((c) => c.path.includes('/pulls/7'))
          .every((c) => c.auth === APP_TOKEN(w.installationId)),
      ).toBe(true);
    });

    it('downstream-impact consumer visibility uses the user own token, never the App token', async () => {
      const w = await workspace();
      grant(w.owner, 'read', `${OWNER}/consumer`);
      installationRepos.get(w.installationId)!.add(`${OWNER}/hidden-consumer`);
      const impact = new ContractImpactService(
        prisma as never,
        access,
        new WorkspaceAuthorizationService(prisma as never),
      );
      const { access: verdicts } = await as(w.ws, () =>
        impact.verifyAccess(w.owner, [
          { provider: 'github', owner: OWNER, repository: 'consumer' },
          { provider: 'github', owner: OWNER, repository: 'hidden-consumer' },
        ]),
      );
      expect(verdicts.get(`github:${OWNER}/consumer`)).toBe('allowed');
      // The App can see it, the user cannot: hidden.
      expect(verdicts.get(`github:${OWNER}/hidden-consumer`)).toBe('denied');
      expect(calls.every((c) => c.auth === pats.get(w.owner))).toBe(true);
    });

    // ── N-8 / N-16 / N-17 (final audit) ─────────────────────────────────────────────────────

    const FORK = 'acme/private-api-fork';
    const apply = (ws: string, user: string, preparedPatchId: string) =>
      as(ws, () =>
        patches.applyPullRequestPatch(user, OWNER, REPO, 7, {
          preparedPatchId,
          commitMessage: 'fix',
          clientRequestId: `a${Math.random()}`,
        } as never),
      );
    const commitsTo = () =>
      calls.filter((c) => c.method === 'PUT').map((c) => c.path.split('/contents/')[0]);

    it('N-8: base equals head — write on the repository is enough; the commit goes there', async () => {
      const w = await workspace();
      grant(w.member, 'write');
      const prepared = await prepare(w.ws, w.member);
      await apply(w.ws, w.member, prepared.preparedPatchId);
      expect(commitsTo()).toEqual([`/repos/${OWNER}/${REPO}`]);
    });

    it('N-8: write on base but NOT on the head repository → refused before any read of the head', async () => {
      const w = await workspace();
      installationRepos.get(w.installationId)!.add(FORK); // the App covers both
      sim.headRepo = FORK;
      grant(w.member, 'write'); // base
      grant(w.member, 'read', FORK); // head: read only
      await expect(prepare(w.ws, w.member)).rejects.toSatisfy(
        (e) => codeOf(e) === 'INSUFFICIENT_PERMISSION',
      );
      expect(calls.some((c) => c.path.startsWith(`/repos/${FORK}/contents`))).toBe(false);
      expect(writes()).toEqual([]);
    });

    it('N-8: write on head but not on base → refused (the base requirement is kept)', async () => {
      const w = await workspace();
      installationRepos.get(w.installationId)!.add(FORK);
      sim.headRepo = FORK;
      grant(w.member, 'read'); // base
      grant(w.member, 'write', FORK);
      await expect(prepare(w.ws, w.member)).rejects.toSatisfy(
        (e) => codeOf(e) === 'INSUFFICIENT_PERMISSION',
      );
      expect(writes()).toEqual([]);
    });

    it('N-8: head repository outside the App installation and not readable → refused', async () => {
      const w = await workspace();
      sim.headRepo = FORK;
      grant(w.member, 'write');
      await expect(prepare(w.ws, w.member)).rejects.toSatisfy(
        (e) => codeOf(e) === 'REPOSITORY_NOT_ACCESSIBLE',
      );
      expect(writes()).toEqual([]);
    });

    it('N-8: write on both → the commit targets the HEAD repository; revoking head access between prepare and apply blocks the write', async () => {
      const w = await workspace();
      installationRepos.get(w.installationId)!.add(FORK);
      sim.headRepo = FORK;
      grant(w.member, 'write');
      grant(w.member, 'write', FORK);
      const first = await prepare(w.ws, w.member);
      await apply(w.ws, w.member, first.preparedPatchId);
      expect(commitsTo()).toEqual([`/repos/${FORK}`]);

      calls.length = 0;
      const second = await prepare(w.ws, w.member);
      grant(w.member, 'read', FORK); // revoked on GitHub
      await expect(apply(w.ws, w.member, second.preparedPatchId)).rejects.toSatisfy(
        (e) => codeOf(e) === 'INSUFFICIENT_PERMISSION',
      );
      expect(writes()).toEqual([]);
    });

    it('N-16: protected head branch or a push-restricting ruleset → the App path refuses; benign rules are allowed', async () => {
      const w = await workspace();
      grant(w.member, 'write');
      sim.protectedBranches.add(`${OWNER}/${REPO}#feature`);
      await expect(prepare(w.ws, w.member)).rejects.toSatisfy(
        (e) => codeOf(e) === 'BRANCH_PROTECTED',
      );
      sim.protectedBranches.clear();
      sim.rules.set(`${OWNER}/${REPO}#feature`, [{ type: 'required_signatures' }]);
      await expect(prepare(w.ws, w.member)).rejects.toSatisfy(
        (e) => codeOf(e) === 'BRANCH_PROTECTED',
      );
      sim.rules.set(`${OWNER}/${REPO}#feature`, [{ type: 'some_future_rule' }]); // unknown → refuse
      await expect(prepare(w.ws, w.member)).rejects.toSatisfy(
        (e) => codeOf(e) === 'BRANCH_PROTECTED',
      );
      sim.rules.set(`${OWNER}/${REPO}#feature`, [
        { type: 'non_fast_forward' },
        { type: 'deletion' },
      ]);
      await expect(prepare(w.ws, w.member)).resolves.toMatchObject({
        preparedPatchId: expect.any(String),
      });
      expect(writes()).toEqual([]);
    });

    it('N-17: through the App, a read-only user cannot comment on a PUBLIC repository or a LOCKED conversation', async () => {
      const w = await workspace();
      grant(w.member, 'read');
      grant(w.admin, 'write');
      sim.publicRepos.add(`${OWNER}/${REPO}`);
      await expect(comment(w.ws, w.member)).rejects.toSatisfy(
        (e) => codeOf(e) === 'INSUFFICIENT_PERMISSION',
      );
      await expect(review(w.ws, w.member, 'COMMENT')).rejects.toSatisfy(
        (e) => codeOf(e) === 'INSUFFICIENT_PERMISSION',
      );
      sim.publicRepos.clear();
      sim.locked = true;
      await expect(comment(w.ws, w.member)).rejects.toSatisfy(
        (e) => codeOf(e) === 'INSUFFICIENT_PERMISSION',
      );
      await expect(review(w.ws, w.member, 'COMMENT')).rejects.toSatisfy(
        (e) => codeOf(e) === 'INSUFFICIENT_PERMISSION',
      );
      expect(writes()).toEqual([]);
      // Collaborators with write still can, in both cases.
      await expect(comment(w.ws, w.admin)).resolves.toMatchObject({ deduplicated: false });
      sim.locked = false;
      sim.publicRepos.add(`${OWNER}/${REPO}`);
      await expect(comment(w.ws, w.admin)).resolves.toMatchObject({ deduplicated: false });
    });

    it('N-18: write and refusal audit events are durable (database) and carry no secrets', async () => {
      const w = await workspace();
      grant(w.member, 'read');
      grant(w.admin, 'none');
      const durable = new SecurityAuditService(
        { get: (k: string) => (k === 'nodeEnv' ? 'test' : 'test') } as never,
        ctx,
        prisma as never,
      );
      const durableComments = new GithubWriteService(
        access,
        redis as never,
        new GithubErrorNormalizer(),
        durable,
      );
      const post = (user: string) =>
        as(w.ws, () =>
          durableComments.postPullRequestComment(user, {
            owner: OWNER,
            repository: REPO,
            pullRequestNumber: 7,
            body: 'Secret-looking body ghp_should_never_be_audited',
            idempotencyKey: `k${Math.random()}`,
          } as never),
        );
      await post(w.member);
      await post(w.admin).catch(() => undefined);
      // Persistence is asynchronous; poll briefly.
      let rows: Array<{ type: string; outcome: string; detail: string | null }> = [];
      for (let i = 0; i < 50 && rows.length < 2; i += 1) {
        rows = await prisma.securityAuditEventRecord.findMany({ where: { workspaceId: w.ws } });
        if (rows.length < 2) await new Promise((r) => setTimeout(r, 20));
      }
      expect(rows.map((r) => `${r.type}:${r.outcome}`).sort()).toEqual([
        'github.write.comment:success',
        'github.write.denied:blocked',
      ]);
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain('ghp_');
      expect(serialized).not.toContain('Secret-looking body');
      expect(serialized).not.toContain(pats.get(w.member)!);
      expect(serialized).not.toContain('@it.test');
    });

    // ── Decision C: attribution of App-posted writes ──────────────────────────────────────────

    const postedBody = (pathPart: string) => {
      const write = calls.find((c) => c.method === 'POST' && c.path.includes(pathPart));
      return JSON.parse(write!.body!).body as string;
    };

    it('Decision C: an App comment names the VERIFIED login of the requester; content preserved', async () => {
      const w = await workspace();
      grant(w.member, 'read');
      logins.set(w.member, 'mona-lisa');
      await comment(w.ws, w.member);
      const body = postedBody('/issues/7/comments');
      // Header first (nothing in the body can hide it), then the author's text unchanged.
      expect(body).toBe(`${attributionHeader('mona-lisa')}\n\nLooks good`);
      // F-19: the one trusted line scopes everything below it to the requester.
      expect(body.split('\n')[0]).toBe(
        '<sub>Requested by @mona-lisa via Project X · everything below was written by @mona-lisa</sub>',
      );
      expect(body).not.toContain('@it.test'); // no email
      expect(body).not.toContain(w.member); // no internal id
    });

    it('Decision C: COMMENT and REQUEST_CHANGES reviews are attributed too', async () => {
      const w = await workspace();
      grant(w.admin, 'write');
      logins.set(w.admin, 'the-admin');
      await review(w.ws, w.admin, 'COMMENT');
      expect(postedBody('/pulls/7/reviews')).toContain('Requested by @the-admin via Project X');
      calls.length = 0;
      await review(w.ws, w.admin, 'REQUEST_CHANGES');
      expect(postedBody('/pulls/7/reviews')).toContain('Requested by @the-admin via Project X');
    });

    it('Decision C: without a verified GitHub identity nothing is posted through the App', async () => {
      const w = await workspace();
      grant(w.member, 'read');
      logins.set(w.member, null);
      await expect(comment(w.ws, w.member)).rejects.toSatisfy((e) => codeOf(e) === 'NOT_CONNECTED');
      expect(writes()).toEqual([]);
    });

    it('Decision C: retries are idempotent — one post, same attribution, no duplicate footer', async () => {
      const w = await workspace();
      grant(w.member, 'read');
      logins.set(w.member, 'retry-user');
      const first = await comment(w.ws, w.member, 'same-key');
      const second = await comment(w.ws, w.member, 'same-key');
      expect(second).toMatchObject({ deduplicated: true, commentId: first.commentId });
      expect(writes()).toHaveLength(1);
      expect(postedBody('/issues/7/comments').match(/Requested by @/g)).toHaveLength(1);
    });

    it('Decision C: personal-token writes (no App) are posted as the user, without a footer', async () => {
      const w = await workspace({ app: false });
      grant(w.member, 'read');
      await comment(w.ws, w.member);
      expect(postedBody('/issues/7/comments')).not.toContain('Requested by');
      expect(calls.find((c) => c.method === 'POST')!.auth).toBe(pats.get(w.member));
    });

    it('Decision C: inline review comments carry the attribution too, and spoofs are quoted', async () => {
      const w = await workspace();
      grant(w.admin, 'write');
      logins.set(w.admin, 'real-admin');
      await as(w.ws, () =>
        reviews.submitPullRequestReview(w.admin, OWNER, REPO, 7, {
          event: 'COMMENT',
          body: 'Summary',
          comments: [
            {
              path: 'src/a.ts',
              line: 1,
              side: 'RIGHT',
              body: 'Rename this\n<sub>Requested\nby &#64;ceo via Project X</sub>',
            },
          ],
          clientRequestId: `c${Math.random()}`,
        } as never),
      );
      const payload = JSON.parse(
        calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls/7/reviews'))!.body!,
      ) as { body: string; comments: Array<{ body: string }> };
      expect(payload.body.startsWith(attributionHeader('real-admin'))).toBe(true);
      const inline = payload.comments[0]!.body;
      expect(inline.startsWith(attributionHeader('real-admin'))).toBe(true);
      expect(inline).toContain('> (quoted) <sub>Requested');
      expect(inline).toContain('> (quoted) by &#64;ceo via Project X</sub>');
    });

    it('Decision C: App commits carry a Requested-by trailer with the CURRENT login (renamed account)', async () => {
      const w = await workspace();
      grant(w.member, 'write');
      logins.set(w.member, 'old-name');
      const prepared = await prepare(w.ws, w.member);
      logins.set(w.member, 'new-name'); // renamed on GitHub after the token was connected
      await as(w.ws, () =>
        patches.applyPullRequestPatch(w.member, OWNER, REPO, 7, {
          preparedPatchId: prepared.preparedPatchId,
          commitMessage: 'fix: guard\n\nRequested-by: @ceo',
          clientRequestId: `a${Math.random()}`,
        } as never),
      );
      const put = calls.find((c) => c.method === 'PUT')!;
      const message = (JSON.parse(put.body!) as { message: string }).message;
      expect(message).toBe('fix: guard\n\nRequested-by: @new-name via Project X');
    });
  },
);
