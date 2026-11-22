/**
 * N-1 — the header-less workspace fallback must never hand out a workspace the user does not
 * (or no longer) belong to. Reproduces the audited attack against real PostgreSQL:
 *
 *   U registers (personal workspace `ws_${U}`), transfers ownership of it to V, and is then
 *   removed. U owns nothing else and their `lastWorkspaceId` still points at `ws_${U}`.
 *   Before the fix every header-less entry point resolved `ws_${U}` (now V's workspace): U
 *   could spend V's AI quota, mint V's GitHub App token and write workflow rows there.
 *
 * Real: PostgreSQL, resolveWorkspaceIdForUser, WorkspacesService.transferOwnership,
 * WorkspaceMembersService.removeMember, ReliabilityController + ReliabilityService over HTTP,
 * AiService (resolveRun), GithubAccessService, WorkspaceAuthorizationService.
 * Stubbed: JWT (`x-test-user`), the AI model (never reached), App token minting (spied, must
 * never be called), PAT storage, GitHub (never reached), usage (spied, must never reserve).
 */
import { Test } from '@nestjs/testing';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AIAction } from '@project-x/types';
import { PromptRegistry } from '../../src/ai/prompts/prompt.registry';
import { AiService } from '../../src/ai/ai.service';
import { JwtAuthGuard } from '../../src/auth/jwt-auth.guard';
import { RateLimitGuard } from '../../src/common/security/rate-limit.guard';
import { EntitlementService } from '../../src/entitlements/entitlements.service';
import { GithubAccessService } from '../../src/github-app/github-access.service';
import { ObservabilityExceptionFilter } from '../../src/observability/observability-exception.filter';
import { RequestContextMiddleware } from '../../src/observability/request-context.middleware';
import { RequestContextService } from '../../src/observability/request-context.service';
import { ReliabilityController } from '../../src/reliability/reliability.controller';
import { ReliabilityService } from '../../src/reliability/reliability.service';
import { UsageService } from '../../src/usage/usage.service';
import { WorkspaceMembersService } from '../../src/workspaces/members.service';
import { resolveWorkspaceIdForUser } from '../../src/workspaces/resolve-workspace-id';
import { WorkspaceAuthorizationService } from '../../src/workspaces/workspace-authorization.service';
import { WorkspacesService } from '../../src/workspaces/workspaces.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
type Res = { status: number; body: Record<string, unknown> & { code?: string } };

describe.skipIf(!URL_ENV)('N-1: header-less workspace fallback (PostgreSQL + HTTP)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let baseUrl: string;
  let access: GithubAccessService;
  let ai: AiService;
  let workspaces: WorkspacesService;
  let members: WorkspaceMembersService;
  const requestContext = new RequestContextService();
  const mint = vi.fn(async (id: string) => `ghs_inst_${id}`);
  const reserve = vi.fn();
  let run = 0;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();

    const authorization = new WorkspaceAuthorizationService(prisma as never);
    const entitlements = new EntitlementService(prisma as never);
    workspaces = new WorkspacesService(
      prisma as never,
      authorization,
      entitlements,
      new UsageService(prisma as never, entitlements),
    );
    members = new WorkspaceMembersService(prisma as never, authorization);
    access = new GithubAccessService(
      prisma as never,
      requestContext,
      { isAppAuthEnabled: () => true, mintInstallationAccessToken: mint } as never,
      {
        getActiveInstallationId: async (workspaceId: string) =>
          (
            await prisma.gitHubAppInstallation.findFirst({
              where: { workspaceId, status: 'active' },
            })
          )?.installationId ?? null,
      } as never,
      {
        getDecryptedToken: async () => 'ghp_former_owner',
        getConnectionVersion: async () => 'v',
      } as never,
    );
    ai = new AiService(
      new PromptRegistry(),
      {
        getDefaultModel: vi.fn(),
        getProviderName: () => 'openai',
        getModelName: () => 'm',
      } as never,
      {
        get: (key: string) =>
          key === 'ai'
            ? { maxOutputTokens: 1000, requestTimeoutMs: 30_000, maxInputCharacters: 20_000 }
            : undefined,
      } as never,
      {
        getForUser: async () => ({
          maxOutputTokens: 600,
          responseStyle: 'CONCISE',
          includePageContext: true,
        }),
      } as never,
      prisma as never,
      { require: async () => undefined, assert: async () => undefined } as never,
      { reserve, startHeartbeat: () => () => undefined } as never,
      {} as never,
      requestContext,
      { recordSignal: vi.fn() } as never,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [ReliabilityController],
      providers: [
        { provide: ReliabilityService, useValue: new ReliabilityService(prisma as never) },
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
    const ctxMiddleware = new RequestContextMiddleware(
      requestContext,
      { shouldSample: () => false } as never,
      { get: () => undefined } as never,
    );
    app.use((req: Request, res: Response, next: NextFunction) => ctxMiddleware.use(req, res, next));
    app.useGlobalFilters(new ObservabilityExceptionFilter(requestContext));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  async function call(user: string, method: string, path: string, body?: unknown): Promise<Res> {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': user },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  }

  /** U's personal workspace transferred to V; U removed; App installed on it. */
  async function transferredAndRemoved() {
    run += 1;
    const tag = `${run}_${Date.now()}`;
    const u = `fb_u_${tag}`;
    const v = `fb_v_${tag}`;
    const ws = `ws_${u}`; // the personal-workspace convention (auth.service registration)
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.workspaceSubscription.create({
      data: { workspaceId: ws, provider: 'paddle', planId: 'team', status: 'active' },
    });
    for (const id of [u, v]) {
      await prisma.user.create({
        data: { id, email: `${id}@it.test`, passwordHash: 'x', lastWorkspaceId: ws },
      });
    }
    await prisma.workspaceMembership.create({
      data: { workspaceId: ws, userId: u, role: 'owner', status: 'active' },
    });
    const vMembership = await prisma.workspaceMembership.create({
      data: { workspaceId: ws, userId: v, role: 'member', status: 'active' },
    });
    await prisma.gitHubAppInstallation.create({
      data: {
        workspaceId: ws,
        installationId: `7${run}${Date.now() % 100000}`,
        accountLogin: 'acme',
        accountType: 'Organization',
        status: 'active',
      },
    });
    // The real product flows: U transfers ownership to V, V removes U.
    await workspaces.transferOwnership(ws, u, { membershipId: vMembership.id });
    const uMembership = await prisma.workspaceMembership.findFirstOrThrow({
      where: { workspaceId: ws, userId: u },
    });
    await members.removeMember(ws, v, uMembership.id);
    expect(
      (await prisma.workspaceMembership.findUniqueOrThrow({ where: { id: uMembership.id } }))
        .status,
    ).toBe('removed');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u } })).lastWorkspaceId).toBe(ws);
    return { u, v, ws };
  }

  const denied = (p: Promise<unknown>) =>
    expect(p).rejects.toMatchObject({ response: { code: 'WORKSPACE_CONTEXT_UNAVAILABLE' } });

  it('the resolver refuses the transferred workspace (no header, no explicit id)', async () => {
    const { u, v, ws } = await transferredAndRemoved();
    await denied(resolveWorkspaceIdForUser(prisma as never, u));
    // V (the new owner) is unaffected.
    await expect(resolveWorkspaceIdForUser(prisma as never, v)).resolves.toBe(ws);
  });

  it('GitHub: the former owner cannot mint the workspace App token', async () => {
    const { u } = await transferredAndRemoved();
    mint.mockClear();
    await denied(
      access.resolveRepositoryAccess(u, { owner: 'acme', repository: 'api', access: 'read' }),
    );
    expect(mint).not.toHaveBeenCalled();
  });

  it('AI: no workspace is resolved, no quota is reserved, no model is called', async () => {
    const { u } = await transferredAndRemoved();
    reserve.mockClear();
    await denied(ai.generateAction(u, { action: AIAction.EXPLAIN, text: 'hello' } as never));
    expect(reserve).not.toHaveBeenCalled();
  });

  it('Reliability over HTTP: list/start/events are refused and nothing is written', async () => {
    const { u, ws } = await transferredAndRemoved();
    for (const [method, path, body] of [
      ['GET', '/reliability/executions'],
      ['POST', '/reliability/executions', { workflowId: 'wf', goal: 'g' }],
      ['POST', '/reliability/executions/exec_x/events', { type: 'WORKFLOW_STARTED' }],
    ] as const) {
      const res = await call(u, method, path, body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('WORKSPACE_CONTEXT_UNAVAILABLE');
    }
    expect(await prisma.workflowExecution.count({ where: { workspaceId: ws, userId: u } })).toBe(0);
  });

  it('a deleted or deletion_pending personal workspace is never resolved either', async () => {
    for (const status of ['deleted', 'deletion_pending']) {
      run += 1;
      const u = `fb_del_${run}_${Date.now()}`;
      const ws = `ws_${u}`;
      await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws, status } });
      await prisma.user.create({
        data: { id: u, email: `${u}@it.test`, passwordHash: 'x', lastWorkspaceId: ws },
      });
      await prisma.workspaceMembership.create({
        data: { workspaceId: ws, userId: u, role: 'owner', status: 'active' },
      });
      await denied(resolveWorkspaceIdForUser(prisma as never, u));
      expect((await call(u, 'GET', '/reliability/executions')).status).toBe(403);
    }
  });

  it('legitimate personal-workspace use without a header keeps working', async () => {
    run += 1;
    const u = `fb_ok_${run}_${Date.now()}`;
    const ws = `ws_${u}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.user.create({ data: { id: u, email: `${u}@it.test`, passwordHash: 'x' } });
    await prisma.workspaceMembership.create({
      data: { workspaceId: ws, userId: u, role: 'owner', status: 'active' },
    });
    await expect(resolveWorkspaceIdForUser(prisma as never, u)).resolves.toBe(ws);
    const started = await call(u, 'POST', '/reliability/executions', {
      workflowId: 'wf',
      goal: 'g',
    });
    expect(started.status).toBe(201);
    expect((await call(u, 'GET', '/reliability/executions')).body.executions).toHaveLength(1);
  });
});
