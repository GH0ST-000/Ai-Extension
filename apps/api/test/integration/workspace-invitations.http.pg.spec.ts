/**
 * M3 — workspace invitation lifecycle, membership changes and last-owner protection, against
 * real PostgreSQL over real HTTP.
 *
 * Real: PostgreSQL, WorkspacesController + ValidationPipe (main.ts options), WorkspaceGuard,
 * WorkspaceAuthorizationService, WorkspacesService, WorkspaceMembersService,
 * WorkspaceInvitationsService, EntitlementService, UsageService, WorkspaceDeletionService,
 * RequestContext middleware and the exception filter.
 * Stubbed: JWT (`x-test-user` header), the rate limiter, billing (no provider is contacted —
 * the deletion path's cancellation is a no-op stub), the security audit sink (captured).
 * Nothing external is contacted.
 */
import { Test } from '@nestjs/testing';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { JwtAuthGuard } from '../../src/auth/jwt-auth.guard';
import { BillingService } from '../../src/billing/billing.service';
import { RateLimitGuard } from '../../src/common/security/rate-limit.guard';
import { redactUrlForLog } from '../../src/common/http/redact-url';
import { EntitlementService } from '../../src/entitlements/entitlements.service';
import { ObservabilityExceptionFilter } from '../../src/observability/observability-exception.filter';
import { RequestContextMiddleware } from '../../src/observability/request-context.middleware';
import { RequestContextService } from '../../src/observability/request-context.service';
import { SecurityAuditService } from '../../src/observability/security-audit.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { UsageService } from '../../src/usage/usage.service';
import {
  hashInviteToken,
  WorkspaceInvitationsService,
} from '../../src/workspaces/invitations.service';
import { WorkspaceMembersService } from '../../src/workspaces/members.service';
import { WorkspaceAuthorizationService } from '../../src/workspaces/workspace-authorization.service';
import { WorkspaceDeletionService } from '../../src/workspaces/workspace-deletion.service';
import { lockWorkspaceMembership } from '../../src/workspaces/workspace-membership-lock';
import { WorkspaceGuard } from '../../src/workspaces/workspace.guard';
import { WorkspacesController } from '../../src/workspaces/workspaces.controller';
import { WorkspacesService } from '../../src/workspaces/workspaces.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
type Role = 'owner' | 'admin' | 'member';
type Res = { status: number; body: Record<string, unknown> & { code?: string } };

describe.skipIf(!URL_ENV)('Workspace invitations and membership lifecycle (M3)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let baseUrl: string;
  let deletion: WorkspaceDeletionService;
  const audit = { record: vi.fn() };
  let run = 0;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();

    const entitlements = new EntitlementService(prisma as never);
    const authorization = new WorkspaceAuthorizationService(prisma as never);
    // No subscription in these workspaces: nothing to cancel (the billing flow itself is
    // covered by workspace-deletion.pg.spec.ts).
    const billingStub = {
      recordDeletionCancellation: async () => 'none',
      processCancellationRequests: async () => ({ done: 0, failed: 0, outcomes: [] }),
      waitForInFlightCancellations: async () => undefined,
      openCancellationCount: async () => 0,
    };
    deletion = new WorkspaceDeletionService(
      prisma as never,
      authorization,
      billingStub as never,
      entitlements,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [WorkspacesController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementService, useValue: entitlements },
        { provide: UsageService, useValue: new UsageService(prisma as never, entitlements) },
        { provide: BillingService, useValue: billingStub },
        { provide: WorkspaceDeletionService, useValue: deletion },
        { provide: SecurityAuditService, useValue: audit },
        { provide: WorkspaceAuthorizationService, useValue: authorization },
        WorkspaceGuard,
        WorkspacesService,
        WorkspaceMembersService,
        WorkspaceInvitationsService,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp: () => { getRequest: () => Request } }) => {
          const req = ctx.switchToHttp().getRequest() as Request & { user?: unknown };
          const id = req.header('x-test-user');
          if (!id) return false;
          req.user = { id, email: `${id}@it.test`, name: null };
          return true;
        },
      })
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    const requestContext = new RequestContextService();
    const ctxMiddleware = new RequestContextMiddleware(
      requestContext,
      { shouldSample: () => false } as never,
      { get: () => undefined } as never,
    );
    app.use((req: Request, res: Response, next: NextFunction) => ctxMiddleware.use(req, res, next));
    app.useGlobalFilters(new ObservabilityExceptionFilter(requestContext));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  beforeEach(() => audit.record.mockClear());

  // ── helpers ──────────────────────────────────────────────────────────────

  async function call(user: string, method: string, path: string, body?: unknown): Promise<Res> {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': user },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  }

  /** A Team workspace with the given members (name → role); `outsiders` exist but aren't members. */
  /** `unverified`: people whose email ownership is NOT verified (Decision A). */
  async function seed(
    roles: Record<string, Role>,
    outsiders: string[] = [],
    unverified: string[] = [],
  ) {
    run += 1;
    const tag = `${run}_${Date.now()}`;
    const ws = `ws_inv_${tag}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.workspaceSubscription.create({
      data: { workspaceId: ws, provider: 'paddle', planId: 'team', status: 'active' },
    });
    const users: Record<string, string> = {};
    const memberships: Record<string, string> = {};
    for (const name of [...Object.keys(roles), ...outsiders]) {
      const id = `inv_${name}_${tag}`;
      users[name] = id;
      await prisma.user.create({
        data: {
          id,
          email: `${id}@it.test`,
          passwordHash: 'x',
          lastWorkspaceId: ws,
          emailVerifiedAt: unverified.includes(name) ? null : new Date(),
        },
      });
      const role = roles[name];
      if (role) {
        const m = await prisma.workspaceMembership.create({
          data: { workspaceId: ws, userId: id, role, status: 'active', joinedAt: new Date() },
        });
        memberships[name] = m.id;
      }
    }
    return { ws, users, memberships };
  }

  const emailOf = (userId: string) => `${userId}@it.test`;
  const invite = (
    actor: string,
    ws: string,
    invitee: string,
    role: 'admin' | 'member' = 'member',
  ) => call(actor, 'POST', `/workspaces/${ws}/invitations`, { email: emailOf(invitee), role });
  const accept = (user: string, token: string) =>
    call(user, 'POST', `/workspace-invitations/${encodeURIComponent(token)}/accept`);
  const membershipOf = (ws: string, userId: string) =>
    prisma.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId: ws, userId } },
    });
  const invitationStatus = async (id: string) =>
    (await prisma.workspaceInvitation.findUniqueOrThrow({ where: { id } })).status;
  const activeOwners = (ws: string) =>
    prisma.workspaceMembership.count({
      where: { workspaceId: ws, status: 'active', role: 'owner' },
    });
  /** An invitation row written directly (e.g. one that predates this release). */
  async function rawInvitation(
    ws: string,
    invitee: string,
    inviter: string,
    role: string,
    createdAt?: Date,
  ) {
    const token = `tok_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    const row = await prisma.workspaceInvitation.create({
      data: {
        workspaceId: ws,
        email: emailOf(invitee),
        role,
        tokenHash: hashInviteToken(token),
        status: 'pending',
        expiresAt: new Date(Date.now() + 86_400_000),
        invitedByUserId: inviter,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return { id: row.id, token };
  }
  const audited = (type: string) =>
    audit.record.mock.calls
      .map((c) => c[0] as { type: string; outcome: string; detail?: string })
      .filter((e) => e.type === type);

  // ── invitation acceptance ────────────────────────────────────────────────

  describe('acceptance', () => {
    it('valid invitation is accepted once; the token is never stored, listed or audited', async () => {
      const { ws, users } = await seed({ owner: 'owner' }, ['bob']);
      const created = await invite(users.owner!, ws, users.bob!, 'admin');
      expect(created.status).toBe(201);
      const token = created.body.token as string;
      expect(token).toBeTruthy();
      const row = await prisma.workspaceInvitation.findUniqueOrThrow({
        where: { id: created.body.id as string },
      });
      expect(row.tokenHash).toBe(hashInviteToken(token));
      expect(JSON.stringify(row)).not.toContain(token);

      const ok = await accept(users.bob!, token);
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ role: 'admin', status: 'active', alreadyMember: false });
      expect(await invitationStatus(row.id)).toBe('accepted');
      expect(audited('workspace.invitation.accepted')).toHaveLength(1);
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(token);
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(row.tokenHash);
      expect(redactUrlForLog(`/api/workspace-invitations/${token}/accept`)).not.toContain(token);
    });

    it('expired, revoked and consumed invitations are rejected without membership changes', async () => {
      const { ws, users } = await seed({ owner: 'owner' }, ['a', 'b', 'c', 'd']);
      const expired = await rawInvitation(ws, users.a!, users.owner!, 'member');
      await prisma.workspaceInvitation.update({
        where: { id: expired.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await accept(users.a!, expired.token)).body.code).toBe(
        'WORKSPACE_INVITATION_EXPIRED',
      );

      const revoked = await rawInvitation(ws, users.b!, users.owner!, 'member');
      expect(
        (await call(users.owner!, 'DELETE', `/workspaces/${ws}/invitations/${revoked.id}`)).status,
      ).toBe(204);
      expect((await accept(users.b!, revoked.token)).body.code).toBe(
        'WORKSPACE_INVITATION_INVALID',
      );

      // Consumed by C; D (another identity) can never use it, and C's replay changes nothing.
      const consumed = await rawInvitation(ws, users.c!, users.owner!, 'member');
      expect((await accept(users.c!, consumed.token)).status).toBe(201);
      expect((await accept(users.d!, consumed.token)).body.code).toBe(
        'WORKSPACE_INVITATION_INVALID',
      );
      for (const u of [users.a!, users.b!, users.d!]) expect(await membershipOf(ws, u)).toBeNull();
    });

    it('wrong user is rejected with no information about the workspace or invitation state', async () => {
      const { ws, users } = await seed({ owner: 'owner' }, ['bob', 'eve']);
      const inv = await rawInvitation(ws, users.bob!, users.owner!, 'admin');
      const res = await accept(users.eve!, inv.token);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('WORKSPACE_INVITATION_INVALID');
      expect(JSON.stringify(res.body)).not.toContain(ws);
      expect(await membershipOf(ws, users.eve!)).toBeNull();
      expect(await invitationStatus(inv.id)).toBe('pending');
    });

    it.each([
      ['owner', 'member'],
      ['owner', 'admin'],
      ['admin', 'member'],
      ['member', 'admin'],
    ] as const)(
      'an existing %s keeps their role when accepting a %s invitation',
      async (current, invited) => {
        const { ws, users } = await seed({
          owner: 'owner',
          x: current === 'owner' ? 'owner' : current,
        });
        const inv = await rawInvitation(ws, users.x!, users.owner!, invited);
        const res = await accept(users.x!, inv.token);
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ role: current, alreadyMember: true });
        expect((await membershipOf(ws, users.x!))!.role).toBe(current);
        expect(await invitationStatus(inv.id)).toBe('revoked'); // retired, cannot be reused later
        expect(audited('workspace.membership.denied')).toHaveLength(1);
      },
    );

    it('the sole owner cannot lose ownership through a stale invitation', async () => {
      const { ws, users } = await seed({ owner: 'owner' });
      const inv = await rawInvitation(ws, users.owner!, users.owner!, 'member');
      await accept(users.owner!, inv.token);
      expect(await activeOwners(ws)).toBe(1);
      expect((await membershipOf(ws, users.owner!))!.role).toBe('owner');
    });

    it('a removed member cannot reuse an invitation invalidated by the removal', async () => {
      const { ws, users, memberships } = await seed({ owner: 'owner', bob: 'member' });
      const pending = await rawInvitation(ws, users.bob!, users.owner!, 'admin');
      expect(
        (await call(users.owner!, 'DELETE', `/workspaces/${ws}/members/${memberships.bob}`)).status,
      ).toBe(204);
      expect(await invitationStatus(pending.id)).toBe('revoked');
      expect((await accept(users.bob!, pending.token)).body.code).toBe(
        'WORKSPACE_INVITATION_INVALID',
      );
      expect((await membershipOf(ws, users.bob!))!.status).toBe('removed');
      expect((await call(users.bob!, 'GET', `/workspaces/${ws}/members`)).status).toBe(403);
    });

    it('a legacy invitation issued before the removal is refused (and retired)', async () => {
      const { ws, users, memberships } = await seed({ owner: 'owner', bob: 'member' });
      await prisma.workspaceMembership.update({
        where: { id: memberships.bob },
        data: { status: 'removed' },
      });
      // Pending row that pre-dates the removal and was never revoked (data from before M3).
      const legacy = await rawInvitation(
        ws,
        users.bob!,
        users.owner!,
        'admin',
        new Date(Date.now() - 3_600_000),
      );
      expect((await accept(users.bob!, legacy.token)).body.code).toBe(
        'WORKSPACE_INVITATION_INVALID',
      );
      expect((await membershipOf(ws, users.bob!))!.status).toBe('removed');
      expect(await invitationStatus(legacy.id)).toBe('revoked');
    });

    it('a removed member re-invited AFTER the removal can rejoin with the new role', async () => {
      const { ws, users, memberships } = await seed({ owner: 'owner', bob: 'admin' });
      await call(users.owner!, 'DELETE', `/workspaces/${ws}/members/${memberships.bob}`);
      const fresh = await invite(users.owner!, ws, users.bob!, 'member');
      const res = await accept(users.bob!, fresh.body.token as string);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ role: 'member', status: 'active', alreadyMember: false });
    });

    it('duplicate acceptance returns the same membership and creates nothing new', async () => {
      const { ws, users } = await seed({ owner: 'owner' }, ['bob']);
      const inv = await rawInvitation(ws, users.bob!, users.owner!, 'member');
      const first = await accept(users.bob!, inv.token);
      const second = await accept(users.bob!, inv.token);
      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);
      expect(
        await prisma.workspaceMembership.count({ where: { workspaceId: ws, userId: users.bob! } }),
      ).toBe(1);
    });

    it('concurrent acceptances of one invitation create exactly one membership', async () => {
      const { ws, users } = await seed({ owner: 'owner' }, ['bob']);
      const inv = await rawInvitation(ws, users.bob!, users.owner!, 'member');
      const results = await Promise.all(
        Array.from({ length: 6 }, () => accept(users.bob!, inv.token)),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(
        await prisma.workspaceMembership.count({ where: { workspaceId: ws, userId: users.bob! } }),
      ).toBe(1);
      expect(audited('workspace.invitation.accepted')).toHaveLength(1);
    });

    it('concurrent acceptances of two invitations for one person: one join, role from one invitation', async () => {
      const { ws, users } = await seed({ owner: 'owner' }, ['bob']);
      const a = await rawInvitation(ws, users.bob!, users.owner!, 'member');
      const b = await rawInvitation(ws, users.bob!, users.owner!, 'admin');
      const [ra, rb] = await Promise.all([
        accept(users.bob!, a.token),
        accept(users.bob!, b.token),
      ]);
      expect([ra.body.alreadyMember, rb.body.alreadyMember].sort()).toEqual([false, true]);
      const m = await membershipOf(ws, users.bob!);
      const joinedWith = ra.body.alreadyMember ? 'admin' : 'member';
      expect(m!.role).toBe(joinedWith); // the second never overwrote the first
    });

    it.each(['deletion_pending', 'deleted'])(
      'a %s workspace refuses acceptance',
      async (status) => {
        const { ws, users } = await seed({ owner: 'owner' }, ['bob']);
        const inv = await rawInvitation(ws, users.bob!, users.owner!, 'member');
        await prisma.workspace.update({ where: { id: ws }, data: { status } });
        const res = await accept(users.bob!, inv.token);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('WORKSPACE_INACTIVE');
        expect(await membershipOf(ws, users.bob!)).toBeNull();
      },
    );

    it('acceptance racing with workspace deletion never leaves a member in a deleted workspace', async () => {
      for (let i = 0; i < 4; i += 1) {
        const { ws, users } = await seed({ owner: 'owner' }, ['bob']);
        const inv = await rawInvitation(ws, users.bob!, users.owner!, 'member');
        const [acc] = await Promise.all([
          accept(users.bob!, inv.token),
          deletion.deleteWorkspace(ws, users.owner!),
        ]);
        const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: ws } });
        expect(workspace.status).toBe('deleted');
        if (acc.status !== 201) expect(acc.body.code).toBe('WORKSPACE_INACTIVE');
        // Whatever the order, nobody can use the deleted workspace.
        expect((await call(users.bob!, 'GET', `/workspaces/${ws}`)).status).toBe(403);
      }
    });

    it('acceptance waits for the workspace membership lock (serialized with membership changes)', async () => {
      const { ws, users } = await seed({ owner: 'owner' }, ['bob']);
      const inv = await rawInvitation(ws, users.bob!, users.owner!, 'member');
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const holder = prisma.$transaction(
        async (tx) => {
          await lockWorkspaceMembership(tx, ws);
          await held;
          // While holding the lock, the invitation is revoked (like a removal would).
          await tx.workspaceInvitation.update({
            where: { id: inv.id },
            data: { status: 'revoked' },
          });
        },
        { timeout: 15_000 },
      );
      await new Promise((r) => setTimeout(r, 100));
      const pendingAccept = accept(users.bob!, inv.token);
      await new Promise((r) => setTimeout(r, 400));
      expect(await membershipOf(ws, users.bob!)).toBeNull(); // still waiting
      release();
      await holder;
      expect((await pendingAccept).body.code).toBe('WORKSPACE_INVITATION_INVALID');
      expect(await membershipOf(ws, users.bob!)).toBeNull();
    });
  });

  // ── Decision A: verified identity ──────────────────────────────────────

  describe('invitation acceptance requires a VERIFIED email (Decision A)', () => {
    it('an unverified account with the invited address cannot accept; after verifying it can', async () => {
      const { ws, users } = await seed({ owner: 'owner' }, ['bob'], ['bob']);
      const inv = await rawInvitation(ws, users.bob!, users.owner!, 'admin');
      const refused = await accept(users.bob!, inv.token);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('EMAIL_NOT_VERIFIED');
      expect(await membershipOf(ws, users.bob!)).toBeNull();
      expect(await invitationStatus(inv.id)).toBe('pending'); // not consumed
      await prisma.user.update({
        where: { id: users.bob! },
        data: { emailVerifiedAt: new Date() },
      });
      const ok = await accept(users.bob!, inv.token);
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ role: 'admin', alreadyMember: false });
    });

    it('a verified account with a DIFFERENT email cannot accept (identity checked before verification)', async () => {
      const { ws, users } = await seed({ owner: 'owner' }, ['bob', 'eve']);
      const inv = await rawInvitation(ws, users.bob!, users.owner!, 'member');
      const res = await accept(users.eve!, inv.token);
      expect(res.body.code).toBe('WORKSPACE_INVITATION_INVALID');
      expect(await membershipOf(ws, users.eve!)).toBeNull();
    });

    it('verification does not bypass revoked, removed-member, cross-workspace or existing-member rules', async () => {
      const { ws, users, memberships } = await seed({ owner: 'owner', bob: 'member' });
      const other = await seed({ owner: 'owner' });
      const stale = await rawInvitation(ws, users.bob!, users.owner!, 'admin');
      // Existing member: role unchanged.
      expect((await accept(users.bob!, stale.token)).body).toMatchObject({
        role: 'member',
        alreadyMember: true,
      });
      // Removed member: the invitation retired by removal stays unusable.
      const pending = await rawInvitation(ws, users.bob!, users.owner!, 'admin');
      await call(users.owner!, 'DELETE', `/workspaces/${ws}/members/${memberships.bob}`);
      expect((await accept(users.bob!, pending.token)).body.code).toBe(
        'WORKSPACE_INVITATION_INVALID',
      );
      // Another workspace's revoke path cannot reach it.
      const crossInv = await rawInvitation(ws, users.bob!, users.owner!, 'member');
      expect(
        (
          await call(
            other.users.owner!,
            'DELETE',
            `/workspaces/${other.ws}/invitations/${crossInv.id}`,
          )
        ).status,
      ).toBe(404);
    });
  });

  // ── membership lifecycle ─────────────────────────────────────────────────

  describe('membership changes invalidate pending invitations', () => {
    it('removal and role change revoke only that person’s invitations in this workspace', async () => {
      const { ws, users, memberships } = await seed(
        { owner: 'owner', bob: 'member', carol: 'member' },
        ['dave'],
      );
      const other = await seed({ owner: 'owner' });
      const bobHere = await rawInvitation(ws, users.bob!, users.owner!, 'admin');
      const carolHere = await rawInvitation(ws, users.carol!, users.owner!, 'admin');
      const daveHere = await rawInvitation(ws, users.dave!, users.owner!, 'member');
      const bobElsewhere = await rawInvitation(other.ws, users.bob!, other.users.owner!, 'member');
      const carolElsewhere = await rawInvitation(
        other.ws,
        users.carol!,
        other.users.owner!,
        'member',
      );

      expect(
        (await call(users.owner!, 'DELETE', `/workspaces/${ws}/members/${memberships.bob}`)).status,
      ).toBe(204);
      const changed = await call(
        users.owner!,
        'PATCH',
        `/workspaces/${ws}/members/${memberships.carol}`,
        { role: 'admin' },
      );
      expect(changed.status).toBe(200);

      expect(await invitationStatus(bobHere.id)).toBe('revoked');
      expect(await invitationStatus(carolHere.id)).toBe('revoked');
      expect(await invitationStatus(daveHere.id)).toBe('pending'); // unrelated user
      expect(await invitationStatus(bobElsewhere.id)).toBe('pending'); // other workspace
      expect(await invitationStatus(carolElsewhere.id)).toBe('pending');
      expect(audited('workspace.member.removed')).toHaveLength(1);
      expect(audited('workspace.member.role_changed')).toHaveLength(1);
    });

    it('concurrent accept and removal can never restore access', async () => {
      for (let i = 0; i < 5; i += 1) {
        const { ws, users, memberships } = await seed({ owner: 'owner', bob: 'member' });
        const stale = await rawInvitation(ws, users.bob!, users.owner!, 'admin');
        await Promise.all([
          accept(users.bob!, stale.token),
          call(users.owner!, 'DELETE', `/workspaces/${ws}/members/${memberships.bob}`),
        ]);
        expect((await membershipOf(ws, users.bob!))!.status).toBe('removed');
        expect(await invitationStatus(stale.id)).toBe('revoked');
        expect((await accept(users.bob!, stale.token)).status).toBe(400);
        expect((await membershipOf(ws, users.bob!))!.status).toBe('removed');
      }
    });

    it('concurrent accept and role change cannot overwrite the decided role', async () => {
      for (let i = 0; i < 5; i += 1) {
        const { ws, users, memberships } = await seed({ owner: 'owner', bob: 'admin' });
        const stale = await rawInvitation(ws, users.bob!, users.owner!, 'admin');
        await Promise.all([
          accept(users.bob!, stale.token),
          call(users.owner!, 'PATCH', `/workspaces/${ws}/members/${memberships.bob}`, {
            role: 'member',
          }),
        ]);
        expect((await membershipOf(ws, users.bob!))!.role).toBe('member');
        expect(await invitationStatus(stale.id)).toBe('revoked');
      }
    });

    it('a new invitation supersedes the previous pending link for the same person', async () => {
      const { ws, users } = await seed({ owner: 'owner' }, ['bob']);
      const first = await invite(users.owner!, ws, users.bob!, 'admin');
      const second = await invite(users.owner!, ws, users.bob!, 'member');
      expect(await invitationStatus(first.body.id as string)).toBe('revoked');
      expect((await accept(users.bob!, first.body.token as string)).status).toBe(400);
      expect((await accept(users.bob!, second.body.token as string)).body).toMatchObject({
        role: 'member',
      });
    });

    it('concurrent duplicate invitations leave exactly one usable invitation', async () => {
      const { ws, users } = await seed({ owner: 'owner', admin: 'admin' }, ['bob']);
      const results = await Promise.all([
        invite(users.owner!, ws, users.bob!, 'member'),
        invite(users.admin!, ws, users.bob!, 'admin'),
        invite(users.owner!, ws, users.bob!, 'member'),
      ]);
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(
        await prisma.workspaceInvitation.count({
          where: { workspaceId: ws, email: emailOf(users.bob!), status: 'pending' },
        }),
      ).toBe(1);
    });

    it('inviting an existing member is refused', async () => {
      const { ws, users } = await seed({ owner: 'owner', bob: 'member' });
      const res = await invite(users.owner!, ws, users.bob!, 'admin');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('WORKSPACE_INVITATION_INVALID');
    });
  });

  // ── last owner ───────────────────────────────────────────────────────────

  describe('last owner protection', () => {
    it('the last owner cannot be removed or demoted', async () => {
      const { ws, users, memberships } = await seed({ owner: 'owner', admin: 'admin' });
      const removed = await call(
        users.owner!,
        'DELETE',
        `/workspaces/${ws}/members/${memberships.owner}`,
      );
      expect(removed.status).toBe(403);
      expect(removed.body.code).toBe('WORKSPACE_LAST_OWNER');
      const demoted = await call(
        users.owner!,
        'PATCH',
        `/workspaces/${ws}/members/${memberships.owner}`,
        { role: 'admin' },
      );
      expect(demoted.body.code).toBe('WORKSPACE_LAST_OWNER');
      expect(await activeOwners(ws)).toBe(1);
      expect(audited('workspace.membership.denied').length).toBeGreaterThanOrEqual(2);
    });

    it('two owners removing each other concurrently never leave zero owners', async () => {
      for (let i = 0; i < 6; i += 1) {
        const { ws, users, memberships } = await seed({ o1: 'owner', o2: 'owner' });
        const results = await Promise.all([
          call(users.o1!, 'DELETE', `/workspaces/${ws}/members/${memberships.o2}`),
          call(users.o2!, 'DELETE', `/workspaces/${ws}/members/${memberships.o1}`),
        ]);
        expect(await activeOwners(ws)).toBe(1);
        expect(results.filter((r) => r.status === 204)).toHaveLength(1);
      }
    });

    it('two owners demoting each other / themselves concurrently never leave zero owners', async () => {
      for (let i = 0; i < 6; i += 1) {
        const { ws, users, memberships } = await seed({ o1: 'owner', o2: 'owner' });
        await Promise.all([
          call(users.o1!, 'PATCH', `/workspaces/${ws}/members/${memberships.o1}`, {
            role: 'member',
          }),
          call(users.o2!, 'PATCH', `/workspaces/${ws}/members/${memberships.o2}`, {
            role: 'admin',
          }),
        ]);
        expect(await activeOwners(ws)).toBe(1);
      }
    });

    it('admins and members never become owner: not by invitation, not by role change', async () => {
      const { ws, users, memberships } = await seed({
        owner: 'owner',
        admin: 'admin',
        member: 'member',
      });
      const ownerInvite = await call(users.owner!, 'POST', `/workspaces/${ws}/invitations`, {
        email: 'someone@it.test',
        role: 'owner',
      });
      expect(ownerInvite.status).toBe(400); // DTO: admin | member only
      const self = await call(
        users.admin!,
        'PATCH',
        `/workspaces/${ws}/members/${memberships.admin}`,
        { role: 'owner' },
      );
      expect(self.status).toBe(400);
      const legacyOwnerInvite = await rawInvitation(ws, users.member!, users.owner!, 'owner');
      expect((await accept(users.member!, legacyOwnerInvite.token)).body).toMatchObject({
        role: 'member',
      });
      expect(await activeOwners(ws)).toBe(1);
    });

    it('ownership transfer still works, only for owners, and retires both people’s invitations', async () => {
      const { ws, users, memberships } = await seed({ owner: 'owner', admin: 'admin' });
      const stale = await rawInvitation(ws, users.admin!, users.owner!, 'member');
      expect(
        (
          await call(users.admin!, 'POST', `/workspaces/${ws}/transfer-ownership`, {
            membershipId: memberships.admin,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call(users.owner!, 'POST', `/workspaces/${ws}/transfer-ownership`, {
            membershipId: memberships.admin,
          })
        ).status,
      ).toBe(204);
      expect((await membershipOf(ws, users.admin!))!.role).toBe('owner');
      expect((await membershipOf(ws, users.owner!))!.role).toBe('admin');
      expect(await activeOwners(ws)).toBe(1);
      expect(await invitationStatus(stale.id)).toBe('revoked');
      expect(audited('workspace.ownership.transferred')).toHaveLength(1);
    });

    it('two owners transferring to the same member concurrently: exactly one transfer happens', async () => {
      for (let i = 0; i < 4; i += 1) {
        const { ws, users, memberships } = await seed({ o1: 'owner', o2: 'owner', m: 'member' });
        const results = await Promise.all([
          call(users.o1!, 'POST', `/workspaces/${ws}/transfer-ownership`, {
            membershipId: memberships.m,
          }),
          call(users.o2!, 'POST', `/workspaces/${ws}/transfer-ownership`, {
            membershipId: memberships.m,
          }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([204, 403]);
        // The new owner plus the owner whose transfer was refused: never both demoted.
        expect(await activeOwners(ws)).toBe(2);
        expect((await membershipOf(ws, users.m!))!.role).toBe('owner');
      }
    });

    it('transferring to someone who is already an owner is refused (the actor keeps ownership)', async () => {
      const { ws, users, memberships } = await seed({ o1: 'owner', o2: 'owner' });
      const res = await call(users.o1!, 'POST', `/workspaces/${ws}/transfer-ownership`, {
        membershipId: memberships.o2,
      });
      expect(res.status).toBe(403);
      expect((await membershipOf(ws, users.o1!))!.role).toBe('owner');
    });
  });

  // ── management ───────────────────────────────────────────────────────────

  describe('listing and revocation', () => {
    it('owners and admins list pending invitations without tokens; members cannot', async () => {
      const { ws, users } = await seed({ owner: 'owner', admin: 'admin', member: 'member' }, [
        'bob',
      ]);
      const created = await invite(users.admin!, ws, users.bob!, 'member');
      const token = created.body.token as string;
      for (const viewer of [users.owner!, users.admin!]) {
        const list = await call(viewer, 'GET', `/workspaces/${ws}/invitations`);
        expect(list.status).toBe(200);
        const items = list.body as unknown as Array<Record<string, unknown>>;
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          email: emailOf(users.bob!),
          role: 'member',
          status: 'pending',
        });
        expect(items[0]!.expiresAt).toBeTruthy();
        const raw = JSON.stringify(items);
        expect(raw).not.toContain(token);
        expect(raw).not.toContain(hashInviteToken(token));
        expect(items[0]).not.toHaveProperty('token');
      }
      const denied = await call(users.member!, 'GET', `/workspaces/${ws}/invitations`);
      expect(denied.status).toBe(403);
      expect(JSON.stringify(denied.body)).not.toContain(users.bob!);
    });

    it('admins revoke idempotently; members cannot; revoked invitations cannot be accepted', async () => {
      const { ws, users } = await seed({ owner: 'owner', admin: 'admin', member: 'member' }, [
        'bob',
      ]);
      const inv = await rawInvitation(ws, users.bob!, users.owner!, 'member');
      const path = `/workspaces/${ws}/invitations/${inv.id}`;
      expect((await call(users.member!, 'DELETE', path)).status).toBe(403);
      expect(await invitationStatus(inv.id)).toBe('pending');
      expect((await call(users.admin!, 'DELETE', path)).status).toBe(204);
      expect((await call(users.admin!, 'DELETE', path)).status).toBe(204);
      expect(audited('workspace.invitation.revoked')).toHaveLength(1);
      expect((await accept(users.bob!, inv.token)).body.code).toBe('WORKSPACE_INVITATION_INVALID');
      expect((await call(users.owner!, 'GET', `/workspaces/${ws}/invitations`)).body).toEqual([]);
    });

    it('an accepted invitation cannot be "revoked"', async () => {
      const { ws, users } = await seed({ owner: 'owner' }, ['bob']);
      const inv = await rawInvitation(ws, users.bob!, users.owner!, 'member');
      await accept(users.bob!, inv.token);
      const res = await call(users.owner!, 'DELETE', `/workspaces/${ws}/invitations/${inv.id}`);
      expect(res.body.code).toBe('WORKSPACE_INVITATION_ALREADY_USED');
    });

    it('cross-workspace: invitations of another workspace cannot be listed or revoked', async () => {
      const a = await seed({ owner: 'owner' }, ['bob']);
      const b = await seed({ owner: 'owner' });
      const inv = await rawInvitation(a.ws, a.users.bob!, a.users.owner!, 'member');
      // B's owner, through B's workspace path: not found.
      const viaOwn = await call(
        b.users.owner!,
        'DELETE',
        `/workspaces/${b.ws}/invitations/${inv.id}`,
      );
      expect(viaOwn.status).toBe(404);
      expect(viaOwn.body.code).toBe('WORKSPACE_INVITATION_NOT_FOUND');
      // Through A's path: not a member.
      expect(
        (await call(b.users.owner!, 'DELETE', `/workspaces/${a.ws}/invitations/${inv.id}`)).status,
      ).toBe(403);
      expect((await call(b.users.owner!, 'GET', `/workspaces/${a.ws}/invitations`)).status).toBe(
        403,
      );
      expect(await invitationStatus(inv.id)).toBe('pending');
    });

    it('accept vs revoke: exactly one wins, never both', async () => {
      for (let i = 0; i < 5; i += 1) {
        const { ws, users } = await seed({ owner: 'owner' }, ['bob']);
        const inv = await rawInvitation(ws, users.bob!, users.owner!, 'member');
        const [acc, rev] = await Promise.all([
          accept(users.bob!, inv.token),
          call(users.owner!, 'DELETE', `/workspaces/${ws}/invitations/${inv.id}`),
        ]);
        const status = await invitationStatus(inv.id);
        const member = await membershipOf(ws, users.bob!);
        if (status === 'accepted') {
          expect(acc.status).toBe(201);
          expect(rev.body.code).toBe('WORKSPACE_INVITATION_ALREADY_USED');
          expect(member?.status).toBe('active');
        } else {
          expect(status).toBe('revoked');
          expect(rev.status).toBe(204);
          expect(member).toBeNull();
        }
      }
    });
  });

  // ── Decision B: free workspace limit ──────────────────────────────────

  describe('free workspace limit (Decision B)', () => {
    const create = (user: string, name = `W ${Math.random().toString(36).slice(2, 8)}`) =>
      call(user, 'POST', '/workspaces', { name });
    const limits = async (user: string) => (await call(user, 'GET', '/workspaces/limits')).body;

    it('first and second workspaces are created; the third is refused; usage is reported', async () => {
      const { users } = await seed({}, ['u']);
      expect(await limits(users.u!)).toEqual({ used: 0, limit: 2, canCreate: true });
      expect((await create(users.u!)).status).toBe(201);
      expect((await create(users.u!)).status).toBe(201);
      const third = await create(users.u!);
      expect(third.status).toBe(400);
      expect(third.body.code).toBe('WORKSPACE_LIMIT_REACHED');
      expect(await limits(users.u!)).toEqual({ used: 2, limit: 2, canCreate: false });
    });

    it('concurrent creations cannot exceed the limit', async () => {
      const { users } = await seed({}, ['u']);
      const results = await Promise.all(Array.from({ length: 6 }, () => create(users.u!)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect(
        await prisma.workspaceMembership.count({ where: { userId: users.u!, role: 'owner' } }),
      ).toBe(2);
    });

    it('memberships as Admin/Member and paid workspaces do not count; a downgrade blocks new ones without deleting anything', async () => {
      const a = await seed({ owner: 'owner', u: 'member' });
      const b = await seed({ owner: 'owner' });
      await prisma.workspaceMembership.create({
        data: { workspaceId: b.ws, userId: a.users.u!, role: 'admin', status: 'active' },
      });
      expect((await limits(a.users.u!)).used).toBe(0); // member/admin elsewhere
      const first = await create(a.users.u!);
      const second = await create(a.users.u!);
      // One of them becomes paid: it no longer counts.
      await prisma.workspaceSubscription.update({
        where: { workspaceId: first.body.id as string },
        data: { planId: 'pro', status: 'active' },
      });
      expect((await create(a.users.u!)).status).toBe(201);
      // Downgrade: back to free → 3 free owned (over the limit). Nothing is deleted…
      await prisma.workspaceSubscription.update({
        where: { workspaceId: first.body.id as string },
        data: { planId: 'free', status: 'cancelled' },
      });
      expect((await limits(a.users.u!)).used).toBe(3);
      expect(
        await prisma.workspace.count({
          where: {
            id: { in: [first.body.id as string, second.body.id as string] },
            status: 'active',
          },
        }),
      ).toBe(2);
      // …but no further free workspace can be created.
      expect((await create(a.users.u!)).body.code).toBe('WORKSPACE_LIMIT_REACHED');
    });

    it('quota cycling: a workspace deleted this month keeps its slot; pending deletion counts too', async () => {
      const { users } = await seed({}, ['u']);
      const one = await create(users.u!);
      const two = await create(users.u!);
      expect((await call(users.u!, 'DELETE', `/workspaces/${two.body.id as string}`)).status).toBe(
        204,
      );
      expect((await create(users.u!)).body.code).toBe('WORKSPACE_LIMIT_REACHED'); // slot still held
      // Deleted in an earlier period → slot free again.
      await prisma.workspace.update({
        where: { id: two.body.id as string },
        data: { updatedAt: new Date(Date.UTC(2020, 0, 15)) },
      });
      expect((await create(users.u!)).status).toBe(201);
      // deletion_pending occupies its slot as well.
      await prisma.workspace.update({
        where: { id: one.body.id as string },
        data: { status: 'deletion_pending' },
      });
      expect((await create(users.u!)).body.code).toBe('WORKSPACE_LIMIT_REACHED');
    });

    it('deleted slots follow the plan at deletion START (paid→downgraded counts, paid does not, legacy counts)', async () => {
      const { users } = await seed({}, ['u']);
      const keep = await create(users.u!);
      const temp = await create(users.u!);
      // Paid when deleted: its slot is released at once.
      await prisma.workspaceSubscription.update({
        where: { workspaceId: temp.body.id as string },
        data: { planId: 'pro', status: 'active' },
      });
      await call(users.u!, 'DELETE', `/workspaces/${temp.body.id as string}`);
      expect((await limits(users.u!)).used).toBe(1);
      // Downgraded to free before deletion: it keeps its slot even if billing later writes a
      // paid plan onto the deleted row (late webhook).
      const next = await create(users.u!);
      await call(users.u!, 'DELETE', `/workspaces/${next.body.id as string}`);
      await prisma.workspaceSubscription.update({
        where: { workspaceId: next.body.id as string },
        data: { planId: 'team', status: 'active' },
      });
      expect((await limits(users.u!)).used).toBe(2);
      // Legacy deleted rows (no recorded plan) count.
      await prisma.workspace.update({
        where: { id: next.body.id as string },
        data: { deletedOnFreePlan: null },
      });
      expect((await limits(users.u!)).used).toBe(2);
      expect(keep.status).toBe(201);
    });

    it('ownership transfer cannot bypass the limit (free workspace refused, paid allowed)', async () => {
      const { ws, users, memberships } = await seed({ owner: 'owner', full: 'admin' });
      await create(users.full!);
      await create(users.full!); // the admin already owns 2 free workspaces
      // The workspace being transferred is on the free plan.
      await prisma.workspaceSubscription.update({
        where: { workspaceId: ws },
        data: { planId: 'free', status: 'active' },
      });
      const refused = await call(users.owner!, 'POST', `/workspaces/${ws}/transfer-ownership`, {
        membershipId: memberships.full,
      });
      expect(refused.body.code).toBe('WORKSPACE_LIMIT_REACHED');
      expect((await membershipOf(ws, users.owner!))!.role).toBe('owner');
      // The seeded workspace is on the Team plan (paid) → allowed.
      await prisma.workspaceSubscription.update({
        where: { workspaceId: ws },
        data: { planId: 'team', status: 'active' },
      });
      expect(
        (
          await call(users.owner!, 'POST', `/workspaces/${ws}/transfer-ownership`, {
            membershipId: memberships.full,
          })
        ).status,
      ).toBe(204);
    });
  });

  // ── regression ───────────────────────────────────────────────────────────

  describe('regression', () => {
    it('workspace creation and the standard invite → accept → manage flow still work', async () => {
      const { users } = await seed({}, ['founder', 'bob']);
      const created = await call(users.founder!, 'POST', '/workspaces', { name: `Team ${run}` });
      expect(created.status).toBe(201);
      const ws = created.body.id as string;
      await prisma.workspaceSubscription.update({
        where: { workspaceId: ws },
        data: { planId: 'team' },
      });
      const inv = await invite(users.founder!, ws, users.bob!, 'member');
      const joined = await accept(users.bob!, inv.body.token as string);
      expect(joined.body).toMatchObject({ role: 'member', alreadyMember: false });
      const members = await call(users.bob!, 'GET', `/workspaces/${ws}/members`);
      expect(members.status).toBe(200);
      // Members still cannot invite or manage (RBAC unchanged).
      expect((await invite(users.bob!, ws, users.founder!, 'member')).status).toBe(403);
      const promoted = await call(
        users.founder!,
        'PATCH',
        `/workspaces/${ws}/members/${joined.body.id as string}`,
        {
          role: 'admin',
        },
      );
      expect(promoted.body).toMatchObject({ role: 'admin' });
    });

    it('admins still cannot change owners or their own role', async () => {
      const { ws, users, memberships } = await seed({ owner: 'owner', admin: 'admin' });
      expect(
        (
          await call(users.admin!, 'PATCH', `/workspaces/${ws}/members/${memberships.owner}`, {
            role: 'member',
          })
        ).status,
      ).toBe(403);
      expect(
        (await call(users.admin!, 'DELETE', `/workspaces/${ws}/members/${memberships.owner}`))
          .status,
      ).toBe(403);
      expect(
        (
          await call(users.admin!, 'PATCH', `/workspaces/${ws}/members/${memberships.admin}`, {
            role: 'member',
          })
        ).status,
      ).toBe(403);
      expect((await membershipOf(ws, users.owner!))!.role).toBe('owner');
    });

    it('membership changes are scoped to the workspace in the path', async () => {
      const a = await seed({ owner: 'owner', bob: 'member' });
      const b = await seed({ owner: 'owner' });
      const res = await call(
        b.users.owner!,
        'DELETE',
        `/workspaces/${b.ws}/members/${a.memberships.bob}`,
      );
      expect(res.status).toBe(404);
      expect((await membershipOf(a.ws, a.users.bob!))!.status).toBe('active');
    });
  });
  // ── F-14: an invitation carries its inviter's authority and no more ─────

  describe('[F-14] invitations issued by a member who is then removed or demoted', () => {
    it('removing an admin voids the admin invitation they left behind for another account', async () => {
      const { ws, users, memberships } = await seed({ owner: 'owner', mallory: 'admin' }, ['alt']);
      const created = await invite(users.mallory!, ws, users.alt!, 'admin');
      expect(created.status).toBe(201);

      const removed = await call(
        users.owner!,
        'DELETE',
        `/workspaces/${ws}/members/${memberships.mallory}`,
      );
      expect(removed.status).toBeLessThan(300);
      expect(await invitationStatus(created.body.id as string)).toBe('revoked');

      const res = await accept(users.alt!, created.body.token as string);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('WORKSPACE_INVITATION_INVALID');
      expect(await membershipOf(ws, users.alt!)).toBeNull();
    });

    it('demoting an admin to member voids the invitations they issued', async () => {
      const { ws, users, memberships } = await seed({ owner: 'owner', mallory: 'admin' }, ['alt']);
      const created = await invite(users.mallory!, ws, users.alt!, 'admin');
      const demoted = await call(
        users.owner!,
        'PATCH',
        `/workspaces/${ws}/members/${memberships.mallory}`,
        {
          role: 'member',
        },
      );
      expect(demoted.status).toBe(200);
      expect(await invitationStatus(created.body.id as string)).toBe('revoked');
      expect((await accept(users.alt!, created.body.token as string)).status).toBe(400);
      expect(await membershipOf(ws, users.alt!)).toBeNull();
    });

    it('acceptance itself refuses an invitation whose inviter may no longer invite (pre-existing rows)', async () => {
      // Rows from before removals revoked issued invitations: still `pending` in the database.
      for (const how of ['removed', 'demoted', 'never_a_member'] as const) {
        const { ws, users, memberships } = await seed({ owner: 'owner', mallory: 'admin' }, [
          'alt',
          'ghost',
        ]);
        const inviter = how === 'never_a_member' ? users.ghost! : users.mallory!;
        const legacy = await rawInvitation(ws, users.alt!, inviter, 'admin');
        if (how === 'removed') {
          await prisma.workspaceMembership.update({
            where: { id: memberships.mallory! },
            data: { status: 'removed' },
          });
        } else if (how === 'demoted') {
          await prisma.workspaceMembership.update({
            where: { id: memberships.mallory! },
            data: { role: 'member' },
          });
        }
        expect(await invitationStatus(legacy.id)).toBe('pending');
        const res = await accept(users.alt!, legacy.token);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('WORKSPACE_INVITATION_INVALID');
        expect(await membershipOf(ws, users.alt!)).toBeNull();
        expect(await invitationStatus(legacy.id)).toBe('revoked'); // retired, cannot be retried
      }
    });

    it('invitations of an inviter who keeps the right to invite still work (controls)', async () => {
      const { ws, users, memberships } = await seed(
        { owner: 'owner', admin: 'admin', other: 'member' },
        ['newcomer', 'second'],
      );
      const byAdmin = await invite(users.admin!, ws, users.newcomer!, 'member');
      const byOwner = await invite(users.owner!, ws, users.second!, 'member');
      // Removing an unrelated member does not touch them.
      await call(users.owner!, 'DELETE', `/workspaces/${ws}/members/${memberships.other}`);
      expect(await invitationStatus(byAdmin.body.id as string)).toBe('pending');
      expect((await accept(users.newcomer!, byAdmin.body.token as string)).status).toBe(201);
      expect((await accept(users.second!, byOwner.body.token as string)).status).toBe(201);
    });
  });
  // ── F-25: slug races and the last-workspace lockout ─────────────────────

  describe('[F-25] workspace creation and deletion edge cases', () => {
    it('concurrent creations of the same name all succeed with distinct slugs (no 500)', async () => {
      const people = await seed({ a: 'member', b: 'member', c: 'member', d: 'member' });
      const name = `Race ${Date.now()}`;
      const results = await Promise.all(
        Object.values(people.users).map((user) => call(user, 'POST', '/workspaces', { name })),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      const slugs = results.map((r) => r.body.slug as string);
      expect(new Set(slugs).size).toBe(4);
    });

    it('a slug that is taken while a creation is in flight is retried, not surfaced as an error', async () => {
      // Deterministic: the slug is inserted by another transaction that commits only after
      // this creation has already found it "free".
      const { users } = await seed({ a: 'member' });
      const slug = `held-${Date.now()}`;
      let release!: () => void;
      const mayCommit = new Promise<void>((resolve) => (release = resolve));
      let inserted!: () => void;
      const rowInserted = new Promise<void>((resolve) => (inserted = resolve));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.workspace.create({ data: { id: `ws_${slug}`, name: 'Holder', slug } });
          inserted();
          await mayCommit;
        },
        { timeout: 20_000 },
      );
      await rowInserted;
      const creating = call(users.a!, 'POST', '/workspaces', { name: 'Mine', slug });
      // The creation's insert is now waiting on the uncommitted row's unique index entry.
      for (let i = 0; i < 2_000; i += 1) {
        const waiting = await prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (Number(waiting[0]?.n ?? 0) > 0) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      release();
      await holder;
      const res = await creating;
      expect(res.status).toBe(201);
      expect(res.body.slug).not.toBe(slug);
      expect(String(res.body.slug).startsWith(slug)).toBe(true);
    });

    it('renaming to a slug that is taken is a typed error, not a 500', async () => {
      const a = await seed({ owner: 'owner' });
      const b = await seed({ owner: 'owner' });
      await prisma.workspace.update({
        where: { id: b.ws },
        data: { slug: `taken-slug-f25-${run}` },
      });
      const taken = await call(a.users.owner!, 'PATCH', `/workspaces/${a.ws}`, {
        slug: `taken-slug-f25-${run}`,
      });
      // The existing typed "slug is taken" answer (not a raw database error / 500).
      expect(taken.status).toBe(400);
      expect(taken.body).toMatchObject({
        code: 'WORKSPACE_LIMIT_REACHED',
        message: 'Workspace slug is already taken.',
      });
    });
  });
});
