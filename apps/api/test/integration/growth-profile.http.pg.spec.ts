/**
 * Growth profile, marketing consent and signup attribution — PostgreSQL + real HTTP.
 *
 * Real: AuthController/AuthService (register/login), SettingsController + GrowthProfileService,
 * ValidationPipe (main.ts options), exception filter, RateLimitGuard (in-memory counter).
 * Stubbed: JWT guard on settings routes (x-test-user), unrelated settings services, email.
 */
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { MARKETING_CONSENT_VERSION, type UserGrowthProfile } from '@project-x/types';
import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthController } from '../../src/auth/auth.controller';
import { AuthService } from '../../src/auth/auth.service';
import { JwtAuthGuard } from '../../src/auth/jwt-auth.guard';
import { PasswordResetService } from '../../src/auth/password-reset.service';
import { RateLimitGuard } from '../../src/common/security/rate-limit.guard';
import { JiraConnectionService } from '../../src/jira/jira-connection.service';
import { ObservabilityExceptionFilter } from '../../src/observability/observability-exception.filter';
import { RequestContextMiddleware } from '../../src/observability/request-context.middleware';
import { RequestContextService } from '../../src/observability/request-context.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisService } from '../../src/redis/redis.service';
import { GithubConnectionService } from '../../src/settings/github-connection.service';
import { GrowthProfileService } from '../../src/settings/growth-profile.service';
import { OnboardingService } from '../../src/settings/onboarding.service';
import { SettingsController } from '../../src/settings/settings.controller';
import { SettingsService } from '../../src/settings/settings.service';
import { EmailVerificationService } from '../../src/auth/email-verification.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
const CONFIG: Record<string, unknown> = {
  nodeEnv: 'test',
  appBaseUrl: 'https://app.example.test',
  jwt: { secret: 'it-jwt-secret-0123456789abcdef', expiresIn: '15m', refreshExpiresIn: '7d' },
};
const configGet = (path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined),
      CONFIG,
    );

/** Settings routes: the signed-in user is the x-test-user header (JWT is not under test). */
class TestUserGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { user?: unknown }>();
    const id = req.header('x-test-user');
    if (!id) return false;
    req.user = { id, email: `${id}@it.test`, name: null };
    return true;
  }
}

describe.skipIf(!URL_ENV)('Growth profile, consent and attribution (PostgreSQL + HTTP)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let baseUrl: string;
  const counters = new Map<string, number>();
  let run = 0;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController, SettingsController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: configGet } },
        {
          provide: JwtService,
          useValue: new JwtService({ secret: 'it-jwt-secret-0123456789abcdef' }),
        },
        {
          provide: RedisService,
          useValue: {
            status: 'ready',
            incr: async (k: string) => {
              const n = (counters.get(k) ?? 0) + 1;
              counters.set(k, n);
              return n;
            },
            expire: async () => 1,
          },
        },
        { provide: PasswordResetService, useValue: { requestReset: () => undefined } },
        {
          provide: EmailVerificationService,
          useValue: {
            issueInBackground: () => undefined,
            issue: async () => 'sent',
            status: async () => ({ verified: false }),
          },
        },
        { provide: SettingsService, useValue: {} },
        { provide: GithubConnectionService, useValue: {} },
        { provide: JiraConnectionService, useValue: {} },
        { provide: OnboardingService, useValue: {} },
        AuthService,
        GrowthProfileService,
        RateLimitGuard,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestUserGuard)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    const requestContext = new RequestContextService();
    const middleware = new RequestContextMiddleware(
      requestContext,
      { shouldSample: () => false } as never,
      { get: () => undefined } as never,
    );
    app.use((req: Request, res: Response, next: NextFunction) => middleware.use(req, res, next));
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

  beforeEach(() => counters.clear());

  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  }

  async function register(
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    run += 1;
    const email = `growth_${run}_${Date.now()}@it.test`;
    const res = await call(
      'POST',
      '/auth/register',
      { email, password: 'password-123', ...extra },
      headers,
    );
    counters.clear();
    const user = res.status === 201 ? await prisma.user.findUnique({ where: { email } }) : null;
    return { res, email, user };
  }

  const profileOf = async (userId: string) =>
    (await call('GET', '/settings/profile', undefined, { 'x-test-user': userId }))
      .body as unknown as UserGrowthProfile;

  // ── registration ─────────────────────────────────────────────────────────

  it('plain registration still works: no consent, direct attribution, workspace created', async () => {
    const { res, user } = await register();
    expect(res.status).toBe(201);
    const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: user!.id } });
    expect(settings.marketingEmailConsent).toBe(false);
    expect(settings.marketingConsentUpdatedAt).toBeNull();
    expect(await prisma.marketingConsentEvent.count({ where: { userId: user!.id } })).toBe(0);
    expect(await prisma.userAcquisition.findUnique({ where: { userId: user!.id } })).toMatchObject({
      signupClient: 'dashboard',
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      utmContent: null,
      referral: null,
      referrerHost: null,
    });
    // Workspace bootstrap unchanged.
    expect(
      await prisma.workspaceMembership.count({ where: { userId: user!.id, role: 'owner' } }),
    ).toBe(1);
  });

  it('explicit consent is stored with evidence; attribution is sanitized, never blocks signup', async () => {
    const { res, user } = await register({
      marketingConsent: true,
      attribution: {
        utmSource: 'newsletter',
        utmMedium: 'email',
        utmCampaign: 'internationalization_launch_2026',
        utmContent: 'someone@example.com', // email → dropped
        referral: 'Q3vX9kL0pZ_t7Rm2YwBn4Hc8Jd1Fs6Ge5Ka0Pq9Xz2', // token-like → dropped
        referrerHost: 'https://evil.example/?token=1', // full URL → dropped
        password: 'leak', // unknown key → ignored
        nested: { deep: 'x'.repeat(5000) },
      },
    });
    expect(res.status).toBe(201);
    const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: user!.id } });
    expect(settings.marketingEmailConsent).toBe(true);
    const events = await prisma.marketingConsentEvent.findMany({ where: { userId: user!.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      granted: true,
      source: 'dashboard_signup',
      policyVersion: MARKETING_CONSENT_VERSION,
    });
    const acquisition = await prisma.userAcquisition.findUniqueOrThrow({
      where: { userId: user!.id },
    });
    expect(acquisition).toMatchObject({
      utmSource: 'newsletter',
      utmMedium: 'email',
      utmCampaign: 'internationalization_launch_2026',
      utmContent: null,
      referral: null,
      referrerHost: null,
    });
    expect(JSON.stringify(acquisition)).not.toMatch(/someone@example|leak|Q3vX9kL0/);
  });

  it('extension registrations are labelled as such (consent source + attribution client)', async () => {
    const { res, user } = await register(
      { marketingConsent: true },
      { 'x-project-x-client': 'extension' },
    );
    expect(res.status).toBe(201);
    expect(
      (await prisma.userAcquisition.findUniqueOrThrow({ where: { userId: user!.id } }))
        .signupClient,
    ).toBe('extension');
    expect(
      (await prisma.marketingConsentEvent.findFirstOrThrow({ where: { userId: user!.id } })).source,
    ).toBe('extension_signup');
  });

  it('only a real boolean counts as consent; false or absent records nothing', async () => {
    const declined = await register({ marketingConsent: false });
    expect(declined.res.status).toBe(201);
    expect(await prisma.marketingConsentEvent.count({ where: { userId: declined.user!.id } })).toBe(
      0,
    );
    for (const value of ['true', 1, 'yes']) {
      expect((await register({ marketingConsent: value })).res.status).toBe(400);
    }
    expect((await register({ attribution: 'google' })).res.status).toBe(400); // must be an object
  });

  it('login and first-touch attribution are unaffected by later activity', async () => {
    const { email, user } = await register({ attribution: { utmSource: 'first' } });
    const before = await prisma.userAcquisition.findUniqueOrThrow({ where: { userId: user!.id } });
    expect((await call('POST', '/auth/login', { email, password: 'password-123' })).status).toBe(
      200,
    );
    expect(await prisma.userAcquisition.findUniqueOrThrow({ where: { userId: user!.id } })).toEqual(
      before,
    );
  });

  // ── profile ──────────────────────────────────────────────────────────────

  it('profile: defaults, partial updates, clearing, completion recorded once', async () => {
    const { user } = await register();
    const id = user!.id;
    expect(await profileOf(id)).toMatchObject({
      professionalRole: null,
      usageIntent: null,
      primaryGoal: null,
      profileCompletedAt: null,
      profileSkippedAt: null,
      marketingEmailConsent: false,
    });
    const first = await call(
      'PATCH',
      '/settings/profile',
      { professionalRole: 'tech_lead' },
      { 'x-test-user': id },
    );
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ professionalRole: 'tech_lead', usageIntent: null });
    const completedAt = first.body.profileCompletedAt;
    expect(completedAt).toBeTruthy();
    const second = await call(
      'PATCH',
      '/settings/profile',
      { usageIntent: 'team', primaryGoal: 'faster_reviews' },
      { 'x-test-user': id },
    );
    expect(second.body).toMatchObject({
      professionalRole: 'tech_lead', // untouched
      usageIntent: 'team',
      primaryGoal: 'faster_reviews',
      profileCompletedAt: completedAt, // not moved
    });
    const cleared = await call(
      'PATCH',
      '/settings/profile',
      { professionalRole: null },
      { 'x-test-user': id },
    );
    expect(cleared.body.professionalRole).toBeNull();
    expect(cleared.body.usageIntent).toBe('team');
  });

  it('profile: invalid values and unknown fields are rejected', async () => {
    const { user } = await register();
    const id = user!.id;
    for (const body of [
      { professionalRole: 'admin' }, // a workspace role is not a professional role
      { professionalRole: 'owner' },
      { usageIntent: 'enterprise' },
      { primaryGoal: '' },
      { professionalRole: 7 },
      { companyName: 'Acme' },
      { phone: '+1 555' },
    ]) {
      expect(
        (await call('PATCH', '/settings/profile', body, { 'x-test-user': id })).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect((await profileOf(id)).professionalRole).toBeNull();
    // Workspace role untouched.
    expect(
      (await prisma.workspaceMembership.findFirstOrThrow({ where: { userId: id } })).role,
    ).toBe('owner');
  });

  it('skip is remembered; it never overrides answers already saved', async () => {
    const skipper = await register();
    const skipped = await call('POST', '/settings/profile/skip', undefined, {
      'x-test-user': skipper.user!.id,
    });
    expect(skipped.status).toBe(200);
    expect(skipped.body.profileSkippedAt).toBeTruthy();
    const answered = await register();
    await call(
      'PATCH',
      '/settings/profile',
      { primaryGoal: 'just_exploring' },
      { 'x-test-user': answered.user!.id },
    );
    const after = await call('POST', '/settings/profile/skip', undefined, {
      'x-test-user': answered.user!.id,
    });
    expect(after.body.profileSkippedAt).toBeNull();
    expect(after.body.primaryGoal).toBe('just_exploring');
  });

  it('users can only change their own profile and consent; unauthenticated requests fail', async () => {
    const a = await register();
    const b = await register();
    await call(
      'PATCH',
      '/settings/profile',
      { professionalRole: 'qa_engineer' },
      { 'x-test-user': a.user!.id },
    );
    await call(
      'PUT',
      '/settings/marketing-consent',
      { granted: true },
      { 'x-test-user': a.user!.id },
    );
    expect(await profileOf(b.user!.id)).toMatchObject({
      professionalRole: null,
      marketingEmailConsent: false,
    });
    // There is no user id in any route or body: a foreign id in the body is rejected.
    expect(
      (
        await call(
          'PATCH',
          '/settings/profile',
          { userId: b.user!.id, professionalRole: 'other' },
          { 'x-test-user': a.user!.id },
        )
      ).status,
    ).toBe(400);
    expect((await call('GET', '/settings/profile')).status).toBe(403);
    expect((await call('PUT', '/settings/marketing-consent', { granted: true })).status).toBe(403);
  });

  it('existing users without a settings row still work', async () => {
    const { user } = await register();
    await prisma.userSettings.delete({ where: { userId: user!.id } });
    expect(await profileOf(user!.id)).toMatchObject({
      marketingEmailConsent: false,
      professionalRole: null,
    });
  });

  // ── consent ──────────────────────────────────────────────────────────────

  it('consent: grant and withdraw persist with an evidence row per change only', async () => {
    const { user } = await register();
    const id = user!.id;
    const set = (granted: unknown) =>
      call('PUT', '/settings/marketing-consent', { granted }, { 'x-test-user': id });
    expect((await set(true)).body.marketingEmailConsent).toBe(true);
    expect((await set(true)).body.marketingEmailConsent).toBe(true); // no-op
    expect((await set(false)).body.marketingEmailConsent).toBe(false); // withdrawal
    expect((await profileOf(id)).marketingEmailConsent).toBe(false);
    const events = await prisma.marketingConsentEvent.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => [e.granted, e.source, e.policyVersion])).toEqual([
      [true, 'settings', MARKETING_CONSENT_VERSION],
      [false, 'settings', MARKETING_CONSENT_VERSION],
    ]);
    for (const bad of ['true', 1, null, undefined]) {
      expect((await set(bad)).status).toBe(400);
    }
  });
});
