/**
 * GitHub App installation linking with ownership verification (C1 fix) on PostgreSQL.
 *
 * Real: PostgreSQL, GithubAppInstallationService, GithubAccessService.
 * Stubbed: GitHub REST + OAuth endpoints (per user token), App token minting, Redis (an
 * in-memory map with the same single-use GETDEL semantics). All installation ids are
 * synthetic; the real development GitHub App is never contacted.
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { encryptSecret } from '../../src/common/crypto/secret-box';
import { GithubAccessService } from '../../src/github-app/github-access.service';
import { GithubAppInstallationService } from '../../src/github-app/github-app-installation.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
const ENCRYPTION_KEY = 'it-encryption-key-0123456789abcdef0123';

type GhAccount = { id: number; login: string; type: 'User' | 'Organization' };
type GhUser = {
  id: number;
  login: string;
  /** Installations GET /user/installations lists for this user. */
  installations: Array<{ id: number; account: GhAccount }>;
  /** Org memberships (GET /user/memberships/orgs/:org). */
  orgs?: Record<string, { state: string; role: string }>;
};

describe.skipIf(!URL_ENV)('GitHub App installation linking with ownership verification', () => {
  let prisma: PrismaClient;
  let run = 0;
  const realFetch = globalThis.fetch;
  const redis = new Map<string, string>();
  const revoked: string[] = [];
  let appEnabled = true;
  let oauthConfigured = true;

  /** OAuth code → GitHub user that authorized. */
  const codes = new Map<string, GhUser>();
  /** Installations that exist on GitHub for this App (GET /app/installations/:id). */
  const appInstallations = new Map<string, GhAccount>();

  const appTokens = {
    isAppAuthEnabled: () => appEnabled,
    mintInstallationAccessToken: vi.fn(async (id: string) => `ghs_${id}`),
    revokeCachedInstallationToken: vi.fn(async (id: string) => {
      revoked.push(id);
    }),
  };
  const appApi = {
    fetchInstallation: vi.fn(async (id: string) => {
      const account = appInstallations.get(id);
      if (!account) throw new Error('installation not found');
      return {
        id: Number(id),
        account: { login: account.login, type: account.type },
        repository_selection: 'selected',
        permissions: { contents: 'read', metadata: 'read' },
        suspended_at: null,
      };
    }),
  };
  const config = {
    get: (key: string) =>
      ({
        'githubApp.clientId': oauthConfigured ? 'Iv1.integrationtest' : '',
        'githubApp.clientSecret': oauthConfigured ? 'integration-client-secret' : '',
        'githubApp.slug': 'project-x-it',
      })[key] ?? '',
    getOrThrow: () => ENCRYPTION_KEY,
  };
  let installations: GithubAppInstallationService;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();
    installations = new GithubAppInstallationService(
      prisma as never,
      {
        get: async (k: string) => redis.get(k) ?? null,
        set: async (k: string, v: string) => redis.set(k, v),
        del: async (k: string) => redis.delete(k),
        // Single use, like Redis GETDEL: read and delete in one step.
        getdel: async (k: string) => {
          const v = redis.get(k) ?? null;
          redis.delete(k);
          return v;
        },
      } as never,
      config as never,
      appTokens as never,
      appApi as never,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    appEnabled = true;
    oauthConfigured = true;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      if (target === 'https://github.com/login/oauth/access_token') {
        const { code } = JSON.parse(String(init?.body)) as { code: string };
        return codes.has(code)
          ? Response.json({ access_token: `gho_${code}` })
          : Response.json({ error: 'bad_verification_code' });
      }
      if (!target.startsWith('https://api.github.com/')) return realFetch(input, init);
      const token = (new Headers(init?.headers).get('authorization') ?? '').replace('Bearer ', '');
      const user = codes.get(token.replace(/^gho_/, ''));
      if (!user) return Response.json({ message: 'Bad credentials' }, { status: 401 });
      const path = new URL(target).pathname;
      if (path === '/user') return Response.json({ id: user.id, login: user.login });
      if (path === '/user/installations') {
        return Response.json({
          total_count: user.installations.length,
          installations: user.installations,
        });
      }
      const org = /^\/user\/memberships\/orgs\/(.+)$/.exec(path);
      if (org) {
        const m = user.orgs?.[decodeURIComponent(org[1]!)];
        return m ? Response.json(m) : Response.json({ message: 'Not Found' }, { status: 404 });
      }
      return Response.json({ message: 'Not Found' }, { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  const nextId = () => `${7_000_000_000 + (Date.now() % 1_000_000_000) + (run += 1)}`;
  const ghUser = (
    login: string,
    installations: GhUser['installations'] = [],
    orgs?: GhUser['orgs'],
  ) => {
    run += 1;
    return { id: 100_000 + run, login: `${login}${run}`, installations, ...(orgs ? { orgs } : {}) };
  };
  /** The user's browser completes GitHub authorization: returns the OAuth code. */
  const authorizeAs = (user: GhUser) => {
    const code = `code_${user.login}_${run}`;
    codes.set(code, user);
    return code;
  };

  async function workspaceWith(role: 'owner' | 'admin' | 'member' = 'owner') {
    run += 1;
    const tag = `${run}_${Date.now()}`;
    const ws = `ws_ghv_${tag}`;
    const user = `ghv_${role}_${tag}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.user.create({
      data: { id: user, email: `${user}@it.test`, passwordHash: 'x', lastWorkspaceId: ws },
    });
    await prisma.workspaceMembership.create({
      data: { workspaceId: ws, userId: user, role, status: 'active' },
    });
    return { ws, user };
  }

  const access = (ws: string, pat: string | null = null) =>
    new GithubAccessService(
      prisma as never,
      { get: () => ({ workspaceId: ws }) } as never,
      appTokens as never,
      installations,
      {
        getDecryptedToken: async () => pat,
      } as never,
    );
  /**
   * Whether this workspace's link yields an installation token at all (active + ownership
   * verified). Per-user repository authorization on top of it (H1) is covered by
   * github-repository-authorization.pg.spec.ts.
   */
  const tokenFor = async (w: { ws: string; user: string }) => {
    if (!appTokens.isAppAuthEnabled()) return null;
    const installationId = await installations.getActiveInstallationId(w.ws);
    return installationId
      ? {
          token: await appTokens.mintInstallationAccessToken(installationId),
          source: 'installation' as const,
        }
      : null;
  };
  const rowFor = (installationId: string) =>
    prisma.gitHubAppInstallation.findUnique({ where: { installationId } });
  const verifyStateFrom = (authorizeUrl: string) =>
    new URL(authorizeUrl).searchParams.get('state')!;

  /** Step 3 as the signed-in Project X user `w` (authenticated verify endpoint). */
  const complete = (w: { ws: string; user: string }, code: string, state: string) =>
    installations.completeOwnershipVerification({ code, state, userId: w.user, workspaceId: w.ws });

  /** Full legitimate flow: start → GitHub setup redirect → user authorization → callback. */
  async function link(w: { ws: string; user: string }, installationId: string, as: GhUser) {
    const { state } = await installations.startInstall(w.ws, w.user);
    const { authorizeUrl } = await installations.completeSetupFromCallback({
      installationId,
      state,
    });
    return complete(w, authorizeAs(as), verifyStateFrom(authorizeUrl));
  }

  function personalInstallation(owner: GhUser) {
    const id = nextId();
    const account: GhAccount = { id: owner.id, login: owner.login, type: 'User' };
    appInstallations.set(id, account);
    owner.installations.push({ id: Number(id), account });
    return id;
  }

  // ── C1: the original exploit ─────────────────────────────────────────────

  it('C1: an attacker cannot claim another account’s unlinked installation (original exploit)', async () => {
    const victim = ghUser('victim');
    const victimInstallation = personalInstallation(victim); // installed, never linked
    const attacker = await workspaceWith('owner');
    const attackerGh = ghUser('attacker');

    // Original exploit: own valid state + the victim's installation id on the Setup URL.
    const { state } = await installations.startInstall(attacker.ws, attacker.user);
    const step2 = await installations.completeSetupFromCallback({
      installationId: victimInstallation,
      state,
    });
    // The setup redirect no longer links anything…
    expect(await rowFor(victimInstallation)).toBeNull();
    expect(await tokenFor(attacker)).toBeNull();
    // …and the attacker's own GitHub authorization cannot prove ownership.
    await expect(
      complete(attacker, authorizeAs(attackerGh), verifyStateFrom(step2.authorizeUrl)),
    ).rejects.toMatchObject({ response: { code: 'GITHUB_APP_OWNERSHIP_NOT_VERIFIED' } });
    expect(await rowFor(victimInstallation)).toBeNull();
    expect(await tokenFor(attacker)).toBeNull();
    expect(appTokens.mintInstallationAccessToken).not.toHaveBeenCalledWith(victimInstallation);
  });

  it('a collaborator who can see a personal installation is not its owner', async () => {
    const owner = ghUser('owner');
    const id = personalInstallation(owner);
    const collaborator = ghUser('collab', [{ id: Number(id), account: appInstallations.get(id)! }]);
    const attacker = await workspaceWith('owner');
    await expect(link(attacker, id, collaborator)).rejects.toMatchObject({
      response: { code: 'GITHUB_APP_OWNERSHIP_NOT_VERIFIED' },
    });
    expect(await rowFor(id)).toBeNull();
  });

  it('organization installations need an active organization admin', async () => {
    const id = nextId();
    const org: GhAccount = { id: 9_000_000 + run, login: `acme-org-${run}`, type: 'Organization' };
    appInstallations.set(id, org);
    const listed = [{ id: Number(id), account: org }];
    const ws = await workspaceWith('owner');

    for (const membership of [
      { state: 'active', role: 'member' },
      { state: 'pending', role: 'admin' },
      undefined, // membership lookup refused (e.g. App lacks Members: read)
    ]) {
      const user = ghUser('orguser', listed, membership ? { [org.login]: membership } : {});
      await expect(link(ws, id, user)).rejects.toMatchObject({
        response: { code: 'GITHUB_APP_OWNERSHIP_NOT_VERIFIED' },
      });
    }
    expect(await rowFor(id)).toBeNull();

    const admin = ghUser('orgadmin', listed, { [org.login]: { state: 'active', role: 'admin' } });
    const linked = await link(ws, id, admin);
    expect(linked).toMatchObject({ connected: true, ownershipVerified: true, installationId: id });
    expect(await tokenFor(ws)).toEqual({ token: `ghs_${id}`, source: 'installation' });
  });

  // ── legitimate flows ─────────────────────────────────────────────────────

  it.each(['owner', 'admin'] as const)(
    '%s links their own installation and gets its token',
    async (role) => {
      const me = ghUser('me');
      const id = personalInstallation(me);
      const w = await workspaceWith(role);
      const linked = await link(w, id, me);
      expect(linked).toMatchObject({ connected: true, ownershipVerified: true });
      expect(await tokenFor(w)).toEqual({ token: `ghs_${id}`, source: 'installation' });
      const status = await installations.getStatusForWorkspace(w.ws);
      expect(status).toMatchObject({
        connected: true,
        ownershipVerified: true,
        installationId: id,
      });
    },
  );

  it('a role revoked between starting and completing the install blocks linking', async () => {
    const me = ghUser('me');
    const id = personalInstallation(me);
    const w = await workspaceWith('admin');
    const { state } = await installations.startInstall(w.ws, w.user);
    const { authorizeUrl } = await installations.completeSetupFromCallback({
      installationId: id,
      state,
    });
    await prisma.workspaceMembership.updateMany({
      where: { workspaceId: w.ws, userId: w.user },
      data: { role: 'member' },
    });
    await expect(complete(w, authorizeAs(me), verifyStateFrom(authorizeUrl))).rejects.toMatchObject(
      { response: { code: 'GITHUB_APP_OWNERSHIP_NOT_VERIFIED' } },
    );
    expect(await rowFor(id)).toBeNull();
  });

  // ── manipulated callbacks, expiry, replay ────────────────────────────────

  it('forged, malformed, crossed, expired and replayed states are rejected', async () => {
    const me = ghUser('me');
    const id = personalInstallation(me);
    const w = await workspaceWith('owner');

    for (const bad of [
      { installationId: id, state: 'f'.repeat(48) }, // well-formed but never issued
      { installationId: id, state: 'not-a-state' },
      { installationId: 'abc', state: 'f'.repeat(48) },
      { installationId: '-1', state: 'f'.repeat(48) },
    ]) {
      await expect(installations.completeSetupFromCallback(bad)).rejects.toThrow();
    }

    const { state } = await installations.startInstall(w.ws, w.user);
    const { authorizeUrl } = await installations.completeSetupFromCallback({
      installationId: id,
      state,
    });
    const verify = verifyStateFrom(authorizeUrl);
    // Install state is single use.
    await expect(
      installations.completeSetupFromCallback({ installationId: id, state }),
    ).rejects.toThrow(/state/i);
    // States are not interchangeable between steps.
    await expect(complete(w, authorizeAs(me), state)).rejects.toThrow(/state/i);
    // A bad OAuth code does not consume anything useful and links nothing.
    await expect(complete(w, 'forged-code', verify)).rejects.toMatchObject({
      response: { code: 'GITHUB_APP_OWNERSHIP_NOT_VERIFIED' },
    });
    // The verification state was single use: even the right user cannot reuse it.
    await expect(complete(w, authorizeAs(me), verify)).rejects.toThrow(/state/i);

    // Expired verification state (TTL elapsed → key gone).
    const s2 = (await installations.startInstall(w.ws, w.user)).state;
    const v2 = verifyStateFrom(
      (await installations.completeSetupFromCallback({ installationId: id, state: s2 }))
        .authorizeUrl,
    );
    redis.delete(`gh:app:verify-state:${v2}`);
    await expect(complete(w, authorizeAs(me), v2)).rejects.toThrow(/expired|invalid state/i);
    expect(await rowFor(id)).toBeNull();
  });

  it('the same verification state used concurrently links at most once', async () => {
    const me = ghUser('me');
    const id = personalInstallation(me);
    const w = await workspaceWith('owner');
    const { state } = await installations.startInstall(w.ws, w.user);
    const verify = verifyStateFrom(
      (await installations.completeSetupFromCallback({ installationId: id, state })).authorizeUrl,
    );
    const results = await Promise.allSettled([
      complete(w, authorizeAs(me), verify),
      complete(w, authorizeAs(me), verify),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  // ── login CSRF / confused deputy ─────────────────────────────────────────

  it('the real owner’s GitHub authorization cannot complete an attacker’s pending link (phishing)', async () => {
    const victimGh = ghUser('victim');
    const id = personalInstallation(victimGh);
    const attacker = await workspaceWith('owner');
    const victim = await workspaceWith('owner'); // the victim's own Project X account
    // Attacker prepares a pending verification for the victim's installation…
    const { state } = await installations.startInstall(attacker.ws, attacker.user);
    const verify = verifyStateFrom(
      (await installations.completeSetupFromCallback({ installationId: id, state })).authorizeUrl,
    );
    // …and tricks the victim into authorizing: the victim's browser completes it while signed
    // in as themselves. Ownership is genuine, but the flow is not theirs → refused.
    await expect(complete(victim, authorizeAs(victimGh), verify)).rejects.toMatchObject({
      response: { code: 'GITHUB_APP_OWNERSHIP_NOT_VERIFIED' },
    });
    // The attacker cannot finish it either (state consumed; and their GitHub user is not the owner).
    await expect(complete(attacker, authorizeAs(victimGh), verify)).rejects.toThrow();
    expect(await rowFor(id)).toBeNull();
    expect(await tokenFor(attacker)).toBeNull();
  });

  it('the same user cannot complete a verification in a different workspace', async () => {
    const me = ghUser('me');
    const id = personalInstallation(me);
    const a = await workspaceWith('owner');
    await prisma.workspace.create({ data: { id: `${a.ws}_b`, name: 'b', slug: `${a.ws}_b` } });
    await prisma.workspaceMembership.create({
      data: { workspaceId: `${a.ws}_b`, userId: a.user, role: 'owner', status: 'active' },
    });
    const { state } = await installations.startInstall(a.ws, a.user);
    const verify = verifyStateFrom(
      (await installations.completeSetupFromCallback({ installationId: id, state })).authorizeUrl,
    );
    await expect(
      complete({ ws: `${a.ws}_b`, user: a.user }, authorizeAs(me), verify),
    ).rejects.toMatchObject({ response: { code: 'GITHUB_APP_OWNERSHIP_NOT_VERIFIED' } });
    expect(await rowFor(id)).toBeNull();
  });

  // ── cross-workspace ──────────────────────────────────────────────────────

  it('an installation linked to one workspace can never be linked to another, even by its owner', async () => {
    const me = ghUser('me');
    const id = personalInstallation(me);
    const a = await workspaceWith('owner');
    const b = await workspaceWith('owner');
    await link(a, id, me);
    await expect(link(b, id, me)).rejects.toMatchObject({
      response: { code: 'GITHUB_APP_OWNERSHIP_NOT_VERIFIED' },
    });
    expect((await rowFor(id))?.workspaceId).toBe(a.ws);
    expect(await tokenFor(b)).toBeNull();
  });

  it('two workspaces racing to link the same installation: exactly one wins', async () => {
    const me = ghUser('me');
    const id = personalInstallation(me);
    const a = await workspaceWith('owner');
    const b = await workspaceWith('owner');
    const results = await Promise.allSettled([link(a, id, me), link(b, id, me)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const row = await rowFor(id);
    const winner = row!.workspaceId === a.ws ? a : b;
    const loser = winner === a ? b : a;
    expect(await tokenFor(winner)).toMatchObject({ source: 'installation' });
    expect(await tokenFor(loser)).toBeNull();
  });

  // ── no tokens without verified ownership ─────────────────────────────────

  it('fails closed when OAuth verification is not configured', async () => {
    const me = ghUser('me');
    const id = personalInstallation(me);
    const w = await workspaceWith('owner');
    const { state } = await installations.startInstall(w.ws, w.user);
    oauthConfigured = false;
    await expect(
      installations.completeSetupFromCallback({ installationId: id, state }),
    ).rejects.toThrow(/verification is not configured/);
    expect(await rowFor(id)).toBeNull();
  });

  it('legacy unverified links (made before this fix) grant no token until re-linked', async () => {
    const w = await workspaceWith('owner');
    const id = nextId();
    appInstallations.set(id, { id: 1, login: 'legacy', type: 'User' });
    await prisma.gitHubAppInstallation.create({
      data: {
        workspaceId: w.ws,
        installationId: id,
        accountLogin: 'legacy',
        accountType: 'User',
        status: 'active',
        metadataCiphertext: encryptSecret(
          JSON.stringify({ permissions: { contents: 'read' } }),
          ENCRYPTION_KEY,
        ),
      },
    });
    expect(await tokenFor(w)).toBeNull();
    expect(await installations.getStatusForWorkspace(w.ws)).toMatchObject({
      connected: false,
      ownershipVerified: false,
    });
    // A webhook refresh never establishes ownership.
    await installations.upsertFromGitHubInstallation({
      workspaceId: w.ws,
      installation: await appApi.fetchInstallation(id),
    });
    expect(await tokenFor(w)).toBeNull();
    // A user's own personal token still works as before.
    expect(
      await access(w.ws, 'ghp_personal').resolveRepositoryAccess(w.user, {
        owner: 'acme',
        repository: 'app',
        access: 'read',
        workspaceId: w.ws,
      }),
    ).toMatchObject({ ok: true, token: 'ghp_personal', source: 'pat' });
  });

  it('webhook refresh keeps verified ownership; suspend, remove and disable revoke access', async () => {
    const me = ghUser('me');
    const id = personalInstallation(me);
    const w = await workspaceWith('owner');
    await link(w, id, me);
    await installations.upsertFromGitHubInstallation({
      workspaceId: w.ws,
      installation: await appApi.fetchInstallation(id),
    });
    expect(await tokenFor(w)).toMatchObject({ source: 'installation' });

    await installations.markInstallationSuspended(id, true);
    expect(revoked).toContain(id);
    expect(await tokenFor(w)).toBeNull();
    await installations.markInstallationSuspended(id, false);
    expect(await tokenFor(w)).toMatchObject({ source: 'installation' });

    appEnabled = false;
    expect(await tokenFor(w)).toBeNull();
    appEnabled = true;

    await installations.markInstallationRemoved(id);
    expect(await tokenFor(w)).toBeNull();
    // Adversarial N7: a (late or replayed) "unsuspend" never revives a removed installation.
    await installations.markInstallationSuspended(id, false);
    expect((await rowFor(id))?.status).toBe('removed');
    expect(await tokenFor(w)).toBeNull();
  });
  // F-18: a workspace role must not trigger an organization-wide uninstall on GitHub.
  it('[F-18] disconnecting unlinks the workspace only: no GitHub request, token revoked, access gone', async () => {
    const me = ghUser('me');
    const id = personalInstallation(me);
    const w = await workspaceWith('owner');
    await link(w, id, me);
    expect(await tokenFor(w)).toMatchObject({ source: 'installation' });

    const calls = vi.mocked(globalThis.fetch).mock.calls.length;
    await installations.disconnectWorkspace(w.ws);

    const after = vi.mocked(globalThis.fetch).mock.calls.slice(calls);
    // Nothing was sent to GitHub at all — in particular no DELETE /app/installations/{id}.
    // Compared by parsed host (a substring test would also match look-alike hosts and paths).
    const toGitHub = after.filter((c) => {
      try {
        return new URL(String(c[0])).hostname === 'api.github.com';
      } catch {
        return false;
      }
    });
    expect(toGitHub).toEqual([]);
    expect(
      vi
        .mocked(globalThis.fetch)
        .mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE'),
    ).toBe(false);
    expect((await rowFor(id))?.status).toBe('removed');
    expect(revoked).toContain(id);
    expect(await tokenFor(w)).toBeNull();
  });

  it('[F-18] the same holds for a link without a verified ownership proof and for a repeated disconnect', async () => {
    const w = await workspaceWith('owner');
    const installationId = `9${Date.now()}`;
    await prisma.gitHubAppInstallation.create({
      data: {
        workspaceId: w.ws,
        installationId,
        accountLogin: 'someone-elses-org',
        accountType: 'Organization',
        status: 'active',
      },
    });
    await installations.disconnectWorkspace(w.ws);
    await installations.disconnectWorkspace(w.ws);
    expect(
      vi.mocked(globalThis.fetch).mock.calls.filter((c) => {
        try {
          return new URL(String(c[0])).pathname.startsWith('/app/installations/');
        } catch {
          return false;
        }
      }),
    ).toEqual([]);
    expect((await rowFor(installationId))?.status).toBe('removed');
  });

  it('[F-18] after a disconnect the installation can be linked to another workspace (by a verified owner), not while it is still linked', async () => {
    const me = ghUser('me');
    const id = personalInstallation(me);
    const first = await workspaceWith('owner');
    const second = await workspaceWith('owner');
    await link(first, id, me);
    // Still linked to the first workspace: refused.
    await expect(link(second, id, me)).rejects.toThrow(/already|linked|another workspace/i);

    await installations.disconnectWorkspace(first.ws);
    await link(second, id, me);
    expect(await tokenFor(second)).toMatchObject({ source: 'installation' });
    expect(await tokenFor(first)).toBeNull();
    expect(await prisma.gitHubAppInstallation.count({ where: { installationId: id } })).toBe(1);
  });
});
