/**
 * Onboarding "GitHub connected" on PostgreSQL with the real GithubAppInstallationService:
 * only an ACTIVE installation with verified ownership on the user's current workspace counts.
 * Stubbed: personal-token status, App token service (auth enabled).
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { encryptSecret } from '../../src/common/crypto/secret-box';
import { GithubAppInstallationService } from '../../src/github-app/github-app-installation.service';
import { RequestContextService } from '../../src/observability/request-context.service';
import { OnboardingService } from '../../src/settings/onboarding.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
const ENCRYPTION_KEY = 'it-encryption-key-0123456789abcdef0123';

describe.skipIf(!URL_ENV)('Onboarding GitHub status (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let onboarding: OnboardingService;
  const pat = { getStatus: vi.fn(async () => ({ connected: false })) };
  let run = 0;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();
    const appTokens = { isAppAuthEnabled: () => true };
    const installations = new GithubAppInstallationService(
      prisma as never,
      {} as never,
      { get: () => '', getOrThrow: () => ENCRYPTION_KEY } as never,
      appTokens as never,
      {} as never,
    );
    onboarding = new OnboardingService(
      prisma as never,
      pat as never,
      { get: () => 'http://localhost:3000' } as never,
      installations,
      appTokens as never,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function seed(opts: { installation?: { status: string; verified: boolean } }) {
    run += 1;
    const tag = `${run}_${Date.now()}`;
    const ws = `ws_onb_${tag}`;
    const user = `onb_user_${tag}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.user.create({
      data: { id: user, email: `${user}@it.test`, passwordHash: 'x', lastWorkspaceId: ws },
    });
    await prisma.workspaceMembership.create({
      data: { workspaceId: ws, userId: user, role: 'owner', status: 'active' },
    });
    if (opts.installation) {
      await prisma.gitHubAppInstallation.create({
        data: {
          workspaceId: ws,
          installationId: `7${run}${Date.now() % 100000}`,
          accountLogin: 'acme',
          accountType: 'Organization',
          repositorySelection: 'selected',
          status: opts.installation.status,
          ...(opts.installation.verified
            ? {
                metadataCiphertext: encryptSecret(
                  JSON.stringify({
                    ownership: {
                      githubUserId: 1,
                      githubLogin: 'acme-admin',
                      accountType: 'Organization',
                      verifiedAt: new Date().toISOString(),
                      linkedByUserId: user,
                    },
                  }),
                  ENCRYPTION_KEY,
                ),
              }
            : {}),
        },
      });
    }
    return { ws, user };
  }

  const connected = async (user: string, headerWorkspace?: string) => {
    const view = headerWorkspace
      ? await new RequestContextService().run({ workspaceId: headerWorkspace } as never, () =>
          onboarding.getView(user),
        )
      : await onboarding.getView(user);
    return view.steps.githubConnected;
  };

  it('verified, active installation on the current workspace → connected', async () => {
    const { user } = await seed({ installation: { status: 'active', verified: true } });
    expect(await connected(user)).toBe(true);
  });

  it('installation without verified ownership → not connected', async () => {
    const { user } = await seed({ installation: { status: 'active', verified: false } });
    expect(await connected(user)).toBe(false);
  });

  it('suspended or removed installation → not connected', async () => {
    for (const status of ['suspended', 'removed']) {
      const { user } = await seed({ installation: { status, verified: true } });
      expect(await connected(user), status).toBe(false);
    }
  });

  it('no installation and no token → not connected', async () => {
    const { user } = await seed({});
    expect(await connected(user)).toBe(false);
  });

  it("another workspace's installation never counts, even via X-Workspace-Id", async () => {
    const other = await seed({ installation: { status: 'active', verified: true } });
    const { user, ws } = await seed({});
    expect(await connected(user, ws)).toBe(false);
    // Not a member of the other workspace: the header is refused, nothing is trusted.
    expect(await connected(user, other.ws)).toBe(false);
    // The installation's own member still sees it.
    expect(await connected(other.user, other.ws)).toBe(true);
  });

  // ── first PR review (server-side history) and dismissal ──────────────────

  let reviewSeq = 0;
  async function review(workspaceId: string, userId: string, status: string) {
    reviewSeq += 1;
    const now = new Date();
    await prisma.prReviewReport.create({
      data: {
        workspaceId,
        userId,
        operationId:
          `00000000-0000-4000-8000-${String(reviewSeq).padStart(12, '0')}${Date.now() % 10}`.slice(
            0,
            36,
          ),
        owner: 'acme',
        repository: 'app',
        pullRequestNumber: 1,
        status,
        snapshot: { version: 1 },
        startedAt: now,
        completedAt: now,
      },
    });
  }

  it('first PR review: completed/partial count, failed does not, other users never count', async () => {
    const a = await seed({});
    const b = await seed({});
    expect((await onboarding.getView(a.user)).firstPrReviewCompleted).toBe(false);
    await review(a.ws, a.user, 'failed');
    expect((await onboarding.getView(a.user)).firstPrReviewCompleted).toBe(false);
    await review(b.ws, b.user, 'completed'); // someone else's success
    expect((await onboarding.getView(a.user)).firstPrReviewCompleted).toBe(false);
    await review(a.ws, a.user, 'partial');
    expect((await onboarding.getView(a.user)).firstPrReviewCompleted).toBe(true);
    expect((await onboarding.getView(b.user)).firstPrReviewCompleted).toBe(true);
  });

  it('dismissal still works and is independent of review history', async () => {
    const { user } = await seed({});
    const dismissed = await onboarding.update(user, { dismiss: true } as never);
    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.firstPrReviewCompleted).toBe(false);
    // Persisted: an existing user stays dismissed on the next load.
    expect((await onboarding.getView(user)).status).toBe('dismissed');
  });
});
