/**
 * M6 — nothing recognizable as a credential reaches the AI provider, on every AI path:
 * Review Entire PR (diff, PR title/body, Project Memory), selected-code actions with page
 * context, streamed actions, workflow AI steps (incl. executions created by Resume / Replay).
 * The AI SDK is mocked (`generateText` / `streamText` capture what would be sent); real
 * AiService, usage accounting, reliability audit and PostgreSQL. Secrets are synthetic.
 */
import { PrismaClient } from '@prisma/client';
import {
  AI_PRIVATE_KEY_PLACEHOLDER,
  AI_SECRET_PLACEHOLDER,
  usagePeriodKey,
} from '@project-x/shared';
import { AIAction } from '@project-x/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiService } from '../../src/ai/ai.service';
import { makeFile } from '../../src/ai/pr-review/pr-review-fixtures';
import { PrReviewOrchestrator } from '../../src/ai/pr-review/pr-review-orchestrator.service';
import { PR_REVIEW_VERIFY_INSTRUCTIONS } from '../../src/ai/pr-review/pr-review-verify';
import { PromptRegistry } from '../../src/ai/prompts/prompt.registry';
import { EntitlementService } from '../../src/entitlements/entitlements.service';
import { FeatureGate } from '../../src/entitlements/feature-gate';
import { RequestContextService } from '../../src/observability/request-context.service';
import { ReliabilityService } from '../../src/reliability/reliability.service';
import { UsageService } from '../../src/usage/usage.service';

const generateTextMock = vi.fn();
const streamTextMock = vi.fn();
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: (...a: unknown[]) => generateTextMock(...a),
    streamText: (...a: unknown[]) => streamTextMock(...a),
  };
});

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;

// Synthetic, assembled at runtime (no realistic secret literal in the repository).
const SECRETS = {
  github: 'gh' + 'p_' + 'Ab1'.repeat(12),
  openai: 's' + 'k-proj-' + 'Gh4'.repeat(10),
  aws: 'AK' + 'IA' + 'ABCDEFGH23456789',
  stripe: 's' + 'k_live_' + 'Ij5'.repeat(8),
  bearer: 'Op8'.repeat(10),
  dbPassword: 'Synthetic-Pass-2026',
  memory: 'xo' + 'xb-' + '123456789012-' + 'Mn7'.repeat(8),
  pemBody: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' + 'BKcwggSjAgEAAoIBAQC7'.repeat(2),
};
const ALL = Object.values(SECRETS);

/** Everything the mocked provider received, serialized. */
const sent = (mock: typeof generateTextMock) =>
  mock.mock.calls
    .map((c) => JSON.stringify({ instructions: c[0].instructions, messages: c[0].messages }))
    .join('\n');
function expectClean(payload: string) {
  expect(payload.length).toBeGreaterThan(0);
  for (const secret of ALL) expect(payload).not.toContain(secret);
}

describe.skipIf(!URL_ENV)('Secret redaction before AI providers (PostgreSQL, mocked AI)', () => {
  let prisma: PrismaClient;
  let reliability: ReliabilityService;
  const ctx = new RequestContextService();
  const diff = {
    resolve: vi.fn(),
    createFileProvider: vi.fn(
      (): ((path: string) => Promise<string | null>) | undefined => undefined,
    ),
  };
  const memory = { resolvePromptContext: vi.fn() };
  let run = 0;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();
    reliability = new ReliabilityService(prisma as never);
  });
  afterAll(async () => prisma?.$disconnect());

  beforeEach(() => {
    generateTextMock.mockReset().mockImplementation(async (args: { output?: unknown }) =>
      args.output
        ? {
            output: { summary: 'ok', findings: [] },
            finishReason: 'stop',
            usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
          }
        : {
            text: 'Looks fine.',
            finishReason: 'stop',
            usage: { inputTokens: 100, outputTokens: 10 },
          },
    );
    streamTextMock.mockReset().mockImplementation(() => {
      throw new Error('stream not simulated'); // only the request matters here
    });
    diff.resolve.mockReset();
    diff.createFileProvider.mockReset().mockReturnValue(undefined);
    memory.resolvePromptContext.mockReset().mockResolvedValue({
      status: 'applied',
      version: 'pmv-test',
      rules: [],
      diagnostics: {},
      // The real service wraps memory in the trusted server marker (project-memory.service.ts).
      block: [
        '<<PROJECT_MEMORY source="server" version="pmv-test">>',
        `Team rule: use the CI token ${SECRETS.memory} only in the deploy job.`,
        '<</PROJECT_MEMORY>>',
      ].join('\n'),
    });
  });

  function service() {
    const modelFactory = {
      getDefaultModel: () => 'm',
      getProviderName: () => 'openai',
      getModelName: () => 'm',
    };
    const obs = {
      createOperationId: () => 'op',
      recordStreamSuccess: vi.fn(),
      recordStreamFailure: vi.fn(),
      observeGenerate: async ({
        call,
      }: {
        call: () => Promise<{
          result: unknown;
          usageRaw?: { inputTokens?: number; outputTokens?: number };
        }>;
      }) => {
        const r = await call();
        return {
          result: r.result,
          observation: {
            usage: { inputTokens: r.usageRaw?.inputTokens, outputTokens: r.usageRaw?.outputTokens },
            cost: {},
            durationMs: 1,
          },
        };
      },
    };
    const health = { recordSignal: vi.fn() };
    const entitlements = new EntitlementService(prisma as never);
    return new AiService(
      new PromptRegistry(),
      modelFactory as never,
      {
        get: () => ({
          requestTimeoutMs: 1_000,
          maxInputCharacters: 20_000,
          prReview: {
            maxOutputTokens: 2_000,
            requestTimeoutMs: 30_000,
            maxBatches: 6,
            concurrency: 3,
            batchInputTokens: 16_000,
            maxInputTokens: 96_000,
            maxTotalOutputTokens: 12_000,
            reviewTimeoutMs: 60_000,
          },
        }),
      } as never,
      {
        getForUser: vi.fn(async () => ({
          maxOutputTokens: 600,
          responseStyle: 'CONCISE',
          includePageContext: true,
        })),
      } as never,
      prisma as never,
      new FeatureGate(entitlements),
      new UsageService(prisma as never, entitlements),
      obs as never,
      { get: () => ({}), patch: vi.fn() } as never,
      health as never,
      reliability,
      memory as never,
      diff as never,
      new PrReviewOrchestrator(modelFactory as never, obs as never, health as never),
    );
  }

  async function workspace() {
    run += 1;
    const ws = `ws_m6_${run}_${Date.now()}`;
    const user = `m6_user_${run}_${Date.now()}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.workspaceSubscription.create({
      data: { workspaceId: ws, provider: 'paddle', planId: 'team', status: 'active' },
    });
    await prisma.user.create({
      data: { id: user, email: `${user}@it.test`, passwordHash: 'x', lastWorkspaceId: ws },
    });
    await prisma.workspaceMembership.create({
      data: { workspaceId: ws, userId: user, role: 'owner', status: 'active' },
    });
    return { ws, user };
  }
  const usageUnits = async (ws: string) =>
    (
      await prisma.workspaceUsageCounter.findMany({
        where: { workspaceId: ws, periodKey: usagePeriodKey() },
      })
    ).reduce((n, r) => n + r.count, 0);
  const as = <T>(ws: string, fn: () => Promise<T>) => ctx.run({ workspaceId: ws } as never, fn);

  const githubContext = (extra: Record<string, unknown> = {}) => ({
    type: 'github',
    url: 'https://github.com/acme/app/pull/7',
    title: 'PR',
    surroundingText: `deploy uses Authorization: Bearer ${SECRETS.bearer}`,
    github: {
      owner: 'acme',
      repository: 'app',
      pullRequestNumber: 7,
      pullRequestTitle: `Rotate ${SECRETS.aws}`,
      pullRequestBody: `Old key was ${SECRETS.stripe}, db postgres://app:${SECRETS.dbPassword}@db:5432/x`,
      ...extra,
    },
  });

  it('Review Entire PR: diff (added, removed, context, PEM), PR title/body and memory are redacted', async () => {
    const { ws, user } = await workspace();
    const patch = [
      '@@ -1,6 +1,9 @@ export const config = {',
      `-  githubToken: "${SECRETS.github}",`,
      '+  githubToken: process.env.GITHUB_TOKEN,',
      `   openaiKey: "${SECRETS.openai}",`,
      '+-----BEGIN PRIVATE KEY-----',
      `+${SECRETS.pemBody}`,
      '+-----END PRIVATE KEY-----',
      '   users: await listUsers(),',
    ].join('\n');
    diff.resolve.mockResolvedValue({
      source: 'github_api',
      files: [makeFile('src/config.ts', patch)],
      totalFiles: 1,
      pullRequestTitle: `Rotate ${SECRETS.aws}`,
    });
    const result = await service().generateActionWithMetadata(user, {
      action: AIAction.REVIEW_ENTIRE_PR,
      text: 'Review this PR.',
      context: githubContext(),
    } as never);

    const payload = sent(generateTextMock);
    expectClean(payload);
    expect(payload).toContain(AI_SECRET_PLACEHOLDER);
    expect(payload).toContain(AI_PRIVATE_KEY_PLACEHOLDER);
    expect(payload).toContain('-----BEGIN PRIVATE KEY-----'); // structure kept
    expect(payload).toContain('process.env.GITHUB_TOKEN'); // ordinary code kept
    expect(payload).toContain('@@ -1,6 +1,9 @@');
    // The source diff itself (non-AI uses) is untouched.
    await expect(diff.resolve.mock.results[0]!.value).resolves.toBeTruthy();
    expect((await diff.resolve.mock.results[0]!.value).files[0].patch).toContain(SECRETS.github);
    expect(result.text).toContain('## Summary');
    expect(await usageUnits(ws)).toBe(1); // accounting unchanged
  });

  it('selected code with page context (non-streamed action) is redacted', async () => {
    const { ws, user } = await workspace();
    await as(ws, () =>
      service().generateActionWithMetadata(user, {
        action: AIAction.REVIEW_CODE,
        text: `const client = new Stripe("${SECRETS.stripe}");\nconst key = "${SECRETS.openai}";`,
        context: githubContext({ filePath: 'src/pay.ts' }),
      } as never),
    );
    const payload = sent(generateTextMock);
    expectClean(payload);
    expect(payload).toContain('new Stripe(');
    expect(await usageUnits(ws)).toBe(1);
  });

  it('workflow AI step (streamed, with Project Memory and an execution) is redacted; audit keeps no secret', async () => {
    const { ws, user } = await workspace();
    const execution = await as(ws, () =>
      reliability.startExecution(user, { workflowId: 'wf_m6', goal: 'Fix CI' }),
    );
    // Executions created by Resume and Replay run their AI steps through the same path.
    await as(ws, () => reliability.completeExecution(user, execution.id, { status: 'failed' }));
    await as(ws, () =>
      reliability
        .createCheckpoint(user, execution.id, { kind: 'PLANNING_COMPLETE', label: 'p' })
        .catch(() => undefined),
    );
    const replay = await as(ws, () => reliability.replayExecution(user, execution.id, {}));

    for (const executionId of [execution.id, replay.id]) {
      streamTextMock.mockClear();
      const response = {
        statusCode: 0,
        setHeader: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
        flushHeaders: vi.fn(),
      };
      await as(ws, () =>
        service()
          .pipeActionStream(
            user,
            {
              action: AIAction.SUGGEST_FIX,
              text: `export AWS_KEY=${SECRETS.aws}\nexport DB_PASSWORD=${SECRETS.dbPassword}`,
              memoryRepository: 'acme/app',
              executionId,
              context: githubContext(),
            } as never,
            response as never,
          )
          .catch(() => undefined),
      );
      expect(streamTextMock).toHaveBeenCalledTimes(1);
      const payload = sent(streamTextMock);
      expectClean(payload);
      expect(payload).toContain('Team rule: use the CI token'); // memory present, secret gone
      expect(payload).toContain('export AWS_KEY=');
    }
    expect(memory.resolvePromptContext).toHaveBeenCalled();
    const audits = await prisma.workflowExecution.findMany({
      where: { id: { in: [execution.id, replay.id] } },
    });
    const snapshots = await prisma.promptSnapshot.findMany({ where: { workspaceId: ws } });
    expectClean(JSON.stringify(audits) + JSON.stringify(snapshots));
  });

  it('Project Memory secrets are redacted on the PR path too, and trusted-memory markers survive', async () => {
    const { user } = await workspace();
    diff.resolve.mockResolvedValue({
      source: 'github_api',
      files: [makeFile('src/a.ts', '@@ -1 +1 @@\n-a()\n+b()')],
      totalFiles: 1,
    });
    await service().generateActionWithMetadata(user, {
      action: AIAction.REVIEW_ENTIRE_PR,
      text: 'Review this PR.',
      context: githubContext(),
    } as never);
    const payload = sent(generateTextMock);
    expectClean(payload);
    expect(payload).toContain('Team rule: use the CI token');
    // The trusted server marker survives redaction (placeholders never create or break it).
    expect(payload).toContain('<<PROJECT_MEMORY source=\\"server\\" version=\\"pmv-test\\">>');
  });

  it('N-7: file content fetched for context and verification (line-numbered) never leaks a key', async () => {
    const { user } = await workspace();
    // Head file: the key sits inside the function whose line the PR changes (line 11), so it
    // is part of the enclosing-code context block and of the verifier's HEAD window.
    const keyLines = [...SECRETS.pemBody.match(/.{1,40}/g)!, 'AB12cd=='];
    const headFile = [
      'import { load } from "./keys";',
      'export function sign(payload: string) {',
      '  const PRIVATE = `',
      '-----BEGIN RSA PRIVATE KEY-----',
      ...keyLines,
      '-----END RSA PRIVATE KEY-----',
      '`;',
      '  return load(PRIVATE).sign(payload, { alg: "RS256" });',
      '}',
    ].join('\n');
    const changedLine =
      headFile.split('\n').indexOf('  return load(PRIVATE).sign(payload, { alg: "RS256" });') + 1;
    expect(changedLine).toBeGreaterThan(5);
    const fetched: string[] = [];
    diff.createFileProvider.mockReturnValue(async (path: string) => {
      fetched.push(path);
      return path === 'src/sign.ts' ? headFile : null;
    });
    diff.resolve.mockResolvedValue({
      source: 'github_api',
      headSha: 'a'.repeat(40),
      files: [
        makeFile(
          'src/sign.ts',
          `@@ -${changedLine - 1},3 +${changedLine - 1},3 @@\n \`;\n-  return load(PRIVATE).sign(payload);\n+  return load(PRIVATE).sign(payload, { alg: "RS256" });\n }`,
        ),
      ],
      totalFiles: 1,
    });
    // The batch reports a finding next to the key, so verification (head window) runs too.
    generateTextMock.mockImplementation(
      async (args: { output?: unknown; instructions?: string }) =>
        args.output && args.instructions !== PR_REVIEW_VERIFY_INSTRUCTIONS
          ? {
              output: {
                summary: 'ok',
                findings: [
                  {
                    path: 'src/sign.ts',
                    lineStart: changedLine,
                    lineEnd: changedLine,
                    category: 'security',
                    severity: 'high',
                    confidence: 'high',
                    title: 'Signing key embedded in source',
                    explanation: 'The private key is committed next to the signer.',
                    evidence: '  return load(PRIVATE).sign(payload, { alg: "RS256" });',
                    trigger: 'Anyone with repository read access',
                    failurePath: `sign() at src/sign.ts:${changedLine} uses the embedded key`,
                    violatedInvariant: 'Keys are never committed',
                    impact: 'Token forgery',
                    assumptions: '',
                    missingContext: '',
                    changeType: 'introduced',
                  },
                ],
              },
              finishReason: 'stop',
              usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
            }
          : args.output
            ? {
                output: {
                  verdict: 'insufficient_context',
                  severity: 'low',
                  reasoning: 'n/a',
                  decisiveCode: '',
                  failureSite: '',
                  dependsOnCodeNotShown: true,
                  reachableTrigger: '',
                  violatedInvariant: '',
                  triggerSource: '',
                  guardsOnPath: [],
                },
                finishReason: 'stop',
                usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 },
              }
            : { text: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    );
    await service().generateActionWithMetadata(user, {
      action: AIAction.REVIEW_ENTIRE_PR,
      text: 'Review this PR.',
      context: githubContext(),
    } as never);

    expect(fetched).toContain('src/sign.ts'); // the provider was really used
    const calls = generateTextMock.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(calls.length).toBeGreaterThanOrEqual(2); // batch + verification
    const payload = calls.join('\n');
    for (const chunk of keyLines) expect(payload).not.toContain(chunk);
    expect(payload).toContain(AI_PRIVATE_KEY_PLACEHOLDER);
    // Both the batch context block and the verifier HEAD window carried the (redacted) key.
    const batch = calls.find((c) => !c.includes('independently verify'))!;
    const verify = calls.find((c) => c.includes('independently verify'))!;
    expect(batch).toMatch(/\d+: \[REDACTED_PRIVATE_KEY\]/);
    expect(verify).toMatch(/HEAD +\d+ \| \[REDACTED_PRIVATE_KEY\]/);
    expect(payload).toContain('return load(PRIVATE).sign(payload'); // code kept
  });
});
