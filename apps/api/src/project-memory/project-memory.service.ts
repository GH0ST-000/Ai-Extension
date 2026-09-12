import { Injectable, Logger } from '@nestjs/common';
import type { ProjectMemory as ProjectMemoryRow, Prisma } from '@prisma/client';
import {
  categoryRelevanceForCapability,
  computeMemoryVersion,
  extractDeterministicFactsFromConfigs,
  selectRelevantMemory,
  validateCreateRuleInput,
  validateMemoryValue,
  validateScope,
} from '@project-x/shared';
import type {
  LearnProjectMemoryResponse,
  ListProjectMemoryResponse,
  ProjectMemoryCandidate,
  ProjectMemoryItem,
  ProjectMemoryProvenance,
  ProjectMemoryScope,
  ProjectMemoryStatus,
  ProjectMemorySummary,
  ProjectMemoryValue,
  ProjectProfile,
} from '@project-x/types';
import {
  PROJECT_MEMORY_MAX_ACTIVE_USER_RULES,
  PROJECT_MEMORY_MAX_ITEMS_PER_REPO,
  PROJECT_MEMORY_MAX_LEARN_FILES,
  PROJECT_MEMORY_MAX_PROVENANCE_ENTRIES,
  PROJECT_MEMORY_MAX_RELEVANT_RULES,
  PROJECT_MEMORY_MAX_SUMMARY_CHARS,
  ProjectMemoryCategory,
} from '@project-x/types';
import { randomUUID } from 'crypto';

import { GithubContentService } from '../github/github-content.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GithubConnectionService } from '../settings/github-connection.service';
import { projectMemoryException } from './project-memory.errors';
import { scopeFingerprint, toProjectMemoryItem } from './project-memory.mapper';

const CANDIDATE_TTL_SECONDS = 60 * 60; // 1h

/** Bounded high-signal paths for Learn Project Context (exact paths; no globs). */
const HIGH_SIGNAL_PATHS: readonly string[] = [
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'turbo.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.json',
  '.prettierrc.yml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'nest-cli.json',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mjs',
  'jest.config.js',
  'jest.config.ts',
  'prisma/schema.prisma',
  'README.md',
  'CONTRIBUTING.md',
];

const ENV_PATH_RE = /(?:^|\/)\.env(?:\..+)?$/i;

type PersistInput = {
  userId: string;
  owner: string;
  repository: string;
  category: ProjectMemoryItem['category'];
  key: string;
  value: ProjectMemoryValue;
  confidence: ProjectMemoryItem['confidence'];
  scope: ProjectMemoryScope;
  provenance: ProjectMemoryProvenance[];
  freshness?: ProjectMemoryItem['freshness'];
  /** When true, do not overwrite active user_explicit memories. */
  inferred?: boolean;
};

@Injectable()
export class ProjectMemoryService {
  private readonly logger = new Logger(ProjectMemoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly githubConnections: GithubConnectionService,
    private readonly githubContent: GithubContentService,
  ) {}

  async list(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    status?: ProjectMemoryStatus,
  ): Promise<ListProjectMemoryResponse> {
    const { owner, repository } = this.normalizeRepo(ownerRaw, repositoryRaw);
    await this.assertRepositoryAccess(userId, owner, repository);

    const rows = await this.prisma.projectMemory.findMany({
      where: {
        userId,
        owner,
        repository,
        status: status ?? 'active',
      },
      orderBy: [{ category: 'asc' }, { key: 'asc' }, { updatedAt: 'desc' }],
    });

    const items = rows.map(toProjectMemoryItem);
    return {
      items,
      memoryVersion: computeMemoryVersion(items),
      total: items.length,
    };
  }

  async getProfile(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
  ): Promise<ProjectProfile> {
    const { owner, repository } = this.normalizeRepo(ownerRaw, repositoryRaw);
    await this.assertRepositoryAccess(userId, owner, repository);

    const items = await this.loadActiveItems(userId, owner, repository);
    return this.buildProfile(owner, repository, items);
  }

  async getSummary(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    capability?: string,
    pathsCsv?: string,
  ): Promise<ProjectMemorySummary> {
    const { owner, repository } = this.normalizeRepo(ownerRaw, repositoryRaw);
    await this.assertRepositoryAccess(userId, owner, repository);

    const items = await this.loadActiveItems(userId, owner, repository);
    const categories = categoryRelevanceForCapability(
      (capability ?? 'PLANNING').trim().toUpperCase() || 'PLANNING',
    );
    const pathHints = (pathsCsv ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    const selected = selectRelevantMemory(items, {
      categories,
      pathHints,
      maxItems: PROJECT_MEMORY_MAX_RELEVANT_RULES,
      maxChars: PROJECT_MEMORY_MAX_SUMMARY_CHARS * PROJECT_MEMORY_MAX_RELEVANT_RULES,
    });

    return {
      version: computeMemoryVersion(items),
      relevantRules: selected.map((item) => ({
        id: item.id,
        category: item.category,
        key: item.key,
        text: item.value.summary,
        confidence: item.confidence,
      })),
    };
  }

  async createRule(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    body: {
      category: ProjectMemoryItem['category'];
      key?: string;
      text: string;
      scope?: ProjectMemoryScope;
    },
  ): Promise<ProjectMemoryItem> {
    const { owner, repository } = this.normalizeRepo(ownerRaw, repositoryRaw);
    await this.assertRepositoryAccess(userId, owner, repository);

    const validated = validateCreateRuleInput({
      owner,
      repository,
      category: body.category,
      key: body.key,
      text: body.text,
      scope: body.scope,
    });
    if (!validated.ok) {
      throw projectMemoryException(validated.code, validated.message);
    }

    const { category, key, text, scope } = validated.value;
    const value: ProjectMemoryValue = { summary: text };
    const now = new Date().toISOString();
    const provenance: ProjectMemoryProvenance[] = [
      {
        type: 'user_explicit',
        repository: { owner, name: repository },
        observedAt: now,
        summary: 'Explicit user project rule',
      },
    ];

    await this.assertCanCreateUserRule(userId, owner, repository);

    const result = await this.persistMemory({
      userId,
      owner,
      repository,
      category,
      key,
      value,
      confidence: 'high',
      scope,
      provenance,
      freshness: { strategy: 'manual', lastValidatedAt: now },
      inferred: false,
    });

    return toProjectMemoryItem(result);
  }

  async update(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    memoryId: string,
    body: {
      value?: ProjectMemoryValue;
      status?: ProjectMemoryStatus;
      scope?: ProjectMemoryScope;
      text?: string;
    },
  ): Promise<ProjectMemoryItem> {
    const { owner, repository } = this.normalizeRepo(ownerRaw, repositoryRaw);
    await this.assertRepositoryAccess(userId, owner, repository);

    const existing = await this.prisma.projectMemory.findFirst({
      where: { id: memoryId, userId, owner, repository },
    });
    if (!existing) {
      throw projectMemoryException(
        'PROJECT_MEMORY_ITEM_NOT_FOUND',
        'Project memory item was not found.',
      );
    }

    const data: Prisma.ProjectMemoryUpdateInput = {};

    if (body.text !== undefined || body.value !== undefined) {
      const nextValue: ProjectMemoryValue =
        body.value ??
        ({
          summary: typeof body.text === 'string' ? body.text.trim() : '',
          ...(existing.valueJson &&
          typeof existing.valueJson === 'object' &&
          !Array.isArray(existing.valueJson) &&
          'details' in (existing.valueJson as Record<string, unknown>)
            ? {
                details: (existing.valueJson as unknown as ProjectMemoryValue).details,
              }
            : {}),
        } as ProjectMemoryValue);

      if (body.text !== undefined && body.value === undefined) {
        nextValue.summary = body.text.trim();
      }

      const valueResult = validateMemoryValue(nextValue);
      if (!valueResult.ok) {
        throw projectMemoryException(valueResult.code, valueResult.message);
      }
      data.valueJson = valueResult.value as unknown as Prisma.InputJsonValue;
    }

    if (body.scope !== undefined) {
      const scopeResult = validateScope(body.scope);
      if (!scopeResult.ok) {
        throw projectMemoryException(scopeResult.code, scopeResult.message);
      }
      data.scopeJson = scopeResult.value as unknown as Prisma.InputJsonValue;
      data.scopeFingerprint = scopeFingerprint(scopeResult.value);
    }

    if (body.status !== undefined) {
      data.status = body.status;
    }

    const updated = await this.prisma.projectMemory.update({
      where: { id: existing.id },
      data,
    });
    return toProjectMemoryItem(updated);
  }

  async archive(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    memoryId: string,
  ): Promise<{ archived: true; id: string }> {
    const { owner, repository } = this.normalizeRepo(ownerRaw, repositoryRaw);
    await this.assertRepositoryAccess(userId, owner, repository);

    const existing = await this.prisma.projectMemory.findFirst({
      where: { id: memoryId, userId, owner, repository },
    });
    if (!existing) {
      throw projectMemoryException(
        'PROJECT_MEMORY_ITEM_NOT_FOUND',
        'Project memory item was not found.',
      );
    }

    await this.prisma.projectMemory.update({
      where: { id: existing.id },
      data: { status: 'archived' },
    });
    return { archived: true, id: existing.id };
  }

  async clear(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    confirm: boolean,
  ): Promise<{ archived: number }> {
    if (confirm !== true) {
      throw projectMemoryException(
        'PROJECT_MEMORY_VALIDATION_FAILED',
        'confirm must be true to clear project memory.',
      );
    }

    const { owner, repository } = this.normalizeRepo(ownerRaw, repositoryRaw);
    await this.assertRepositoryAccess(userId, owner, repository);

    const result = await this.prisma.projectMemory.updateMany({
      where: {
        userId,
        owner,
        repository,
        status: { not: 'archived' },
      },
      data: { status: 'archived' },
    });

    return { archived: result.count };
  }

  async learn(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
  ): Promise<LearnProjectMemoryResponse> {
    const { owner, repository } = this.normalizeRepo(ownerRaw, repositoryRaw);
    await this.assertRepositoryAccess(userId, owner, repository);

    const files = await this.fetchHighSignalFiles(userId, owner, repository);
    let candidates: ProjectMemoryCandidate[];
    try {
      candidates = extractDeterministicFactsFromConfigs(files);
    } catch {
      throw projectMemoryException(
        'PROJECT_MEMORY_EXTRACTION_FAILED',
        'Unable to extract project memory from repository configuration.',
      );
    }

    const accepted: ProjectMemoryItem[] = [];
    const askUser: ProjectMemoryCandidate[] = [];
    const supersededIds: string[] = [];

    for (const candidate of candidates) {
      if (candidate.recommendation === 'do_not_store') {
        continue;
      }

      if (candidate.recommendation === 'ask_user') {
        const stored = await this.storeCandidate(userId, owner, repository, candidate);
        askUser.push(stored);
        continue;
      }

      // auto_accept
      const now = new Date().toISOString();
      const evidenceSummary =
        candidate.evidence[0]?.summary ?? 'Deterministic repository configuration fact';
      const provenance: ProjectMemoryProvenance[] = [
        {
          type: 'repository_observation',
          repository: { owner, name: repository },
          filePath: candidate.evidence[0]?.filePath,
          observedAt: now,
          summary: evidenceSummary.slice(0, 200),
        },
      ];

      try {
        const row = await this.persistMemory({
          userId,
          owner,
          repository,
          category: candidate.category,
          key: candidate.key,
          value: candidate.proposedValue,
          confidence: candidate.confidence,
          scope: candidate.scope ?? { type: 'repository' },
          provenance,
          freshness: {
            strategy: 'config-bound',
            lastValidatedAt: now,
            sourceFingerprint: candidate.evidence
              .map((e) => e.filePath)
              .filter(Boolean)
              .join(','),
          },
          inferred: true,
        });
        if (row.supersedesMemoryId) {
          supersededIds.push(row.supersedesMemoryId);
        }
        accepted.push(toProjectMemoryItem(row));
      } catch (err) {
        // Skip items that hit limits / explicit-rule protection; keep learning partial.
        this.logger.warn(
          `Learn skipped candidate ${candidate.key}: ${err instanceof Error ? err.message : 'error'}`,
        );
      }
    }

    const items = await this.loadActiveItems(userId, owner, repository);
    const profile = this.buildProfile(owner, repository, items);

    return {
      memoryVersion: profile.memoryVersion,
      profile,
      accepted,
      candidates: askUser,
      ...(supersededIds.length > 0 ? { supersededIds } : {}),
    };
  }

  async confirmCandidate(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    candidateId: string,
  ): Promise<ProjectMemoryItem> {
    const { owner, repository } = this.normalizeRepo(ownerRaw, repositoryRaw);
    await this.assertRepositoryAccess(userId, owner, repository);

    const candidate = await this.loadCandidate(userId, owner, repository, candidateId);
    if (!candidate) {
      throw projectMemoryException(
        'PROJECT_MEMORY_CANDIDATE_INVALID',
        'Memory candidate is missing or expired.',
      );
    }

    const now = new Date().toISOString();
    const provenance: ProjectMemoryProvenance[] = [
      {
        type: 'repository_observation',
        repository: { owner, name: repository },
        filePath: candidate.evidence[0]?.filePath,
        observedAt: now,
        summary: 'User confirmed project memory candidate',
      },
    ];

    const row = await this.persistMemory({
      userId,
      owner,
      repository,
      category: candidate.category,
      key: candidate.key,
      value: candidate.proposedValue,
      confidence: candidate.confidence,
      scope: candidate.scope ?? { type: 'repository' },
      provenance,
      freshness: { strategy: 'manual', lastValidatedAt: now },
      inferred: false,
    });

    await this.deleteCandidate(userId, owner, repository, candidateId);
    return toProjectMemoryItem(row);
  }

  async rejectCandidate(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    candidateId: string,
  ): Promise<{ rejected: true; candidateId: string }> {
    const { owner, repository } = this.normalizeRepo(ownerRaw, repositoryRaw);
    await this.assertRepositoryAccess(userId, owner, repository);

    const candidate = await this.loadCandidate(userId, owner, repository, candidateId);
    if (!candidate) {
      throw projectMemoryException(
        'PROJECT_MEMORY_CANDIDATE_INVALID',
        'Memory candidate is missing or expired.',
      );
    }

    await this.deleteCandidate(userId, owner, repository, candidateId);
    return { rejected: true, candidateId };
  }

  // ── internals ────────────────────────────────────────────────────────────

  normalizeRepo(ownerRaw: string, repositoryRaw: string): { owner: string; repository: string } {
    const owner = ownerRaw.trim().toLowerCase();
    const repository = repositoryRaw.trim().toLowerCase();
    if (!owner || !repository || owner === 'unknown' || repository === 'unknown') {
      throw projectMemoryException(
        'PROJECT_MEMORY_VALIDATION_FAILED',
        'owner and repository are required.',
      );
    }
    return { owner, repository };
  }

  async assertRepositoryAccess(userId: string, owner: string, repository: string): Promise<string> {
    const token = await this.githubConnections.getDecryptedToken(userId);
    if (!token) {
      throw projectMemoryException(
        'PROJECT_MEMORY_ACCESS_DENIED',
        'Connect a GitHub token in dashboard Settings before using project memory.',
      );
    }

    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Project-X',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      // Transient network — do not delete memory.
      throw projectMemoryException(
        'PROJECT_MEMORY_SOURCE_UNAVAILABLE',
        'Unable to reach GitHub to verify repository access. Existing memory was not modified.',
      );
    }

    if (response.status === 404 || response.status === 403) {
      throw projectMemoryException(
        'PROJECT_MEMORY_ACCESS_DENIED',
        'GitHub denied access to this repository for the connected account.',
      );
    }

    if (response.status === 401) {
      throw projectMemoryException(
        'PROJECT_MEMORY_ACCESS_DENIED',
        'GitHub rejected your stored token. Update it in dashboard Settings.',
      );
    }

    if (!response.ok) {
      throw projectMemoryException(
        'PROJECT_MEMORY_SOURCE_UNAVAILABLE',
        'GitHub repository access check failed temporarily. Existing memory was not modified.',
      );
    }

    return token;
  }

  private async loadActiveItems(
    userId: string,
    owner: string,
    repository: string,
  ): Promise<ProjectMemoryItem[]> {
    const rows = await this.prisma.projectMemory.findMany({
      where: { userId, owner, repository, status: 'active' },
      orderBy: [{ category: 'asc' }, { key: 'asc' }],
    });
    return rows.map(toProjectMemoryItem);
  }

  private buildProfile(
    owner: string,
    repository: string,
    items: ProjectMemoryItem[],
  ): ProjectProfile {
    const architecture: ProjectMemoryItem[] = [];
    const conventions: ProjectMemoryItem[] = [];
    const constraints: ProjectMemoryItem[] = [];
    const tooling: ProjectMemoryItem[] = [];
    const preferences: ProjectMemoryItem[] = [];

    for (const item of items) {
      if (item.status !== 'active') continue;
      switch (item.category) {
        case ProjectMemoryCategory.ARCHITECTURE:
        case ProjectMemoryCategory.SERVICE_RESPONSIBILITY:
        case ProjectMemoryCategory.DIRECTORY_CONVENTION:
          architecture.push(item);
          break;
        case ProjectMemoryCategory.PROJECT_CONSTRAINT:
        case ProjectMemoryCategory.TECHNICAL_DECISION:
          constraints.push(item);
          break;
        case ProjectMemoryCategory.FRAMEWORK:
        case ProjectMemoryCategory.DEPENDENCY_CONVENTION:
          tooling.push(item);
          break;
        case ProjectMemoryCategory.USER_PREFERENCE:
          preferences.push(item);
          break;
        default:
          conventions.push(item);
          break;
      }
    }

    return {
      project: { provider: 'github', owner, repository },
      architecture,
      conventions,
      constraints,
      tooling,
      preferences,
      generatedAt: new Date().toISOString(),
      memoryVersion: computeMemoryVersion(items),
    };
  }

  private async assertCanCreateUserRule(
    userId: string,
    owner: string,
    repository: string,
  ): Promise<void> {
    const totalActive = await this.prisma.projectMemory.count({
      where: { userId, owner, repository, status: 'active' },
    });
    if (totalActive >= PROJECT_MEMORY_MAX_ITEMS_PER_REPO) {
      throw projectMemoryException(
        'PROJECT_MEMORY_LIMIT_REACHED',
        `Active project memory limit (${PROJECT_MEMORY_MAX_ITEMS_PER_REPO}) reached for this repository.`,
      );
    }

    const ruleRows = await this.prisma.projectMemory.findMany({
      where: {
        userId,
        owner,
        repository,
        status: 'active',
      },
      select: { provenanceJson: true },
      take: PROJECT_MEMORY_MAX_ITEMS_PER_REPO + 1,
    });
    const explicitCount = ruleRows.filter((row) =>
      this.hasUserExplicitProvenance(row.provenanceJson),
    ).length;

    if (explicitCount >= PROJECT_MEMORY_MAX_ACTIVE_USER_RULES) {
      throw projectMemoryException(
        'PROJECT_MEMORY_LIMIT_REACHED',
        `Active user rule limit (${PROJECT_MEMORY_MAX_ACTIVE_USER_RULES}) reached for this repository.`,
      );
    }
  }

  private hasUserExplicitProvenance(provenanceJson: Prisma.JsonValue): boolean {
    if (!Array.isArray(provenanceJson)) return false;
    return provenanceJson.some(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        (entry as { type?: string }).type === 'user_explicit',
    );
  }

  private async persistMemory(input: PersistInput): Promise<ProjectMemoryRow> {
    const fp = scopeFingerprint(input.scope);
    const valueSummary = input.value.summary.trim();

    const existing = await this.prisma.projectMemory.findFirst({
      where: {
        userId: input.userId,
        owner: input.owner,
        repository: input.repository,
        category: input.category,
        key: input.key,
        scopeFingerprint: fp,
        status: 'active',
      },
    });

    if (existing) {
      const existingValue = existing.valueJson as unknown as ProjectMemoryValue;
      const existingSummary = existingValue?.summary?.trim() ?? '';
      const isUserExplicit = this.hasUserExplicitProvenance(existing.provenanceJson);

      if (input.inferred && isUserExplicit) {
        // Explicit user rules cannot be overwritten by inferred learn facts.
        return existing;
      }

      if (existingSummary === valueSummary) {
        // Dedup: refresh confirmation + merge provenance
        const mergedProvenance = this.mergeProvenance(existing.provenanceJson, input.provenance);
        return this.prisma.projectMemory.update({
          where: { id: existing.id },
          data: {
            lastConfirmedAt: new Date(),
            provenanceJson: mergedProvenance as unknown as Prisma.InputJsonValue,
            confidence: input.confidence,
            ...(input.freshness
              ? { freshnessJson: input.freshness as unknown as Prisma.InputJsonValue }
              : {}),
          },
        });
      }

      // Conflict: supersede old, create new
      await this.prisma.projectMemory.update({
        where: { id: existing.id },
        data: { status: 'superseded' },
      });

      await this.assertUnderItemLimit(input.userId, input.owner, input.repository);

      return this.prisma.projectMemory.create({
        data: {
          userId: input.userId,
          owner: input.owner,
          repository: input.repository,
          category: input.category,
          key: input.key,
          valueJson: input.value as unknown as Prisma.InputJsonValue,
          confidence: input.confidence,
          status: 'active',
          scopeJson: input.scope as unknown as Prisma.InputJsonValue,
          scopeFingerprint: fp,
          provenanceJson: this.trimProvenance(input.provenance) as unknown as Prisma.InputJsonValue,
          freshnessJson: (input.freshness ?? null) as unknown as Prisma.InputJsonValue,
          supersedesMemoryId: existing.id,
          lastConfirmedAt: new Date(),
        },
      });
    }

    await this.assertUnderItemLimit(input.userId, input.owner, input.repository);

    return this.prisma.projectMemory.create({
      data: {
        userId: input.userId,
        owner: input.owner,
        repository: input.repository,
        category: input.category,
        key: input.key,
        valueJson: input.value as unknown as Prisma.InputJsonValue,
        confidence: input.confidence,
        status: 'active',
        scopeJson: input.scope as unknown as Prisma.InputJsonValue,
        scopeFingerprint: fp,
        provenanceJson: this.trimProvenance(input.provenance) as unknown as Prisma.InputJsonValue,
        freshnessJson: (input.freshness ?? null) as unknown as Prisma.InputJsonValue,
        lastConfirmedAt: new Date(),
      },
    });
  }

  private async assertUnderItemLimit(
    userId: string,
    owner: string,
    repository: string,
  ): Promise<void> {
    const totalActive = await this.prisma.projectMemory.count({
      where: { userId, owner, repository, status: 'active' },
    });
    if (totalActive >= PROJECT_MEMORY_MAX_ITEMS_PER_REPO) {
      throw projectMemoryException(
        'PROJECT_MEMORY_LIMIT_REACHED',
        `Active project memory limit (${PROJECT_MEMORY_MAX_ITEMS_PER_REPO}) reached for this repository.`,
      );
    }
  }

  private mergeProvenance(
    existingJson: Prisma.JsonValue,
    incoming: ProjectMemoryProvenance[],
  ): ProjectMemoryProvenance[] {
    const existing = Array.isArray(existingJson)
      ? (existingJson as unknown as ProjectMemoryProvenance[])
      : [];
    return this.trimProvenance([...incoming, ...existing]);
  }

  private trimProvenance(entries: ProjectMemoryProvenance[]): ProjectMemoryProvenance[] {
    return entries.slice(0, PROJECT_MEMORY_MAX_PROVENANCE_ENTRIES);
  }

  private candidateRedisKey(
    userId: string,
    owner: string,
    repository: string,
    candidateId: string,
  ): string {
    return `pm:cand:${userId}:${owner}:${repository}:${candidateId}`;
  }

  private async storeCandidate(
    userId: string,
    owner: string,
    repository: string,
    candidate: ProjectMemoryCandidate,
  ): Promise<ProjectMemoryCandidate> {
    const id = candidate.id?.trim() || randomUUID();
    const stored: ProjectMemoryCandidate = { ...candidate, id };
    await this.redis.set(
      this.candidateRedisKey(userId, owner, repository, id),
      JSON.stringify(stored),
      'EX',
      CANDIDATE_TTL_SECONDS,
    );
    return stored;
  }

  private async loadCandidate(
    userId: string,
    owner: string,
    repository: string,
    candidateId: string,
  ): Promise<ProjectMemoryCandidate | null> {
    const raw = await this.redis.get(
      this.candidateRedisKey(userId, owner, repository, candidateId),
    );
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed as ProjectMemoryCandidate;
    } catch {
      return null;
    }
  }

  private async deleteCandidate(
    userId: string,
    owner: string,
    repository: string,
    candidateId: string,
  ): Promise<void> {
    await this.redis.del(this.candidateRedisKey(userId, owner, repository, candidateId));
  }

  private async fetchHighSignalFiles(
    userId: string,
    owner: string,
    repository: string,
  ): Promise<{ path: string; content: string }[]> {
    const paths = HIGH_SIGNAL_PATHS.filter((p) => !ENV_PATH_RE.test(p)).slice(
      0,
      PROJECT_MEMORY_MAX_LEARN_FILES,
    );

    const results: { path: string; content: string }[] = [];
    for (const path of paths) {
      if (results.length >= PROJECT_MEMORY_MAX_LEARN_FILES) break;
      try {
        const content = await this.githubContent.fetchRepositoryFileAtRef(
          userId,
          owner,
          repository,
          path,
        );
        if (content != null) {
          results.push({ path, content });
        }
      } catch (err) {
        // Skip individual file failures; do not abort whole learn on one missing path.
        this.logger.debug(
          `Learn skip path ${path}: ${err instanceof Error ? err.message : 'error'}`,
        );
      }
    }
    return results;
  }
}
