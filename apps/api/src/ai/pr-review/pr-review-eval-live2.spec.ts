/**
 * Regression evaluation for live PR Review #2 (GH0ST-000/Ai-Extension PR #48 @ 69e1fc4).
 *
 * The seven candidates the live run produced are rebuilt here as faithful, smaller copies of
 * the PR-head code (same structure: new file, one-line change, deleted function, large files
 * with guards far from the finding, test file). They must never be Reported. Five seeded
 * true positives must be Reported at their real severity.
 *
 * Recorded model outputs are replayed through the real pipeline (planner → validation →
 * severity/PR-relevance gates → finding-centred context → verification → assessment →
 * render). An "adversarial" set measures what the deterministic gates catch when the
 * verifier confidently confirms a false positive with every required field filled in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIAction, type PRReviewCoverage } from '@project-x/types';

import { AiService } from '../ai.service';
import { PromptRegistry } from '../prompts/prompt.registry';
import type { BatchFindingInput } from './pr-review-findings';
import { rawFinding } from './pr-review-fixtures';
import { PrReviewOrchestrator } from './pr-review-orchestrator.service';
import { renderCodeLine } from './pr-review-context';
import { PR_REVIEW_VERIFY_INSTRUCTIONS } from './pr-review-verify';
import { usageStub } from './pr-review-fixtures';

/** Exact rendered code line, as the verifier sees it. */
const line = (tag: 'ADD' | 'CTX' | 'HEAD', n: number, text: string) =>
  renderCodeLine({ tag, n, old: null, text });

const generateTextMock = vi.fn();
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: (...a: unknown[]) => generateTextMock(...a),
    streamText: vi.fn(),
  };
});

// ── fixture builders ───────────────────────────────────────────────────────

type FileSpec = {
  path: string;
  head: string[];
  /** 1-based head line numbers added by the PR (all lines for a new file). */
  added: Set<number> | 'all';
  /** Deleted base lines, placed before the given head line. */
  deleted?: { before: number; text: string }[];
};

function patchOf(f: FileSpec): string {
  const out: string[] = [];
  let oldCount = 0;
  for (let n = 1; n <= f.head.length + 1; n += 1) {
    for (const d of (f.deleted ?? []).filter((x) => x.before === n)) {
      out.push(`-${d.text}`);
      oldCount += 1;
    }
    if (n > f.head.length) break;
    if (f.added === 'all' || f.added.has(n)) out.push(`+${f.head[n - 1]}`);
    else {
      out.push(` ${f.head[n - 1]}`);
      oldCount += 1;
    }
  }
  return `@@ -1,${oldCount} +1,${f.head.length} @@\n${out.join('\n')}`;
}

const filler = (from: number, to: number, tag: string) =>
  Array.from({ length: to - from + 1 }, (_, i) => `  // ${tag} ${from + i}`);

// FP1 — new file: catch-all maps unexpected errors to 'unavailable' (diagnostic only).
const DIFF_SERVICE = 'apps/api/src/ai/pr-review/pull-request-diff.service.ts';
const diffService: FileSpec = {
  path: DIFF_SERVICE,
  added: 'all',
  head: [
    'export class PullRequestDiffService {',
    '  async resolve(input: PullRequestDiffInput): Promise<PullRequestDiffResult> {',
    "    let failure: FetchFailureReason | 'not_a_pr' = 'not_a_pr';",
    '    try {',
    '      return await this.fetchFromGitHub(input);',
    '    } catch (error) {',
    "      failure = error instanceof GitHubDiffFetchError ? error.reason : 'unavailable';",
    '    }',
    '    throw new UnprocessableEntityException({ code: PR_DIFF_UNAVAILABLE_CODE, reason: failure });',
    '  }',
    '}',
  ],
};

// FP2 — one added line (headers on DONE); the ERROR branch is pre-existing.
const BACKGROUND = 'apps/extension/background.ts';
const background: FileSpec = {
  path: BACKGROUND,
  added: new Set([8]),
  head: [
    'port.onMessage.addListener(async (message: StreamStart) => {',
    '  try {',
    '    const result = await executeApiStream(message, onChunk, abortController.signal);',
    '    port.postMessage({',
    "      type: 'DONE',",
    '      status: result.status,',
    '      bodyText: result.bodyText,',
    '      headers: result.headers,',
    '    });',
    '  } catch (error) {',
    '    port.postMessage({',
    "      type: 'ERROR',",
    "      error: error instanceof Error ? error.message : 'Stream proxy failed.',",
    '    });',
    '  }',
    '});',
  ],
};

// FP3 — the PR deletes loadProjectMemoryPromptBlock (its capability guard included).
const STORE = 'apps/extension/lib/project-memory/project-memory.store.ts';
const store: FileSpec = {
  path: STORE,
  added: new Set([2, 3, 4, 5]),
  head: [
    'export function memoryRepositoryForRequest(input: MemoryRequestInput): string | null {',
    '  if (!capabilityForAiAction(input.action)) return null;',
    '  const repo = resolveGithubOwnerRepo(input);',
    '  return repo ? `${repo.owner}/${repo.repo}` : null;',
    '}',
  ],
  deleted: [
    {
      before: 1,
      text: 'export async function loadProjectMemoryPromptBlock(input: MemoryRequestInput) {',
    },
    { before: 1, text: '  const capability = capabilityForAiAction(input.action);' },
    { before: 1, text: "  if (!capability) return '';" },
    {
      before: 1,
      text: '  const summary = await useProjectMemoryStore.getState().fetchSummary(repo.owner, repo.repo, { capability });',
    },
    { before: 1, text: '}' },
  ],
};

// FP4 — large service: archive() at ~L700 goes through findItemForMutation (guards at L40-75).
const MEMORY_SERVICE = 'apps/api/src/project-memory/project-memory.service.ts';
const memoryServiceHead = [
  'export class ProjectMemoryService {',
  ...filler(2, 39, 'service'),
  '  private async authorize(userId: string, permission: WorkspacePermission): Promise<string> {', // 40
  '    const workspaceId = await resolveWorkspaceIdForUser(this.prisma, userId);', // 41
  '    await this.workspaceAuthorization.assertAccess({ userId, workspaceId, permission });', // 42
  "    await this.featureGate.require(workspaceId, 'PROJECT_MEMORY');", // 43
  '    return workspaceId;', // 44
  '  }', // 45
  ...filler(46, 59, 'service'),
  '  private async findItemForMutation(userId: string, owner: string, repository: string, memoryId: string) {', // 60
  "    const workspaceId = await this.authorize(userId, 'memory:read');", // 61
  '    const existing = await this.prisma.projectMemory.findFirst({', // 62
  "      where: { id: memoryId, owner, repository, OR: [{ workspaceId, visibility: 'workspace' }, { workspaceId, visibility: 'user', userId }] },", // 63
  '    });', // 64
  "    if (!existing) throw projectMemoryException('PROJECT_MEMORY_ITEM_NOT_FOUND', 'Not found.');", // 65
  "    if (existing.visibility !== 'user') {", // 66
  "      await this.workspaceAuthorization.assertAccess({ userId, workspaceId, permission: 'memory:manage' });", // 67
  '    }', // 68
  '    return { existing, workspaceId };', // 69
  '  }', // 70
  ...filler(71, 699, 'service'),
  '  async archive(userId: string, owner: string, repository: string, memoryId: string) {', // 700
  '    const { existing } = await this.findItemForMutation(userId, owner, repository, memoryId);', // 701
  "    await this.prisma.projectMemory.update({ where: { id: existing.id }, data: { status: 'archived' } });", // 702
  '    return { archived: true, id: existing.id };', // 703
  '  }', // 704
  ...filler(705, 900, 'service'),
  '}',
];
const memoryService: FileSpec = {
  path: MEMORY_SERVICE,
  head: memoryServiceHead,
  added: new Set([700, 701, 702, 703, 704]),
};

// FP5 — dashboard: Reactivate button is gated in the UI; the API enforces separately.
const PAGE = 'apps/dashboard/src/app/app/memory/page.tsx';
const API_CLIENT = 'apps/dashboard/src/lib/api.ts';
const pageHead = [
  "'use client';",
  ...filler(2, 369, 'page'),
  '  async function onReactivate(item: ProjectMemoryItem) {', // 370
  "    if (!canQuery || item.status !== 'archived') return;", // 371
  "    await updateProjectMemory(ownerTrimmed, repoTrimmed, item.id, { status: 'active' });", // 372
  '  }', // 373
  ...filler(374, 694, 'page'),
  '  const canReactivate = canManage || isPersonalItem(item);', // 695
  ...filler(696, 760, 'page'),
];
const page: FileSpec = { path: PAGE, head: pageHead, added: new Set([370, 371, 372, 373, 695]) };
const apiClient: FileSpec = {
  path: API_CLIENT,
  added: 'all',
  head: [
    'export async function updateProjectMemory(owner: string, repo: string, id: string, body: UpdateProjectMemoryRequest) {',
    "  return apiFetch<ProjectMemoryItem>(projectMemoryPath(owner, repo, `/${encodeURIComponent(id)}`), { method: 'PATCH', body: JSON.stringify(body) });",
    '}',
  ],
};

// FP6 — parser accepts text without the server marker (only reachable if the model stops early itself).
const PARSER = 'apps/extension/lib/selection/utils/parse-pr-review.ts';
const parser: FileSpec = {
  path: PARSER,
  added: new Set([2]),
  head: [
    'export function parsePrReviewContent(content: string): ParsedPrReview {',
    '  const { text, incompleteReason } = stripIncompleteMarker(content);',
    '  const trimmed = text.trim();',
    '  return parseSections(trimmed, incompleteReason);',
    '}',
  ],
};

// FP7 — a negative test that looks like a grant.
const HARDENING = 'apps/api/src/project-memory/memory-hardening.spec.ts';
const hardening: FileSpec = {
  path: HARDENING,
  added: 'all',
  head: [
    "it('a non-member gets no memory in prompts and cannot read it', async () => {",
    "  db.actAs('outsider', 'ws_a'); // claims ws_a but has no membership",
    "  await expect(memory.list('outsider', 'acme', 'payments')).rejects.toBeInstanceOf(HttpException);",
    '});',
  ],
};

// TP1 — large file, new export method without authorization.
const BIG = 'apps/api/src/memory/export.service.ts';
const bigHead = [
  'export class MemoryExportService {',
  ...filler(2, 1189, 'export'),
  '  async exportAll(owner: string, repository: string) {', // 1190
  '    const rows = await this.prisma.projectMemory.findMany({ where: { owner, repository } });', // 1191
  '    return rows.map(toPublicRule);', // 1192
  '  }', // 1193
  ...filler(1194, 1500, 'export'),
  '}',
];
const bigFile: FileSpec = { path: BIG, head: bigHead, added: new Set([1190, 1191, 1192, 1193]) };

// TP2 — authorization guard removed, delete still runs.
const RULES = 'apps/api/src/memory/rules.service.ts';
const rules: FileSpec = {
  path: RULES,
  added: new Set(),
  head: [
    'export class RulesService {',
    '  async deleteRule(userId: string, id: string) {',
    '    await this.prisma.rule.delete({ where: { id } });',
    '    return { deleted: true };',
    '  }',
    '}',
  ],
  deleted: [{ before: 3, text: "    await this.authorize(userId, 'memory:manage');" }],
};

// TP3 — cross-file: controller passes a client-chosen workspace to a service that trusts it.
const CONTROLLER = 'apps/api/src/memory/memory.controller.ts';
const SVC = 'apps/api/src/memory/memory-query.service.ts';
const controller: FileSpec = {
  path: CONTROLLER,
  added: 'all',
  head: [
    "import { MemoryQueryService } from './memory-query.service';",
    'export class MemoryController {',
    '  constructor(private readonly memoryQuery: MemoryQueryService) {}',
    "  @Get('memory')",
    '  list(@Body() body: { workspaceId: string }) {',
    '    return this.memoryQuery.listForWorkspace(body.workspaceId);',
    '  }',
    '}',
  ],
};
const svc: FileSpec = {
  path: SVC,
  added: 'all',
  head: [
    'export class MemoryQueryService {',
    '  async listForWorkspace(workspaceId: string) {',
    '    return this.prisma.projectMemory.findMany({ where: { workspaceId } });',
    '  }',
    '}',
  ],
};

// TP4 — error handling reports success after a failed charge.
const PAY = 'apps/api/src/billing/capture.service.ts';
const pay: FileSpec = {
  path: PAY,
  added: new Set([3, 4, 5, 6, 7]),
  head: [
    'export class CaptureService {',
    '  async capture(orderId: string) {',
    '    try {',
    '      await this.paddle.capture(orderId);',
    '    } catch {',
    '      return { ok: true, orderId };',
    '    }',
    '    return { ok: true, orderId };',
    '  }',
    '}',
  ],
};

// TP5 — existing unscoped helper exposed by a new public route.
const ADMIN = 'apps/api/src/memory/admin.service.ts';
const admin: FileSpec = {
  path: ADMIN,
  added: new Set([7, 8, 9]),
  head: [
    'export class AdminService {',
    '  private async deleteAllForRepo(repository: string) {',
    '    return this.prisma.projectMemory.deleteMany({ where: { repository } });',
    '  }',
    '',
    "  @Delete('repos/:repository/memory')",
    '  async clearRepo(@Param() p: { repository: string }) {',
    '    return this.deleteAllForRepo(p.repository);',
    '  }',
    '}',
  ],
};

const FILES = [
  diffService,
  background,
  store,
  memoryService,
  page,
  apiClient,
  parser,
  hardening,
  bigFile,
  rules,
  controller,
  svc,
  pay,
  admin,
];

// ── cases ───────────────────────────────────────────────────────────────────

type Verifier = {
  verdict: 'confirmed' | 'refuted' | 'insufficient_context';
  severity: 'high' | 'medium' | 'low';
  decisiveCode: string;
  failureSite?: string;
  dependsOnCodeNotShown?: boolean;
  reachableTrigger?: string;
  violatedInvariant?: string;
  triggerSource?: string;
  guardsOnPath?: { code: string; whyNotPreventing: string }[];
};
type Case = {
  id: string;
  kind: 'false_positive' | 'true_positive';
  finding: BatchFindingInput;
  verifier?: Verifier;
  expected:
    { outcome: 'reported'; severity: 'high' | 'medium' | 'low' } | { outcome: 'not_reported' };
};

const confirm = (
  v: Partial<Verifier> & Pick<Verifier, 'decisiveCode' | 'failureSite'>,
): Verifier => ({
  verdict: 'confirmed',
  severity: 'high',
  dependsOnCodeNotShown: false,
  reachableTrigger: 'An authenticated user calls the endpoint with crafted input',
  violatedInvariant: 'Only authorized members of the owning workspace can do this',
  ...v,
});

const LIVE_FALSE_POSITIVES: Case[] = [
  {
    id: 'FP1 pull-request-diff.service: unexpected errors mapped to unavailable',
    kind: 'false_positive',
    finding: rawFinding({
      path: DIFF_SERVICE,
      category: 'correctness',
      severity: 'medium',
      title: 'Unexpected exceptions are misreported as GitHub unavailable',
      evidence: "failure = error instanceof GitHubDiffFetchError ? error.reason : 'unavailable';",
    }),
    // Live behaviour: "confirmed" by quoting the suspicious line itself.
    verifier: confirm({
      severity: 'medium',
      decisiveCode:
        "failure = error instanceof GitHubDiffFetchError ? error.reason : 'unavailable';",
      failureSite: `${DIFF_SERVICE}:7`,
    }),
    expected: { outcome: 'not_reported' },
  },
  {
    id: 'FP2 background.ts: ERROR branch has no headers (pre-existing, diagnostic)',
    kind: 'false_positive',
    finding: rawFinding({
      path: BACKGROUND,
      category: 'robustness',
      severity: 'medium',
      title: 'Error responses lose response headers',
      evidence: "type: 'ERROR',",
    }),
    verifier: confirm({
      severity: 'medium',
      decisiveCode:
        "type: 'ERROR',\nerror: error instanceof Error ? error.message : 'Stream proxy failed.',",
      failureSite: `${BACKGROUND}:12`,
      dependsOnCodeNotShown: true, // the consumer of ERROR lives in another file
    }),
    expected: { outcome: 'not_reported' },
  },
  {
    id: 'FP3 project-memory.store: undefined capability reaches fetchSummary (deleted code)',
    kind: 'false_positive',
    finding: rawFinding({
      path: STORE,
      category: 'correctness',
      severity: 'medium',
      title: 'Undefined capability can reach fetchSummary',
      evidence:
        '-  const summary = await useProjectMemoryStore.getState().fetchSummary(repo.owner, repo.repo, { capability });',
    }),
    verifier: confirm({
      severity: 'medium',
      decisiveCode:
        'const summary = await useProjectMemoryStore.getState().fetchSummary(repo.owner, repo.repo, { capability });',
      failureSite: `${STORE}:4`,
    }),
    expected: { outcome: 'not_reported' },
  },
  {
    id: 'FP4 project-memory.service: archive() lacks membership check (guard in helper)',
    kind: 'false_positive',
    finding: rawFinding({
      path: MEMORY_SERVICE,
      category: 'security',
      severity: 'medium',
      title: 'Archive does not verify workspace membership',
      evidence:
        '    const { existing } = await this.findItemForMutation(userId, owner, repository, memoryId);',
    }),
    verifier: {
      verdict: 'refuted',
      severity: 'low',
      // Quotes the denial branch of the guard it was shown (findItemForMutation, complete).
      decisiveCode:
        "if (!existing) throw projectMemoryException('PROJECT_MEMORY_ITEM_NOT_FOUND', 'Not found.');",
    },
    expected: { outcome: 'not_reported' },
  },
  {
    id: 'FP5 dashboard page: Reactivate protected only in the UI',
    kind: 'false_positive',
    finding: rawFinding({
      path: PAGE,
      category: 'security',
      severity: 'medium',
      title: 'Reactivate is only protected by UI permissions',
      evidence: 'const canReactivate = canManage || isPersonalItem(item);',
    }),
    verifier: {
      verdict: 'insufficient_context',
      severity: 'medium',
      decisiveCode: '',
      dependsOnCodeNotShown: true,
    },
    expected: { outcome: 'not_reported' },
  },
  {
    id: 'FP6 parse-pr-review: truncated output marked complete',
    kind: 'false_positive',
    finding: rawFinding({
      path: PARSER,
      category: 'correctness',
      severity: 'medium',
      title: 'Parser can mark a truncated review complete',
      evidence: 'const { text, incompleteReason } = stripIncompleteMarker(content);',
    }),
    verifier: confirm({
      severity: 'medium',
      decisiveCode:
        'const { text, incompleteReason } = stripIncompleteMarker(content);\nconst trimmed = text.trim();',
      failureSite: `${PARSER}:2`,
      dependsOnCodeNotShown: true, // depends on how the stream ends (server / store)
    }),
    expected: { outcome: 'not_reported' },
  },
  {
    id: 'FP7 memory-hardening.spec: outsider "acts" in ws_a (negative test)',
    kind: 'false_positive',
    finding: rawFinding({
      path: HARDENING,
      category: 'security',
      severity: 'medium',
      title: 'Test lets an outsider act inside workspace A',
      evidence: "db.actAs('outsider', 'ws_a'); // claims ws_a but has no membership",
    }),
    verifier: {
      verdict: 'refuted',
      severity: 'low',
      decisiveCode:
        "await expect(memory.list('outsider', 'acme', 'payments')).rejects.toBeInstanceOf(HttpException);",
    },
    expected: { outcome: 'not_reported' },
  },
];

const TRUE_POSITIVES: Case[] = [
  {
    id: 'TP1 large file: new export method without authorization (line 1,191 of 1,501)',
    kind: 'true_positive',
    finding: rawFinding({
      path: BIG,
      title: 'exportAll returns memory of every workspace without authorization',
      evidence:
        '    const rows = await this.prisma.projectMemory.findMany({ where: { owner, repository } });',
    }),
    verifier: confirm({
      decisiveCode:
        'async exportAll(owner: string, repository: string) {\nconst rows = await this.prisma.projectMemory.findMany({ where: { owner, repository } });',
      failureSite: `${BIG}:1191`,
      triggerSource: 'async exportAll(owner: string, repository: string) {',
    }),
    expected: { outcome: 'reported', severity: 'high' },
  },
  {
    id: 'TP2 removed authorization guard: delete still runs',
    kind: 'true_positive',
    finding: rawFinding({
      path: RULES,
      changeType: 'removed_safeguard',
      title: 'deleteRule no longer authorizes the caller',
      evidence: "-    await this.authorize(userId, 'memory:manage');",
    }),
    verifier: confirm({
      decisiveCode:
        'async deleteRule(userId: string, id: string) {\nawait this.prisma.rule.delete({ where: { id } });',
      failureSite: `${RULES}:3`,
      triggerSource: 'async deleteRule(userId: string, id: string) {',
    }),
    expected: { outcome: 'reported', severity: 'high' },
  },
  {
    id: 'TP3 cross-file: controller trusts client workspaceId, service queries it',
    kind: 'true_positive',
    finding: rawFinding({
      path: CONTROLLER,
      title: 'Client-supplied workspaceId selects whose memory is returned',
      evidence: 'return this.memoryQuery.listForWorkspace(body.workspaceId);',
    }),
    verifier: confirm({
      decisiveCode:
        'return this.memoryQuery.listForWorkspace(body.workspaceId);\nreturn this.prisma.projectMemory.findMany({ where: { workspaceId } });',
      failureSite: `${SVC}:3`,
      triggerSource: 'list(@Body() body: { workspaceId: string }) {',
    }),
    expected: { outcome: 'reported', severity: 'high' },
  },
  {
    id: 'TP4 incorrect error handling: failed capture reported as success',
    kind: 'true_positive',
    finding: rawFinding({
      path: PAY,
      category: 'data_integrity',
      severity: 'medium',
      title: 'Failed payment capture is reported as ok',
      evidence: '      return { ok: true, orderId };',
    }),
    verifier: confirm({
      severity: 'medium',
      decisiveCode: 'await this.paddle.capture(orderId);\nreturn { ok: true, orderId };',
      failureSite: `${PAY}:6`,
      reachableTrigger: 'Paddle rejects the capture (card declined)',
      triggerSource: 'await this.paddle.capture(orderId);',
      violatedInvariant: 'An order is reported paid only after a successful capture',
    }),
    expected: { outcome: 'reported', severity: 'medium' },
  },
  {
    id: 'TP5 existing unscoped delete exposed by a new public route (severity kept)',
    kind: 'true_positive',
    finding: rawFinding({
      path: ADMIN,
      category: 'data_integrity',
      changeType: 'exposed_existing',
      title: 'New route exposes an unscoped repository-wide delete',
      evidence: '    return this.prisma.projectMemory.deleteMany({ where: { repository } });',
    }),
    verifier: confirm({
      decisiveCode:
        'return this.deleteAllForRepo(p.repository);\nreturn this.prisma.projectMemory.deleteMany({ where: { repository } });',
      failureSite: `${ADMIN}:3`,
      triggerSource: 'async clearRepo(@Param() p: { repository: string }) {',
    }),
    expected: { outcome: 'reported', severity: 'high' },
  },
];

/** Confident, fully-filled wrong confirmations (worst-case verifier). */
const ADVERSARIAL: Case[] = [
  {
    ...LIVE_FALSE_POSITIVES[0]!,
    id: 'ADV1 FP1 with an extra quoted line and no dependency admitted',
    verifier: confirm({
      severity: 'medium',
      decisiveCode:
        "failure = error instanceof GitHubDiffFetchError ? error.reason : 'unavailable';\nthrow new UnprocessableEntityException({ code: PR_DIFF_UNAVAILABLE_CODE, reason: failure });",
      failureSite: `${DIFF_SERVICE}:9`,
      triggerSource: 'return await this.fetchFromGitHub(input);',
      guardsOnPath: [
        {
          code: 'return await this.fetchFromGitHub(input);',
          whyNotPreventing: 'It only returns when the fetch succeeds; any failure falls through.',
        },
      ],
    }),
  },
  {
    ...LIVE_FALSE_POSITIVES[1]!,
    id: 'ADV2 FP2 claiming the pre-existing ERROR branch without citing a change',
    verifier: confirm({
      severity: 'medium',
      decisiveCode:
        "type: 'ERROR',\nerror: error instanceof Error ? error.message : 'Stream proxy failed.',",
      failureSite: `${BACKGROUND}:12`,
    }),
  },
  {
    ...LIVE_FALSE_POSITIVES[5]!,
    id: 'ADV3 FP6 with every field filled and no dependency admitted',
    verifier: confirm({
      severity: 'medium',
      decisiveCode:
        'const { text, incompleteReason } = stripIncompleteMarker(content);\nconst trimmed = text.trim();',
      failureSite: `${PARSER}:3`,
      triggerSource: 'const { text, incompleteReason } = stripIncompleteMarker(content);',
    }),
  },
];

// ── harness ────────────────────────────────────────────────────────────────

const isVerification = (args: unknown) =>
  (args as { instructions?: string }).instructions === PR_REVIEW_VERIFY_INSTRUCTIONS;

async function run(cases: Case[]) {
  const head = new Map(FILES.map((f) => [f.path, f.head.join('\n')]));
  const modelFactory = {
    getDefaultModel: () => 'm',
    getProviderName: () => 'openai',
    getModelName: () => 'm',
  };
  const obs = {
    createOperationId: () => 'op',
    observeGenerate: async ({ call }: { call: () => Promise<{ result: unknown }> }) => ({
      result: (await call()).result,
      observation: { usage: {}, cost: {}, durationMs: 1 },
    }),
  };
  const health = { recordSignal: vi.fn() };
  const diff = {
    resolve: vi.fn(async () => ({
      source: 'github_api',
      files: FILES.map((f) => ({
        path: f.path,
        status: 'modified',
        changes: 10,
        patch: patchOf(f),
      })),
      totalFiles: FILES.length,
      headSha: '69e1fc4f3d19',
    })),
    createFileProvider: vi.fn(() => async (path: string) => head.get(path) ?? null),
  };
  const service = new AiService(
    new PromptRegistry(),
    modelFactory as never,
    {
      get: () => ({
        requestTimeoutMs: 1_000,
        maxInputCharacters: 20_000,
        prReview: {
          maxBatches: 12,
          maxInputTokens: 400_000,
          maxTotalOutputTokens: 100_000,
          maxVerifications: 24,
          maxContextFiles: 30,
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
    {
      user: { findUnique: vi.fn(async () => null) },
      workspaceMembership: { findFirst: vi.fn(async () => null) },
    } as never,
    { require: vi.fn() } as never,
    usageStub() as never,
    obs as never,
    { get: () => ({}), patch: vi.fn() } as never,
    health as never,
    undefined,
    undefined,
    diff as never,
    new PrReviewOrchestrator(modelFactory as never, obs as never, health as never),
  );

  const verifyPrompts = new Map<string, string>();
  generateTextMock.mockImplementation(async (args: { messages: { content: string }[] }) => {
    const content = args.messages[0]!.content;
    if (isVerification(args)) {
      const c = cases.find((x) => content.includes(`title: ${x.finding.title}`))!;
      verifyPrompts.set(c.id, content);
      const v = c.verifier ?? {
        verdict: 'insufficient_context',
        severity: 'low',
        decisiveCode: '',
      };
      return {
        output: {
          failureSite: '',
          dependsOnCodeNotShown: false,
          reachableTrigger: '',
          violatedInvariant: '',
          triggerSource: '',
          guardsOnPath: [],
          ...v,
          reasoning: `recorded ${v.verdict}`,
        },
        finishReason: 'stop',
        usage: {},
      };
    }
    const inBatch = content
      .split('reviewFiles:\n')[1]!
      .split('\notherChangedFiles:')[0]!
      .split('\n');
    const findings = cases.map((c) => c.finding).filter((f) => inBatch.includes(`- ${f.path}`));
    return { output: { summary: 's', findings }, finishReason: 'stop', usage: {} };
  });
  const result = await service.generateActionWithMetadata('u1', {
    action: AIAction.REVIEW_ENTIRE_PR,
    text: 'Review',
    context: {
      type: 'github',
      url: 'https://github.com/GH0ST-000/Ai-Extension/pull/48',
      title: 'PR',
      github: { owner: 'GH0ST-000', repository: 'Ai-Extension', pullRequestNumber: 48 },
    },
  } as never);
  return { result, verifyPrompts };
}

function outcome(text: string, title: string): { outcome: string; severity: string | null } {
  const [reported, investigation = ''] = text.split('## Needs Investigation');
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(String.raw`\*\*\[(high|medium|low)\]\*\* \x60[^\x60]+\x60 — ${esc}`);
  const r = re.exec(reported!);
  if (r) return { outcome: 'reported', severity: r[1]! };
  if (re.test(investigation)) return { outcome: 'needs_investigation', severity: null };
  return { outcome: 'not_reported', severity: null };
}

describe('live review #2 regression (PR #48 @ 69e1fc4)', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it('rejects all seven live false positives and reports all five seeded true positives', async () => {
    const cases = [...LIVE_FALSE_POSITIVES, ...TRUE_POSITIVES];
    const { result } = await run(cases);
    const rows = cases.map((c) => ({
      id: c.id,
      kind: c.kind,
      ...outcome(result.text, c.finding.title),
    }));

    const fps = rows.filter((r) => r.kind === 'false_positive');
    const tps = rows.filter((r) => r.kind === 'true_positive');
    const metrics = {
      falsePositives: fps.length,
      falsePositivesReported: fps.filter((r) => r.outcome === 'reported').length,
      truePositives: tps.length,
      truePositivesReported: tps.filter((r) => r.outcome === 'reported').length,
    };
    expect(metrics).toEqual({
      falsePositives: 7,
      falsePositivesReported: 0,
      truePositives: 5,
      truePositivesReported: 5,
    });

    // Exact disposition of each false positive (none silently vanishes unless it is invalid).
    const fp = Object.fromEntries(fps.map((r) => [r.id.slice(0, 3), r.outcome]));
    expect(fp).toEqual({
      FP1: 'needs_investigation', // "confirmed" only by restating the line
      FP2: 'needs_investigation', // depends on the consumer in another file
      FP3: 'not_reported', // deleted code → rejected before verification
      FP4: 'not_reported', // refuted by the guard in findItemForMutation/authorize
      FP5: 'needs_investigation', // backend enforcement not in context
      FP6: 'needs_investigation', // depends on stream/store behaviour
      // A runtime claim on a test entry file (runs tests, exports nothing): no production
      // path can reach it, so it is rejected before verification (recorded, not silent).
      FP7: 'not_reported',
    });
    for (const c of TRUE_POSITIVES) {
      const row = rows.find((r) => r.id === c.id)!;
      expect([row.id, row.severity]).toEqual([
        c.id,
        c.expected.outcome === 'reported' ? c.expected.severity : null,
      ]);
    }
    const stats = result.coverage!.findings;
    expect(stats.rejectedByReason).toMatchObject({
      deleted_code_only: 1,
      runtime_claim_on_test_code: 1, // FP7, no longer sent to verification
    });
    expect(stats.verification).toMatchObject({
      confirmed: 5,
      refuted: 1,
      insufficientContext: 4,
      unprovenConfirmations: 3,
    });
    expect(result.coverage!.riskLevel).toBe('high');
    expect(result.text).toContain('Change: safeguard removed by this PR');
    expect(result.text).toContain('Change: existing defect exposed by this PR');
  });

  it('verification context: every verifier gets the finding window and head code; guards and callees are found', async () => {
    const cases = [...LIVE_FALSE_POSITIVES, ...TRUE_POSITIVES];
    const { result, verifyPrompts } = await run(cases);
    const v = result.coverage!.findings.verification!;
    expect(v.withDiffWindow).toBe(v.attempted);
    expect(v.withHeadContext).toBe(v.attempted);
    expect(v.withHelpers).toBeGreaterThanOrEqual(2);

    // Large file: the finding at line 1,191 is in view, the top of the file is not.
    const big = verifyPrompts.get(TRUE_POSITIVES[0]!.id)!;
    expect(big).toContain(line('ADD', 1191, bigHead[1190]!));
    expect(big).not.toContain('// export 2\n');
    // Guards far from the finding (FP4): authorize()/findItemForMutation() definitions shown.
    const fp4 = verifyPrompts.get(LIVE_FALSE_POSITIVES[3]!.id)!;
    expect(fp4).toContain('dependency findItemForMutation() — complete');
    expect(fp4).toContain(line('HEAD', 67, memoryServiceHead[66]!));
    // Cross-file callee (TP3) and the dashboard API client (FP5) are found from the diff.
    expect(verifyPrompts.get(TRUE_POSITIVES[2]!.id)!).toContain(
      'dependency MemoryQueryService.listForWorkspace() — complete',
    );
    // FP5 sits at line 695, far from the API call at 372: the backend is honestly not shown.
    expect(verifyPrompts.get(LIVE_FALSE_POSITIVES[4]!.id)!).toContain(
      line('ADD', 695, pageHead[694]!),
    );
    // Removed guard (TP2): deleted line tagged DEL, head code shows the unguarded delete.
    const tp2 = verifyPrompts.get(TRUE_POSITIVES[1]!.id)!;
    expect(tp2).toContain(
      renderCodeLine({ tag: 'DEL', n: null, old: 3, text: rules.deleted![0]!.text }),
    );
    expect(tp2).toContain(line('HEAD', 3, rules.head[2]!));
  });

  it('adversarial: confident wrong confirmations — what the deterministic gates alone can catch', async () => {
    const { result } = await run([...ADVERSARIAL, ...TRUE_POSITIVES]);
    const rows = ADVERSARIAL.map((c) => ({
      id: c.id.slice(0, 4),
      ...outcome(result.text, c.finding.title),
    }));
    // ADV2 is caught (an "exposed" defect must quote the change that exposes it). ADV1 and
    // ADV3 pass every deterministic check: with a verifier that is confidently wrong and
    // fills every field, only model quality (or a stronger verifier) can stop them.
    expect(Object.fromEntries(rows.map((r) => [r.id, r.outcome]))).toEqual({
      ADV1: 'reported',
      ADV2: 'needs_investigation',
      ADV3: 'reported',
    });
    // True positives are unaffected.
    for (const c of TRUE_POSITIVES)
      expect(outcome(result.text, c.finding.title).outcome).toBe('reported');
    const v = result.coverage!.findings
      .verification as PRReviewCoverage['findings']['verification'];
    expect(v?.unprovenConfirmations).toBe(1);
  });
});
