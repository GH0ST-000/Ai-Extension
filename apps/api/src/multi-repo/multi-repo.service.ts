import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
  ProjectSystem as ProjectSystemRow,
  ProjectSystemRepository as ProjectSystemRepositoryRow,
  Prisma,
} from '@prisma/client';
import {
  assertNoInventedRepositories,
  buildChangeImpactSkeleton,
  buildSimpleLinearFlow,
  compareHttpRequiredFieldsAdded,
  compareTopicRename,
  computeSystemContextVersion,
  detectHttpConsumerPaths,
  detectHttpProviderPaths,
  computeDownstreamImpact,
  detectHttpCalls,
  httpPathsMatch,
  parseEndpointSpec,
  detectKafkaTopicUsages,
  detectRouteDefinitions,
  extractOpenApiOperations,
  looksLikeOpenApiPath,
  matchHttpDependencies,
  parseServiceDependencyManifest,
  SERVICE_MANIFEST_PATH,
  type CallSite,
  type DeclaredDependency,
  type ProviderOperation,
  type RepoHttpFacts,
  knownInSelectedScope,
  MULTI_REPO_MAX_FILES_PER_REPO,
  MULTI_REPO_MAX_HTTP_OPS,
  MULTI_REPO_MAX_KAFKA_TOPICS,
  MULTI_REPO_MAX_RELATIONSHIPS,
  MULTI_REPO_MAX_REPOS_PER_ANALYSIS,
  MULTI_REPO_MAX_REPOS_PER_SYSTEM,
  normalizeOwnerRepo,
  notEvidentInScope,
  parseOwnerRepo,
  parsePackageJsonManifest,
  partialScopeUnavailable,
  remainingTotalFileBudget,
  repositoryKey,
  sameRepository,
  systemFlowIncomplete,
  toRepositoryIdentity,
  truncateToBudget,
  validateAnalysisRepositorySelection,
  effectiveMaxProjectSystems,
  effectiveMaxRepositoriesPerSystem,
} from '@project-x/shared';
import type {
  AddSystemRepositoryRequest,
  ApiContractChange,
  DownstreamImpactResult,
  AnalyzeChangeImpactRequest,
  CreateProjectSystemRequest,
  DiscoverRelationshipsResponse,
  MultiRepoArchitectureContext,
  MultiRepoChangeImpactAnalysis,
  MultiRepoContractResource,
  MultiRepoEvidence,
  MultiRepoHttpResource,
  MultiRepoImpactItem,
  MultiRepoImpactType,
  MultiRepoKafkaResource,
  MultiRepoRepositoryRole,
  MultiRepoRepositorySource,
  MultiRepoRequirementCoverage,
  MultiRepoRequiresChange,
  MultiRepoRepositoryScan,
  MultiRepoScanIssueCode,
  MultiRepoScanReport,
  ProjectSystem,
  RelatedRepositoryCandidate,
  RelationshipConfidence,
  RelationshipProvenance,
  RelationshipResourceKind,
  RepositoryIdentity,
  RepositoryRelationship,
  RepositoryRelationshipType,
  SystemFlowNode,
  SystemFlowTrace,
  TraceSystemFlowRequest,
  UpdateProjectSystemRequest,
} from '@project-x/types';

import { MULTI_REPO_MAX_CANDIDATE_LOOKUPS, MULTI_REPO_MAX_GITHUB_REQUESTS } from '@project-x/types';

import { GithubContentService } from '../github/github-content.service';
import { PrismaService } from '../prisma/prisma.service';
import { SecurityAuditService } from '../observability/security-audit.service';
import { resolveWorkspaceIdForUser } from '../workspaces/resolve-workspace-id';
import { WorkspaceAuthorizationService } from '../workspaces/workspace-authorization.service';
import { recordWorkspaceAudit } from '../workspaces/workspace-audit';
import type { SecurityAuditEventType, WorkspacePermission } from '@project-x/types';
import { FeatureGate } from '../entitlements/feature-gate';
import { EntitlementService } from '../entitlements/entitlements.service';
import { UsageService, withRetry } from '../usage/usage.service';
import { ProjectMemoryService } from '../project-memory/project-memory.service';
import {
  GithubAccessService,
  type RepositoryAccessDenial,
} from '../github-app/github-access.service';
import { multiRepoException } from './multi-repo.errors';
import { toProjectSystem, toRepositoryRelationship } from './multi-repo.mapper';
import { RepositoryScanner, ScanBudget, type ScannedFile } from './repository-scanner';
import { loadScopedHttpConsumers } from '../contract-impact/contract-impact.service';

type SystemWithRepos = ProjectSystemRow & {
  repositories: ProjectSystemRepositoryRow[];
};

type FetchedFile = {
  path: string;
  content: string;
};

const KNOWN_SIGNAL_PATHS = [
  'package.json',
  'README.md',
  'openapi.yaml',
  'openapi.yml',
  'openapi.json',
  'swagger.yaml',
  'swagger.yml',
  'swagger.json',
  'docs/openapi.yaml',
  'docs/openapi.yml',
  'docs/openapi.json',
  'api/openapi.yaml',
  'api/openapi.yml',
  'api/openapi.json',
] as const;

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;

type ProposedProvenance = Omit<RelationshipProvenance, 'observedAt'>;

type ProposedRelationship = {
  from: RepositoryIdentity;
  to: RepositoryIdentity;
  type: RepositoryRelationshipType;
  resourceKind?: RelationshipResourceKind;
  resourceKey?: string;
  confidence: RelationshipConfidence;
  provenance: ProposedProvenance[];
};

type DiscoveryResult = {
  analyzed: number;
  relationships: RepositoryRelationship[];
  candidates: RelatedRepositoryCandidate[];
  unavailable: RepositoryIdentity[];
  truncated: boolean;
  scan: MultiRepoScanReport;
};

/** HTTP dependency rows (endpoint-level or declared service-level). */
function isHttpRelationship(rel: RepositoryRelationship): boolean {
  return (
    rel.type === 'HTTP_CALLS' ||
    rel.type === 'CONSUMES_API' ||
    rel.resource?.kind === 'http_operation' ||
    rel.resource?.kind === 'service'
  );
}

/**
 * Does any changed-operation identifier ("GET /api/users", "/api/users/{id}") denote the
 * relationship's operation? Canonical path equality (parameter names ignored) and equal
 * methods when the identifier has one — no substring matching.
 */
function httpOperationTouched(relationshipKey: string, identifiers: string[]): boolean {
  const op = parseEndpointSpec(relationshipKey);
  if (!op) return false;
  return identifiers.some((raw) => {
    const id = parseEndpointSpec(raw);
    if (!id) return false;
    if (id.method && op.method && id.method !== op.method) return false;
    return id.path === op.path || httpPathsMatch(id.path, op.path);
  });
}

/** Identity of one relationship row within a user's system (matches the upsert lookup). */
function relationshipRowKey(rel: {
  from: { owner: string; repository: string };
  to: { owner: string; repository: string };
  type: string;
  resourceKind?: string;
  resourceKey?: string;
}): string {
  return [
    rel.from.owner,
    rel.from.repository,
    rel.to.owner,
    rel.to.repository,
    rel.type,
    rel.resourceKind ?? '',
    rel.resourceKey ?? '',
  ].join('|');
}

const CONFIDENCE_RANK: Record<RelationshipConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const ROLE_HINTS: Array<{ role: MultiRepoRepositoryRole; tokens: string[] }> = [
  { role: 'frontend', tokens: ['frontend', 'ui', 'web', 'client', 'dashboard', 'react', 'next'] },
  { role: 'backend', tokens: ['backend', 'api', 'server', 'service', 'nest'] },
  { role: 'worker', tokens: ['worker', 'consumer', 'job', 'queue', 'kafka'] },
  { role: 'gateway', tokens: ['gateway', 'bff', 'proxy'] },
  { role: 'shared-contract', tokens: ['contract', 'sdk', 'types', 'openapi', 'schema'] },
  { role: 'library', tokens: ['lib', 'library', 'package', 'shared'] },
];

@Injectable()
export class MultiRepoService {
  private readonly logger = new Logger(MultiRepoService.name);
  /** Creates the per-analysis GitHub scanner (replaceable in tests; no network in tests). */
  scannerFactory: (token: string, budget: ScanBudget) => RepositoryScanner = (token, budget) =>
    new RepositoryScanner(token, budget);

  constructor(
    private readonly prisma: PrismaService,
    private readonly githubAccess: GithubAccessService,
    private readonly githubContent: GithubContentService,
    private readonly projectMemory: ProjectMemoryService,
    private readonly featureGate: FeatureGate,
    private readonly entitlements: EntitlementService,
    private readonly usage: UsageService,
    private readonly authorization: WorkspaceAuthorizationService,
    @Optional() private readonly audit?: SecurityAuditService,
  ) {}

  /**
   * M4 — the single authorization step of every Systems entry point (HTTP and internal).
   * Resolves the acting workspace (X-Workspace-Id, else the documented fallback), then the
   * existing RBAC check: active membership, ACTIVE workspace (deleted / deletion_pending are
   * refused), and the permission. Nothing is read or changed before it passes.
   */
  private async authorize(userId: string, permission: WorkspacePermission): Promise<string> {
    const workspaceId = await resolveWorkspaceIdForUser(this.prisma, userId);
    await this.authorization.assertAccess({ userId, workspaceId, permission });
    return workspaceId;
  }

  /**
   * A configuration change (systems:manage): authorized, executed, audited. Refusals are
   * audited as `systems.access.denied`. Safe metadata only — ids and action, never repository
   * contents or tokens.
   */
  private async managed<T>(
    userId: string,
    action: { type: SecurityAuditEventType; name: string; targetId?: string },
    run: (workspaceId: string) => Promise<T>,
    targetOf?: (result: T) => string | undefined,
  ): Promise<T> {
    let workspaceId: string | undefined;
    try {
      workspaceId = await resolveWorkspaceIdForUser(this.prisma, userId);
      await this.authorization.assertAccess({ userId, workspaceId, permission: 'systems:manage' });
    } catch (error) {
      if (workspaceId) {
        recordWorkspaceAudit(this.audit, this.logger, {
          type: 'systems.access.denied',
          outcome: 'blocked',
          actorUserId: userId,
          workspaceId,
          action: action.name,
          ...(action.targetId ? { targetId: action.targetId } : {}),
        });
      }
      throw error;
    }
    const result = await run(workspaceId);
    const targetId = action.targetId ?? targetOf?.(result);
    recordWorkspaceAudit(this.audit, this.logger, {
      type: action.type,
      outcome: 'success',
      actorUserId: userId,
      workspaceId,
      action: action.name,
      ...(targetId ? { targetId } : {}),
    });
    return result;
  }

  async listSystems(userId: string): Promise<ProjectSystem[]> {
    const workspaceId = await this.authorize(userId, 'systems:read');
    const rows = await this.prisma.projectSystem.findMany({
      where: { workspaceId },
      include: { repositories: { orderBy: { createdAt: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(toProjectSystem);
  }

  async createSystem(userId: string, input: CreateProjectSystemRequest): Promise<ProjectSystem> {
    return this.managed(
      userId,
      { type: 'systems.system.created', name: 'create_system' },
      (workspaceId) => this.createSystemIn(workspaceId, userId, input),
      (created) => created.id,
    );
  }

  private async createSystemIn(
    workspaceId: string,
    userId: string,
    input: CreateProjectSystemRequest,
  ): Promise<ProjectSystem> {
    await this.featureGate.require(workspaceId, 'MULTI_REPO_INTELLIGENCE');
    const ents = await this.entitlements.getEntitlements(workspaceId);
    const maxSystems = effectiveMaxProjectSystems(ents.maxProjectSystems);
    const existingCount = await this.prisma.projectSystem.count({ where: { workspaceId } });
    if (existingCount >= maxSystems) {
      throw multiRepoException(
        'SYSTEM_REPOSITORY_LIMIT_REACHED',
        `Your current plan supports up to ${maxSystems} project systems.`,
      );
    }
    const primary = normalizeOwnerRepo(input.primaryOwner, input.primaryRepository);
    await this.assertRepositoryAccess(userId, primary.owner, primary.repository);

    const extras = (input.repositories ?? []).map((repo) => ({
      ...normalizeOwnerRepo(repo.owner, repo.repository),
      role: (repo.role ?? 'unknown') as MultiRepoRepositoryRole,
      enabled: repo.enabled !== false,
    }));

    const byKey = new Map<
      string,
      { owner: string; repository: string; role: MultiRepoRepositoryRole; enabled: boolean }
    >();
    byKey.set(`${primary.owner}/${primary.repository}`, {
      owner: primary.owner,
      repository: primary.repository,
      role: 'unknown',
      enabled: true,
    });
    for (const extra of extras) {
      const key = `${extra.owner}/${extra.repository}`;
      if (!byKey.has(key)) {
        byKey.set(key, extra);
      }
    }

    const maxRepos = effectiveMaxRepositoriesPerSystem(ents.maxRepositoriesPerSystem);
    if (byKey.size > Math.min(MULTI_REPO_MAX_REPOS_PER_SYSTEM, maxRepos)) {
      throw multiRepoException(
        'SYSTEM_REPOSITORY_LIMIT_REACHED',
        `A system may include at most ${Math.min(MULTI_REPO_MAX_REPOS_PER_SYSTEM, maxRepos)} repositories.`,
      );
    }

    for (const repo of byKey.values()) {
      if (repo.owner === primary.owner && repo.repository === primary.repository) continue;
      await this.assertRepositoryAccess(userId, repo.owner, repo.repository);
    }

    const created = await this.prisma.projectSystem.create({
      data: {
        userId,
        workspaceId,
        createdByUserId: userId,
        name: input.name.trim(),
        primaryProvider: 'github',
        primaryOwner: primary.owner,
        primaryRepository: primary.repository,
        repositories: {
          create: [...byKey.values()].map((repo) => ({
            provider: 'github',
            owner: repo.owner,
            repository: repo.repository,
            role: repo.role,
            enabled: repo.enabled,
            source: 'user_selected',
          })),
        },
      },
      include: { repositories: { orderBy: { createdAt: 'asc' } } },
    });

    return toProjectSystem(created);
  }

  async getSystem(userId: string, systemId: string): Promise<ProjectSystem> {
    const row = await this.requireSystem(userId, systemId);
    return toProjectSystem(row);
  }

  async updateSystem(
    userId: string,
    systemId: string,
    patch: UpdateProjectSystemRequest,
  ): Promise<ProjectSystem> {
    return this.managed(
      userId,
      { type: 'systems.system.updated', name: 'update_system', targetId: systemId },
      () => this.updateSystemAuthorized(userId, systemId, patch),
    );
  }

  private async updateSystemAuthorized(
    userId: string,
    systemId: string,
    patch: UpdateProjectSystemRequest,
  ): Promise<ProjectSystem> {
    const existing = await this.requireSystem(userId, systemId, 'systems:manage');
    const nextPrimary =
      patch.primaryOwner || patch.primaryRepository
        ? normalizeOwnerRepo(
            patch.primaryOwner ?? existing.primaryOwner,
            patch.primaryRepository ?? existing.primaryRepository,
          )
        : null;

    if (nextPrimary) {
      await this.assertRepositoryAccess(userId, nextPrimary.owner, nextPrimary.repository);
      const hasPrimary = existing.repositories.some(
        (r) => r.owner === nextPrimary.owner && r.repository === nextPrimary.repository,
      );
      if (!hasPrimary) {
        if (existing.repositories.length >= MULTI_REPO_MAX_REPOS_PER_SYSTEM) {
          throw multiRepoException(
            'SYSTEM_REPOSITORY_LIMIT_REACHED',
            `A system may include at most ${MULTI_REPO_MAX_REPOS_PER_SYSTEM} repositories.`,
          );
        }
        await this.prisma.projectSystemRepository.create({
          data: {
            systemId,
            provider: 'github',
            owner: nextPrimary.owner,
            repository: nextPrimary.repository,
            role: 'unknown',
            enabled: true,
            source: 'user_selected',
          },
        });
      }
    }

    const updated = await this.prisma.projectSystem.update({
      where: { id: systemId },
      data: {
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(nextPrimary
          ? {
              primaryOwner: nextPrimary.owner,
              primaryRepository: nextPrimary.repository,
            }
          : {}),
      },
      include: { repositories: { orderBy: { createdAt: 'asc' } } },
    });

    return toProjectSystem(updated);
  }

  async deleteSystem(userId: string, systemId: string): Promise<{ deleted: true; id: string }> {
    return this.managed(
      userId,
      { type: 'systems.system.deleted', name: 'delete_system', targetId: systemId },
      async () => {
        await this.requireSystem(userId, systemId, 'systems:manage');
        await this.prisma.projectSystem.delete({ where: { id: systemId } });
        return { deleted: true as const, id: systemId };
      },
    );
  }

  async addRepository(
    userId: string,
    systemId: string,
    input: AddSystemRepositoryRequest,
  ): Promise<ProjectSystem> {
    return this.managed(
      userId,
      { type: 'systems.repository.added', name: 'add_repository', targetId: systemId },
      () => this.addRepositoryAuthorized(userId, systemId, input),
    );
  }

  private async addRepositoryAuthorized(
    userId: string,
    systemId: string,
    input: AddSystemRepositoryRequest,
  ): Promise<ProjectSystem> {
    const system = await this.requireSystem(userId, systemId, 'systems:manage');
    const identity = normalizeOwnerRepo(input.owner, input.repository);
    await this.assertRepositoryAccess(userId, identity.owner, identity.repository);

    const exists = system.repositories.some(
      (r) => r.owner === identity.owner && r.repository === identity.repository,
    );
    if (exists) {
      throw multiRepoException(
        'RELATIONSHIP_CONFLICT',
        `Repository ${identity.owner}/${identity.repository} is already in this system.`,
      );
    }

    if (system.repositories.length >= MULTI_REPO_MAX_REPOS_PER_SYSTEM) {
      throw multiRepoException(
        'SYSTEM_REPOSITORY_LIMIT_REACHED',
        `A system may include at most ${MULTI_REPO_MAX_REPOS_PER_SYSTEM} repositories.`,
      );
    }

    await this.prisma.projectSystemRepository.create({
      data: {
        systemId,
        provider: 'github',
        owner: identity.owner,
        repository: identity.repository,
        role: (input.role ?? 'unknown') as string,
        enabled: input.enabled !== false,
        source: (input.source ?? 'user_selected') as MultiRepoRepositorySource,
      },
    });

    return this.getSystem(userId, systemId);
  }

  async updateRepository(
    userId: string,
    systemId: string,
    ownerRaw: string,
    repositoryRaw: string,
    input: { role?: MultiRepoRepositoryRole; enabled?: boolean },
  ): Promise<ProjectSystem> {
    return this.managed(
      userId,
      { type: 'systems.repository.updated', name: 'update_repository', targetId: systemId },
      () => this.updateRepositoryAuthorized(userId, systemId, ownerRaw, repositoryRaw, input),
    );
  }

  private async updateRepositoryAuthorized(
    userId: string,
    systemId: string,
    ownerRaw: string,
    repositoryRaw: string,
    input: { role?: MultiRepoRepositoryRole; enabled?: boolean },
  ): Promise<ProjectSystem> {
    const system = await this.requireSystem(userId, systemId, 'systems:manage');
    const identity = normalizeOwnerRepo(ownerRaw, repositoryRaw);
    const row = system.repositories.find(
      (r) => r.owner === identity.owner && r.repository === identity.repository,
    );
    if (!row) {
      throw multiRepoException(
        'SYSTEM_CONTEXT_NOT_CONFIGURED',
        `Repository ${identity.owner}/${identity.repository} is not in this system.`,
      );
    }

    const isPrimary =
      identity.owner === system.primaryOwner && identity.repository === system.primaryRepository;
    if (isPrimary && input.enabled === false) {
      throw multiRepoException(
        'RELATIONSHIP_CONFLICT',
        'Cannot disable the primary repository. Update the primary first or delete the system.',
      );
    }

    if (input.role === undefined && input.enabled === undefined) {
      return this.getSystem(userId, systemId);
    }

    await this.prisma.projectSystemRepository.update({
      where: { id: row.id },
      data: {
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      },
    });

    return this.getSystem(userId, systemId);
  }

  async removeRepository(
    userId: string,
    systemId: string,
    ownerRaw: string,
    repositoryRaw: string,
  ): Promise<ProjectSystem> {
    return this.managed(
      userId,
      { type: 'systems.repository.removed', name: 'remove_repository', targetId: systemId },
      () => this.removeRepositoryAuthorized(userId, systemId, ownerRaw, repositoryRaw),
    );
  }

  private async removeRepositoryAuthorized(
    userId: string,
    systemId: string,
    ownerRaw: string,
    repositoryRaw: string,
  ): Promise<ProjectSystem> {
    const system = await this.requireSystem(userId, systemId, 'systems:manage');
    const identity = normalizeOwnerRepo(ownerRaw, repositoryRaw);

    if (
      identity.owner === system.primaryOwner &&
      identity.repository === system.primaryRepository
    ) {
      throw multiRepoException(
        'RELATIONSHIP_CONFLICT',
        'Cannot remove the primary repository. Update the primary first or delete the system.',
      );
    }

    const row = system.repositories.find(
      (r) => r.owner === identity.owner && r.repository === identity.repository,
    );
    if (!row) {
      throw multiRepoException(
        'SYSTEM_CONTEXT_NOT_CONFIGURED',
        `Repository ${identity.owner}/${identity.repository} is not in this system.`,
      );
    }

    await this.prisma.$transaction([
      this.prisma.repositoryRelationship.deleteMany({
        where: {
          systemId,
          OR: [
            { fromOwner: identity.owner, fromRepository: identity.repository },
            { toOwner: identity.owner, toRepository: identity.repository },
          ],
        },
      }),
      this.prisma.projectSystemRepository.delete({ where: { id: row.id } }),
    ]);

    return this.getSystem(userId, systemId);
  }

  async listRelationships(userId: string, systemId: string): Promise<RepositoryRelationship[]> {
    const system = await this.requireSystem(userId, systemId);
    const rows = await this.prisma.repositoryRelationship.findMany({
      where: { userId, systemId, workspaceId: system.workspaceId },
      orderBy: [{ updatedAt: 'desc' }],
      take: MULTI_REPO_MAX_RELATIONSHIPS,
    });
    return rows.map(toRepositoryRelationship);
  }

  /**
   * Fresh scan + summary. Same plan check and usage charge as Discover: both run the same
   * scanner (reading saved relationships is `listRelationships`, which is free).
   */
  async refreshSystemContext(
    userId: string,
    systemId: string,
  ): Promise<{
    analyzed: number;
    relationshipsChecked: number;
    candidates: RelatedRepositoryCandidate[];
    unavailable: RepositoryIdentity[];
    truncated: boolean;
    scan: MultiRepoScanReport;
  }> {
    const started = Date.now();
    const discovery = await this.chargedDiscovery(userId, systemId);
    const active = discovery.relationships.filter((r) => r.status === 'active').length;
    this.logger.log({
      msg: 'multi_repo_refresh',
      systemId,
      analyzed: discovery.analyzed,
      relationshipsActive: active,
      candidates: discovery.candidates.length,
      unavailable: discovery.unavailable.length,
      truncated: discovery.truncated,
      partial: discovery.scan.partial,
      githubRequests: discovery.scan.githubRequests,
      durationMs: Date.now() - started,
    });
    return {
      analyzed: discovery.analyzed,
      // Relationships currently known for the system after this scan (superseded excluded).
      relationshipsChecked: active,
      candidates: discovery.candidates,
      unavailable: discovery.unavailable,
      truncated: discovery.truncated,
      scan: discovery.scan,
    };
  }

  /**
   * One analysis = one unit, charged only when it completes: reserved up front (quota is
   * enforced atomically), committed on success, refunded when the analysis fails.
   * `inFlightKey` rejects a second identical operation while one is running (409).
   */
  private async charged<T>(
    workspaceId: string,
    userId: string,
    run: () => Promise<T>,
    inFlightKey?: string,
  ): Promise<T> {
    const reservation = await this.usage.reserve({
      workspaceId,
      userId,
      metric: 'multi_repo_analysis',
      operationId: randomUUID(),
      ...(inFlightKey ? { inFlightKey } : {}),
    });
    // Analyses can outlast a lease: keep it alive so recovery never settles a running one.
    const stopHeartbeat = this.usage.startHeartbeat(reservation);
    let result: T;
    try {
      result = await run();
    } catch (error) {
      stopHeartbeat();
      await withRetry(() => this.usage.releaseReservation(reservation)).catch(() => false);
      throw error;
    }
    stopHeartbeat();
    // Idempotent; if it still fails, the expired lease is recovered later (refund, logged).
    await withRetry(() => this.usage.commit(reservation)).catch(() => false);
    return result;
  }

  /**
   * The single entry point for a fresh scan: workspace + system authorization, plan check,
   * usage charge, and one scan at a time per user and system (Refresh and Discover share it).
   */
  private async chargedDiscovery(userId: string, systemId: string): Promise<DiscoveryResult> {
    // systems:read (product decision, M4): discovery stores only the caller's own findings.
    const workspaceId = await this.authorize(userId, 'systems:read');
    await this.requireSystem(userId, systemId); // 404 before anything is reserved
    await this.featureGate.require(workspaceId, 'MULTI_REPO_INTELLIGENCE');
    return this.charged(
      workspaceId,
      userId,
      () => this.runDiscovery(userId, systemId),
      `multi_repo_scan:${userId}:${systemId}`,
    );
  }

  async discoverRelationships(
    userId: string,
    systemId: string,
  ): Promise<DiscoverRelationshipsResponse> {
    const discovery = await this.chargedDiscovery(userId, systemId);
    return {
      systemId,
      relationships: discovery.relationships,
      candidates: discovery.candidates,
      truncated: discovery.truncated,
      scan: discovery.scan,
    };
  }

  async buildArchitectureContext(
    userId: string,
    systemId: string,
    opts?: { repositoryKeys?: string[]; maxRepos?: number },
  ): Promise<MultiRepoArchitectureContext> {
    const system = await this.requireSystem(userId, systemId);
    const enabled = system.repositories.filter((r) => r.enabled);
    const maxRepos = Math.min(
      opts?.maxRepos ?? MULTI_REPO_MAX_REPOS_PER_ANALYSIS,
      MULTI_REPO_MAX_REPOS_PER_ANALYSIS,
    );

    let selected = enabled;
    if (opts?.repositoryKeys?.length) {
      const keySet = new Set(opts.repositoryKeys.map((k) => k.toLowerCase()));
      selected = enabled.filter((r) =>
        keySet.has(repositoryKey({ provider: 'github', owner: r.owner, repository: r.repository })),
      );
      if (selected.length === 0) {
        throw multiRepoException(
          'SYSTEM_CONTEXT_NOT_CONFIGURED',
          'No matching enabled repositories for the requested keys.',
        );
      }
    }

    const { items: clamped, truncated: repoTruncated } = truncateToBudget(selected, maxRepos);
    const unavailable: RepositoryIdentity[] = [];
    const summaries: MultiRepoArchitectureContext['repositories'] = [];
    const filesAnalyzed = 0;

    for (const repo of clamped) {
      const identity = toRepositoryIdentity(repo.owner, repo.repository);
      const ok = await this.tryAuthorize(userId, repo.owner, repo.repository);
      let memoryVersion: string | undefined;
      if (ok) {
        try {
          const profile = await this.projectMemory.getProfile(userId, repo.owner, repo.repository);
          memoryVersion = profile.memoryVersion;
        } catch {
          // Soft: profiles are optional.
        }
      } else {
        unavailable.push(identity);
      }
      summaries.push({
        repository: identity,
        role: repo.role as MultiRepoRepositoryRole,
        enabled: repo.enabled,
        available: ok,
        ...(memoryVersion ? { memoryVersion } : {}),
      });
    }

    const relationships = (
      await this.prisma.repositoryRelationship.findMany({
        where: { userId, systemId, status: 'active' },
        take: MULTI_REPO_MAX_RELATIONSHIPS,
      })
    ).map(toRepositoryRelationship);

    const httpOperations = this.aggregateHttpResources(relationships);
    const kafkaTopics = this.aggregateKafkaResources(relationships);
    const sharedContracts = this.aggregateContractResources(relationships);

    const version = computeSystemContextVersion({
      systemId,
      repositories: summaries.map((s) => ({
        repository: s.repository,
        enabled: s.enabled,
        role: s.role,
        memoryVersion: s.memoryVersion,
        headSha: s.headSha,
      })),
      relationships,
    });

    return {
      system: { id: system.id, name: system.name },
      primaryRepository: toRepositoryIdentity(system.primaryOwner, system.primaryRepository),
      repositories: summaries,
      relationships,
      resources: {
        httpOperations: truncateToBudget(httpOperations, MULTI_REPO_MAX_HTTP_OPS).items,
        kafkaTopics: truncateToBudget(kafkaTopics, MULTI_REPO_MAX_KAFKA_TOPICS).items,
        sharedContracts,
      },
      scope: {
        repositoriesRequested: selected.length,
        repositoriesAnalyzed: summaries.filter((s) => s.available).length,
        repositoriesUnavailable: unavailable.length,
        filesAnalyzed,
        truncated: repoTruncated || httpOperations.length > MULTI_REPO_MAX_HTTP_OPS,
      },
      generatedAt: new Date().toISOString(),
      version,
    };
  }

  async analyzeChangeImpact(
    userId: string,
    input: AnalyzeChangeImpactRequest,
  ): Promise<MultiRepoChangeImpactAnalysis> {
    const workspaceId = await this.authorize(userId, 'systems:read');
    await this.featureGate.require(workspaceId, 'MULTI_REPO_INTELLIGENCE');
    return this.charged(workspaceId, userId, async () => {
      const system = await this.requireSystem(userId, input.systemId);
      const primary = normalizeOwnerRepo(input.owner, input.repository);
      const primaryIdentity = toRepositoryIdentity(primary.owner, primary.repository);

      const enabledIdentities = system.repositories
        .filter((r) => r.enabled)
        .map((r) => toRepositoryIdentity(r.owner, r.repository));

      const selection = input.repositoryIds?.length
        ? validateAnalysisRepositorySelection(
            input.repositoryIds.map((id) => {
              const [owner, repository] = id.includes('/') ? id.split('/') : ['', id];
              const parsed =
                parseOwnerRepo(id) ?? normalizeOwnerRepo(owner || primary.owner, repository || id);
              return toRepositoryIdentity(parsed.owner, parsed.repository);
            }),
            enabledIdentities,
          )
        : {
            ok: true as const,
            value: truncateToBudget(
              [
                primaryIdentity,
                ...enabledIdentities.filter((r) => !sameRepository(r, primaryIdentity)),
              ],
              MULTI_REPO_MAX_REPOS_PER_ANALYSIS,
            ).items,
          };

      if (!selection.ok) {
        throw multiRepoException(selection.code, selection.message);
      }

      const invented = assertNoInventedRepositories(selection.value, enabledIdentities);
      if (!invented.ok) {
        throw multiRepoException(invented.code, invented.message);
      }

      const context = await this.buildArchitectureContext(userId, input.systemId, {
        maxRepos: MULTI_REPO_MAX_REPOS_PER_ANALYSIS,
      });

      const unavailable = context.repositories.filter((r) => !r.available).map((r) => r.repository);
      const analyzed = context.repositories.filter((r) => r.available).map((r) => r.repository);

      const identifiers = await this.extractChangeIdentifiers(userId, input, primary);
      // Downstream only: repositories that depend ON the changed repository (from → primary).
      // Calls the primary makes to others, and provider-operation self rows, are not impact
      // of a change to the primary.
      const relationships = context.relationships.filter(
        (rel) =>
          sameRepository(rel.to, primaryIdentity) && !sameRepository(rel.from, primaryIdentity),
      );

      const analysis = buildChangeImpactSkeleton({
        systemId: input.systemId,
        primaryRepository: primaryIdentity,
        summary: input.summary?.trim() || 'Change impact analysis for selected repositories.',
        pullRequestNumber: input.pullRequestNumber,
        headSha: input.headSha,
        repositoriesAnalyzed: analyzed,
      });
      analysis.scope.repositoriesUnavailable = unavailable;
      analysis.scope.truncated = context.scope.truncated;
      analysis.scope.version = context.version;

      const impacted: MultiRepoImpactItem[] = [];
      const seen = new Set<string>();

      // HTTP consumers whose operation this change appears to touch. Without a verified
      // contract diff this is NOT evidence of breaking impact (see computeContractDownstreamImpact).
      const unverifiedHttp = new Map<
        string,
        { repository: RepositoryIdentity; operations: Set<string>; evidence: MultiRepoEvidence[] }
      >();

      for (const rel of relationships) {
        const other = rel.from;
        if (
          !analyzed.some((r) => sameRepository(r, other)) &&
          !unavailable.some((r) => sameRepository(r, other))
        ) {
          continue;
        }
        if (unavailable.some((r) => sameRepository(r, other))) continue;

        if (isHttpRelationship(rel)) {
          // Canonical method + path only — never file names, substrings or shared endpoints.
          const key = rel.resource?.kind === 'http_operation' ? rel.resource.key : undefined;
          if (key && httpOperationTouched(key, identifiers.httpKeys)) {
            const entry = unverifiedHttp.get(repositoryKey(other)) ?? {
              repository: other,
              operations: new Set<string>(),
              evidence: [],
            };
            entry.operations.add(key);
            const call = rel.provenance.find((p) => p.type === 'http_call');
            if (call && entry.evidence.length < 5) {
              entry.evidence.push({
                repository: other,
                type: 'api_operation',
                ref: key,
                ...(call.filePath ? { path: call.filePath } : {}),
                summary: call.summary,
                trust: 'deterministic_source',
              });
            }
            unverifiedHttp.set(repositoryKey(other), entry);
          }
          continue;
        }

        const matched = this.relationshipMatchesIdentifiers(rel, identifiers);
        const key = repositoryKey(other);
        if (seen.has(key) && !matched) continue;

        const evidence: MultiRepoEvidence[] = matched
          ? [
              {
                repository: primaryIdentity,
                type: rel.resource?.kind === 'kafka_topic' ? 'kafka_topic' : 'api_operation',
                ref: rel.resource?.key ?? rel.type,
                path: rel.provenance[0]?.filePath,
                summary: rel.provenance[0]?.summary ?? `Relationship ${rel.type}`,
                trust: 'deterministic_source',
              },
            ]
          : [];

        const requiresChange: MultiRepoRequiresChange = evidence.length > 0 ? 'yes' : 'not_evident';
        const impactType = this.impactTypeForRelationship(rel.type);
        const item: MultiRepoImpactItem = {
          repository: other,
          likelihood:
            evidence.length > 0 ? (rel.confidence === 'high' ? 'high' : 'medium') : 'uncertain',
          impactType,
          summary:
            evidence.length > 0
              ? `${knownInSelectedScope('impacted repositories')} ${rel.type} via ${rel.resource?.key ?? 'relationship'}.`
              : notEvidentInScope('Cross-repo impact'),
          evidence,
          requiresChange,
        };

        if (seen.has(key)) {
          const existing = impacted.find((i) => sameRepository(i.repository, other));
          if (existing && evidence.length > 0 && existing.requiresChange !== 'yes') {
            existing.requiresChange = 'yes';
            existing.evidence = evidence;
            existing.summary = item.summary;
            existing.likelihood = item.likelihood;
            existing.impactType = impactType;
          }
          continue;
        }
        seen.add(key);
        impacted.push(item);
      }

      // Compatibility helpers for topic rename / required fields when identifiers hint them.
      for (const rename of identifiers.topicRenames) {
        const compat = compareTopicRename(rename.before, rename.after, []);
        if (compat.status === 'breaking_evidence' || compat.status === 'potentially_breaking') {
          analysis.contractImpacts.push({
            kind: 'kafka',
            key: `${rename.before}->${rename.after}`,
            changeSummary: compat.reasons[0]?.summary ?? 'Topic rename detected.',
            compatibility: compat.status,
          });
        }
      }
      for (const http of identifiers.httpRequiredFieldAdds) {
        const compat = compareHttpRequiredFieldsAdded(http.before, http.after, []);
        if (compat.status !== 'compatible') {
          analysis.contractImpacts.push({
            kind: 'http',
            key: http.path,
            changeSummary: compat.reasons.map((r) => r.summary).join(' '),
            compatibility: compat.status,
          });
        }
      }

      analysis.impactedRepositories = impacted.filter((i) => i.requiresChange === 'yes');
      for (const entry of unverifiedHttp.values()) {
        const ops = [...entry.operations].sort().join(', ');
        analysis.risks.push({
          code: 'HTTP_CONTRACT_IMPACT_UNVERIFIED',
          severity: 'medium',
          summary: `${entry.repository.owner}/${entry.repository.repository} calls ${ops}, which this change appears to touch. No contract diff was available, so breaking impact is not verified.`,
          repositories: [entry.repository],
          evidence: entry.evidence,
        });
      }
      analysis.unaffectedOrNotEvident = enabledIdentities
        .filter(
          (repo) =>
            !sameRepository(repo, primaryIdentity) &&
            !analysis.impactedRepositories.some((i) => sameRepository(i.repository, repo)),
        )
        .map((repository) => {
          const unverified = unverifiedHttp.get(repositoryKey(repository));
          return {
            repository,
            reason: unavailable.some((u) => sameRepository(u, repository))
              ? partialScopeUnavailable(`${repository.owner}/${repository.repository}`)
              : unverified
                ? `Calls ${[...unverified.operations].sort().join(', ')}; contract impact not verified (no contract diff available).`
                : notEvidentInScope('Impact'),
          };
        });

      analysis.requiredCoordination = analysis.impactedRepositories.map((item) => ({
        repository: item.repository,
        reason: item.summary,
        suggestedAction: 'Review consumers/providers in the selected system before merge.',
      }));

      return analysis;
    });
  }

  /**
   * Downstream consumers of a VERIFIED contract diff of `owner/repository` (Phase 1: internal,
   * for callers that already hold a deterministic diff, e.g. PR Review in Phase 2).
   *
   * Authorization and scoping happen here, before the pure calculation sees any data:
   * systems of the caller's workspace that contain the provider as an ENABLED repository
   * (optionally one system), the caller's own ACTIVE `HTTP_CALLS` rows into the provider, and
   * only from repositories enabled in that system. No GitHub calls, no usage charge.
   */
  async computeContractDownstreamImpact(
    userId: string,
    input: {
      owner: string;
      repository: string;
      changes: ApiContractChange[];
      systemId?: string;
      now?: Date;
    },
  ): Promise<DownstreamImpactResult> {
    const workspaceId = await this.authorize(userId, 'systems:read');
    const provider = toRepositoryIdentity(input.owner, input.repository);
    const { relationships: scoped } = await loadScopedHttpConsumers(this.prisma, {
      userId,
      workspaceId,
      provider,
      ...(input.systemId ? { systemId: input.systemId } : {}),
    });
    return computeDownstreamImpact({
      provider,
      changes: input.changes,
      relationships: scoped,
      ...(input.now ? { now: input.now } : {}),
    });
  }

  async traceSystemFlow(userId: string, input: TraceSystemFlowRequest): Promise<SystemFlowTrace> {
    const system = await this.requireSystem(userId, input.systemId);
    const context = await this.buildArchitectureContext(userId, input.systemId, {
      maxRepos: MULTI_REPO_MAX_REPOS_PER_ANALYSIS,
    });
    const analyzed = context.repositories.filter((r) => r.available).map((r) => r.repository);
    const unavailable = context.repositories.filter((r) => !r.available).map((r) => r.repository);

    const trigger = input.trigger;
    const nodes: SystemFlowNode[] = [];
    const gaps: SystemFlowTrace['gaps'] = [];

    const startRepo =
      trigger.repository ?? toRepositoryIdentity(system.primaryOwner, system.primaryRepository);

    nodes.push({
      id: 'trigger',
      type:
        trigger.kind === 'http_operation'
          ? 'api_endpoint'
          : trigger.kind === 'kafka_topic'
            ? 'kafka_topic'
            : 'unknown',
      label: trigger.summary ?? trigger.key,
      repository: startRepo,
      resourceKey: trigger.key,
    });

    const matching = context.relationships.filter((rel) => {
      if (trigger.kind === 'http_operation') {
        return (
          rel.resource?.kind === 'http_operation' &&
          (rel.resource.key === trigger.key || rel.resource.key.endsWith(trigger.key))
        );
      }
      if (trigger.kind === 'kafka_topic') {
        return rel.resource?.kind === 'kafka_topic' && rel.resource.key === trigger.key;
      }
      return (
        sameRepository(rel.from, startRepo) ||
        sameRepository(rel.to, startRepo) ||
        (trigger.key
          ? rel.resource?.key?.includes(trigger.key) ||
            rel.provenance.some((p) => p.summary.includes(trigger.key))
          : false)
      );
    });

    let prevId = 'trigger';
    const seenRepos = new Set<string>([repositoryKey(startRepo)]);

    for (const rel of matching.slice(0, 12)) {
      const next = sameRepository(rel.from, startRepo) ? rel.to : rel.from;
      if (sameRepository(next, startRepo)) continue;
      if (!analyzed.some((r) => sameRepository(r, next))) {
        if (unavailable.some((r) => sameRepository(r, next))) {
          gaps.push({
            afterNodeId: prevId,
            summary: partialScopeUnavailable(`${next.owner}/${next.repository}`),
          });
        } else {
          gaps.push({
            afterNodeId: prevId,
            summary: systemFlowIncomplete(),
          });
        }
        continue;
      }
      const id = `node-${repositoryKey(next)}`;
      if (seenRepos.has(repositoryKey(next))) continue;
      seenRepos.add(repositoryKey(next));
      nodes.push({
        id,
        type: rel.type.includes('EVENT')
          ? rel.type.startsWith('PRODUCES')
            ? 'event_producer'
            : 'event_consumer'
          : rel.type.includes('API') || rel.type === 'HTTP_CALLS'
            ? 'http_client'
            : 'service',
        label: `${next.owner}/${next.repository}`,
        repository: next,
        resourceKey: rel.resource?.key,
        confidence: rel.confidence,
      });
      prevId = id;
    }

    if (matching.length === 0) {
      gaps.push({ afterNodeId: 'trigger', summary: systemFlowIncomplete() });
    }

    return buildSimpleLinearFlow({
      trigger,
      nodes,
      summary: nodes.length > 1 ? knownInSelectedScope('flow hops') : systemFlowIncomplete(),
      scope: {
        systemId: input.systemId,
        repositoriesAnalyzed: analyzed,
        repositoriesUnavailable: unavailable,
        filesAnalyzed: context.scope.filesAnalyzed,
        truncated: context.scope.truncated,
        version: context.version,
      },
      gaps,
    });
  }

  async compareRequirementAcrossRepos(
    userId: string,
    input: { systemId: string; issueKey: string; criteria?: string[] },
  ): Promise<MultiRepoRequirementCoverage> {
    const system = await this.requireSystem(userId, input.systemId);
    const criteria =
      input.criteria
        ?.map((c) => c.trim())
        .filter(Boolean)
        .slice(0, 40) ?? [input.issueKey.trim()].filter(Boolean);

    const enabled = system.repositories.filter((r) => r.enabled);
    const { items: clamped, truncated } = truncateToBudget(
      enabled,
      MULTI_REPO_MAX_REPOS_PER_ANALYSIS,
    );
    const analyzed: RepositoryIdentity[] = [];
    const unavailable: RepositoryIdentity[] = [];
    const repositories: MultiRepoRequirementCoverage['repositories'] = [];
    let filesAnalyzed = 0;

    for (const repo of clamped) {
      const identity = toRepositoryIdentity(repo.owner, repo.repository);
      const ok = await this.tryAuthorize(userId, repo.owner, repo.repository);
      if (!ok) {
        unavailable.push(identity);
        continue;
      }
      analyzed.push(identity);

      const files = await this.fetchHighSignalFiles(userId, repo.owner, repo.repository, 0);
      filesAnalyzed += files.length;
      const haystack = [
        repo.role,
        ...files.map((f) => f.path),
        ...files.map((f) => f.content.slice(0, 4000)),
      ]
        .join('\n')
        .toLowerCase();

      let memoryHint = '';
      try {
        const profile = await this.projectMemory.getProfile(userId, repo.owner, repo.repository);
        memoryHint = [...profile.architecture, ...profile.tooling, ...profile.conventions]
          .map((i) => `${i.key} ${i.value.summary}`)
          .join(' ')
          .toLowerCase();
      } catch {
        // optional
      }

      const roleTokens =
        ROLE_HINTS.find((h) => h.role === (repo.role as MultiRepoRepositoryRole))?.tokens ?? [];
      const combined = `${haystack}\n${memoryHint}\n${roleTokens.join(' ')}`;

      const criterionResults = criteria.map((criterion) => {
        const token = criterion.toLowerCase();
        const matched =
          combined.includes(token) ||
          token.split(/\s+/).some((t) => t.length > 2 && combined.includes(t));
        return {
          criterion,
          status: matched ? ('partial' as const) : ('not_evident' as const),
          ...(matched
            ? {
                evidence: [
                  {
                    repository: identity,
                    type: 'file' as const,
                    ref: files[0]?.path ?? repo.role,
                    path: files[0]?.path,
                    summary: `Keyword/path match for "${criterion}" in analyzed files or role hints.`,
                    trust: 'deterministic_source' as const,
                  },
                ],
              }
            : {}),
        };
      });

      const covered = criterionResults.filter((c) => c.status === 'partial').length;
      repositories.push({
        repository: identity,
        status:
          covered === 0
            ? 'not_evident'
            : covered === criterionResults.length
              ? 'partial'
              : 'partial',
        criteria: criterionResults,
        summary:
          covered === 0
            ? notEvidentInScope('Requirement coverage')
            : knownInSelectedScope('requirement signals'),
      });
    }

    const anyPartial = repositories.some((r) => r.status === 'partial');
    return {
      issueKey: input.issueKey,
      repositories,
      endToEndCoverage: anyPartial ? 'partial' : 'not_evident',
      missingAreas: [],
      scope: {
        systemId: input.systemId,
        repositoriesAnalyzed: analyzed,
        repositoriesUnavailable: unavailable,
        filesAnalyzed,
        truncated,
      },
    };
  }

  async findApiConsumers(
    userId: string,
    systemId: string,
    input: { method?: string; path: string; operationId?: string },
  ): Promise<{
    consumers: RepositoryIdentity[];
    relationships: RepositoryRelationship[];
    scope: MultiRepoArchitectureContext['scope'];
  }> {
    const context = await this.buildArchitectureContext(userId, systemId);
    const path = input.path.trim();
    const method = input.method?.trim().toUpperCase();
    const key = method ? `${method} ${path}` : path;

    const relationships = context.relationships.filter((rel) => {
      if (!['CONSUMES_API', 'HTTP_CALLS'].includes(rel.type)) return false;
      if (!rel.resource || rel.resource.kind !== 'http_operation') return false;
      const resourceKey = rel.resource.key;
      if (input.operationId && resourceKey.includes(input.operationId)) return true;
      if (method) {
        return resourceKey === key || resourceKey.endsWith(path);
      }
      return resourceKey === path || resourceKey.endsWith(path) || resourceKey.includes(path);
    });

    const consumers = relationships.map((rel) => rel.from);
    const invented = assertNoInventedRepositories(
      consumers,
      context.repositories.map((r) => r.repository),
    );
    if (!invented.ok) {
      throw multiRepoException(invented.code, invented.message);
    }

    return {
      consumers,
      relationships,
      scope: context.scope,
    };
  }

  async findEventConsumers(
    userId: string,
    systemId: string,
    input: { topic: string; eventType?: string },
  ): Promise<{
    consumers: RepositoryIdentity[];
    relationships: RepositoryRelationship[];
    scope: MultiRepoArchitectureContext['scope'];
  }> {
    const context = await this.buildArchitectureContext(userId, systemId);
    const topic = input.topic.trim();

    const relationships = context.relationships.filter((rel) => {
      if (rel.type !== 'CONSUMES_EVENT') return false;
      if (!rel.resource || rel.resource.kind !== 'kafka_topic') return false;
      if (rel.resource.key !== topic) return false;
      if (input.eventType) {
        return rel.provenance.some((p) => p.summary.includes(input.eventType!));
      }
      return true;
    });

    const consumers = relationships.map((rel) => rel.from);
    const invented = assertNoInventedRepositories(
      consumers,
      context.repositories.map((r) => r.repository),
    );
    if (!invented.ok) {
      throw multiRepoException(invented.code, invented.message);
    }

    return {
      consumers,
      relationships,
      scope: context.scope,
    };
  }

  async assertRepositoryAccess(userId: string, owner: string, repository: string): Promise<string> {
    // H1: the acting user's own read access is verified before an App token is used.
    const resolved = await this.githubAccess.resolveRepositoryAccess(userId, {
      owner,
      repository,
      access: 'read',
    });
    if (!resolved.ok) throw systemsAccessError(resolved.reason);
    const token = resolved.token;

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
      throw multiRepoException(
        'SYSTEM_CONTEXT_STALE',
        'Unable to reach GitHub to verify repository access.',
      );
    }

    if (response.status === 404 || response.status === 403) {
      throw multiRepoException(
        'SYSTEM_REPOSITORY_NOT_ACCESSIBLE',
        'GitHub denied access to this repository for the connected account.',
      );
    }

    if (response.status === 401) {
      throw multiRepoException(
        'SYSTEM_REPOSITORY_NOT_ACCESSIBLE',
        'GitHub rejected your stored token. Update it in dashboard Settings.',
      );
    }

    if (!response.ok) {
      throw multiRepoException(
        'SYSTEM_CONTEXT_STALE',
        'GitHub repository access check failed temporarily.',
      );
    }

    return token;
  }

  async tryAuthorize(userId: string, owner: string, repository: string): Promise<boolean> {
    try {
      await this.assertRepositoryAccess(userId, owner, repository);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A system of the caller's workspace, after the permission check. A system id is never an
   * authorization credential: another workspace's id is "not found" (no existence oracle).
   */
  private async requireSystem(
    userId: string,
    systemId: string,
    permission: WorkspacePermission = 'systems:read',
  ): Promise<SystemWithRepos> {
    const workspaceId = await this.authorize(userId, permission);
    const row = await this.prisma.projectSystem.findFirst({
      where: { id: systemId, workspaceId },
      include: { repositories: { orderBy: { createdAt: 'asc' } } },
    });
    if (!row) {
      throw multiRepoException(
        'SYSTEM_CONTEXT_NOT_CONFIGURED',
        'System not found for this workspace.',
      );
    }
    return row;
  }

  /**
   * One fresh, bounded scan of the system's enabled repositories (see repository-scanner.ts),
   * deterministic matching (shared http-match), then persistence of this user's findings.
   * Never adds repositories; suggestions are access-checked and capped.
   */
  private async runDiscovery(userId: string, systemId: string): Promise<DiscoveryResult> {
    const system = await this.requireSystem(userId, systemId);
    const enabled = system.repositories.filter((r) => r.enabled);
    // H1: every repository is checked for THIS user before it is scanned; with the workspace
    // App installed a repository the user cannot read is reported unavailable, never scanned.
    const verdicts = await Promise.all(
      enabled.map((r) =>
        this.githubAccess.resolveRepositoryAccess(userId, {
          owner: r.owner,
          repository: r.repository,
          access: 'read',
        }),
      ),
    );
    const readable = new Set<string>();
    let token: string | null = null;
    verdicts.forEach((verdict, i) => {
      if (!verdict.ok) return;
      readable.add(repositoryKey(toRepositoryIdentity(enabled[i]!.owner, enabled[i]!.repository)));
      token ??= verdict.token;
    });
    if (!token) {
      const firstDenial = verdicts.find((v) => !v.ok);
      throw systemsAccessError(
        firstDenial && !firstDenial.ok ? firstDenial.reason : 'not_connected',
      );
    }
    const budget = new ScanBudget(MULTI_REPO_MAX_GITHUB_REQUESTS);
    const scanner = this.scannerFactory(token, budget);

    type Scanned = {
      identity: RepositoryIdentity;
      key: string;
      files: ScannedFile[];
      report: MultiRepoRepositoryScan;
    };
    const scanned: Scanned[] = [];
    const unavailable: RepositoryIdentity[] = [];
    let filesUsed = 0;
    let truncated = false;
    const TRUNCATION: MultiRepoScanIssueCode[] = [
      'tree_truncated',
      'file_budget_reached',
      'byte_budget_reached',
      'request_budget_reached',
    ];

    for (const repo of enabled) {
      const identity = toRepositoryIdentity(repo.owner, repo.repository);
      const remaining = remainingTotalFileBudget(filesUsed);
      const result = !readable.has(repositoryKey(identity))
        ? {
            status: 'unavailable' as const,
            files: [],
            issues: new Map<MultiRepoScanIssueCode, number>([['repository_inaccessible', 1]]),
          }
        : remaining > 0
          ? await scanner.scan(
              identity.owner,
              identity.repository,
              Math.min(MULTI_REPO_MAX_FILES_PER_REPO, remaining),
            )
          : {
              status: 'partial' as const,
              files: [],
              issues: new Map<MultiRepoScanIssueCode, number>([['file_budget_reached', 1]]),
            };
      filesUsed += result.files.length;
      if (result.status === 'unavailable') unavailable.push(identity);
      if (TRUNCATION.some((code) => result.issues.has(code))) truncated = true;
      scanned.push({
        identity,
        key: repositoryKey(identity),
        files: result.files,
        report: {
          repository: identity,
          status: result.status,
          ...('branch' in result && result.branch ? { branch: result.branch } : {}),
          filesScanned: result.files.length,
          issues: [...result.issues].map(([code, count]) => ({ code, count })),
          unresolvedHttpCalls: 0,
        },
      });
    }

    const available = scanned.filter((s) => s.report.status !== 'unavailable');
    const byKey = new Map(available.map((s) => [s.key, s]));
    const systemKeys = new Set(
      system.repositories.map((r) => repositoryKey(toRepositoryIdentity(r.owner, r.repository))),
    );
    const now = new Date().toISOString();
    const hints: RelatedRepositoryCandidate[] = [];
    const facts: RepoHttpFacts[] = [];
    const proposed: ProposedRelationship[] = [];
    const packageNames = new Map<string, string>();
    const packageDeps: Array<{ key: string; name: string; filePath: string }> = [];
    const kafka: Array<{
      key: string;
      role: 'producer' | 'consumer';
      topic: string;
      filePath: string;
      summary: string;
      confidence: RelationshipConfidence;
    }> = [];
    const addIssue = (s: Scanned, code: MultiRepoScanIssueCode) => {
      const existing = s.report.issues.find((i) => i.code === code);
      if (existing) existing.count += 1;
      else s.report.issues.push({ code, count: 1 });
      if (s.report.status === 'complete') s.report.status = 'partial';
    };

    for (const repo of available) {
      const operations: ProviderOperation[] = [];
      const calls: CallSite[] = [];
      const declared: DeclaredDependency[] = [];
      for (const file of repo.files) {
        if (looksLikeOpenApiPath(file.path)) {
          for (const op of extractOpenApiOperations(file.content).operations) {
            operations.push({
              ...op,
              filePath: file.path,
              source: 'openapi',
              confidence: 'high',
              summary: `OpenAPI ${op.method ?? 'ANY'} ${op.path}`,
            });
          }
        }
        if (SOURCE_FILE.test(file.path)) {
          for (const call of detectHttpCalls(file.content, file.path)) {
            calls.push({ ...call, filePath: file.path });
          }
        }
        if (file.path === 'package.json') {
          const manifest = parsePackageJsonManifest(file.content);
          if (manifest?.name) packageNames.set(repo.key, manifest.name);
          for (const dep of manifest?.dependencies ?? []) {
            packageDeps.push({ key: repo.key, name: dep.name, filePath: file.path });
          }
          const ref = manifest?.repository;
          if (ref?.owner && ref.repository) {
            const other = toRepositoryIdentity(ref.owner, ref.repository);
            if (!sameRepository(other, repo.identity)) {
              hints.push(
                this.hint(
                  other,
                  'documentation_reference',
                  'medium',
                  file.path,
                  'package.json repository field',
                  now,
                ),
              );
            }
          }
        }
        if (/^readme\.md$/i.test(file.path)) {
          const linkRe =
            /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/gi;
          for (const match of file.content.matchAll(linkRe)) {
            const other = toRepositoryIdentity(match[1]!, match[2]!.replace(/\.git$/i, ''));
            if (sameRepository(other, repo.identity)) continue;
            hints.push(
              this.hint(other, 'documentation_reference', 'low', file.path, 'README link', now),
            );
          }
        }
        for (const hit of detectKafkaTopicUsages(file.content, file.path)) {
          kafka.push({
            key: repo.key,
            role: hit.role,
            topic: hit.topic,
            filePath: file.path,
            summary: hit.summary,
            confidence: hit.confidence,
          });
        }
      }
      for (const route of detectRouteDefinitions(
        repo.files.filter((f) => SOURCE_FILE.test(f.path)),
      )) {
        operations.push({
          ...(route.method ? { method: route.method } : {}),
          path: route.path,
          filePath: route.filePath,
          line: route.line,
          source: 'route',
          confidence: route.confidence,
          summary: route.summary,
        });
      }

      // service-dependencies.json: repository-authored claims, resolved inside the system only.
      const manifestFile = repo.files.find((f) => f.path === SERVICE_MANIFEST_PATH);
      if (manifestFile) {
        const parsed = parseServiceDependencyManifest(manifestFile.content);
        if (!parsed.ok) addIssue(repo, 'manifest_invalid');
        else {
          for (const dep of parsed.dependencies) {
            if (dep.type !== 'http' && dep.type !== 'unknown') continue;
            const target = dep.repository
              ? toRepositoryIdentity(dep.repository.owner, dep.repository.repository)
              : this.systemRepositoryByName(system, dep.service);
            if (!target) continue;
            const targetKey = repositoryKey(target);
            if (targetKey === repo.key) continue;
            if (!systemKeys.has(targetKey)) {
              // Outside the system: at most a suggestion (access-checked below), never a link.
              hints.push(
                this.hint(
                  target,
                  'api_provider',
                  'medium',
                  manifestFile.path,
                  SERVICE_MANIFEST_PATH,
                  now,
                ),
              );
              continue;
            }
            // Disabled or inaccessible repositories never get relationships.
            if (!byKey.has(targetKey)) continue;
            declared.push({
              targetKey,
              filePath: manifestFile.path,
              ...(dep.baseUrlEnv ? { baseUrlEnv: dep.baseUrlEnv } : {}),
              endpoints: dep.endpoints,
            });
          }
        }
      }
      facts.push({ key: repo.key, operations, calls, declared });
    }

    // HTTP: consumer → provider.
    const match = matchHttpDependencies(facts);
    for (const [key, count] of match.unresolved) {
      const s = byKey.get(key);
      if (s) s.report.unresolvedHttpCalls = count;
    }
    for (const link of match.links) {
      const from = byKey.get(link.consumerKey)!.identity;
      const to = byKey.get(link.providerKey)!.identity;
      const declaredEvidence: ProposedProvenance[] = link.declared
        ? [
            {
              type: 'service_manifest',
              owner: from.owner,
              repository: from.repository,
              filePath: link.declared.filePath,
              summary: `Declared in ${SERVICE_MANIFEST_PATH}${link.declared.baseUrlEnv ? ` (${link.declared.baseUrlEnv})` : ''}${
                link.corroborated ? '' : ' — not confirmed by provider routes or OpenAPI'
              }`,
            },
          ]
        : [];
      if (link.endpoints.length === 0) {
        proposed.push({
          from,
          to,
          type: 'HTTP_CALLS',
          resourceKind: 'service',
          resourceKey: `${to.owner}/${to.repository}`,
          confidence: link.confidence,
          provenance: declaredEvidence,
        });
        continue;
      }
      for (const endpoint of link.endpoints) {
        const resourceKey = endpoint.method ? `${endpoint.method} ${endpoint.path}` : endpoint.path;
        const callEvidence: ProposedProvenance[] = endpoint.calls.slice(0, 3).map((call) => ({
          type: 'http_call',
          owner: from.owner,
          repository: from.repository,
          filePath: call.filePath,
          summary: `${call.method ?? 'HTTP'} ${call.path}${call.baseRef ? ` via ${call.baseRef}` : ''} (line ${call.line})`,
        }));
        const op = endpoint.operation;
        // Every provider record of this endpoint (OpenAPI contract and/or server route).
        const providerEvidence: ProposedProvenance[] = endpoint.operations.map((o) => ({
          type: o.source === 'openapi' ? 'openapi_reference' : 'http_call',
          owner: to.owner,
          repository: to.repository,
          filePath: o.filePath,
          summary: `${o.source === 'openapi' ? 'OpenAPI' : 'Route'} ${o.method ?? 'ANY'} ${o.path}${o.line ? ` (line ${o.line})` : ''}`,
        }));
        proposed.push({
          from,
          to,
          type: 'HTTP_CALLS',
          resourceKind: 'http_operation',
          resourceKey,
          confidence: link.confidence,
          provenance: [...callEvidence, ...providerEvidence, ...declaredEvidence],
        });
        if (op) {
          proposed.push({
            from: to,
            to,
            type: 'PROVIDES_API',
            resourceKind: 'http_operation',
            resourceKey,
            confidence: op.confidence,
            provenance: providerEvidence,
          });
        }
      }
    }

    // Kafka: consumer → producer on the same topic (unchanged semantics, wider file scope).
    for (const producer of kafka.filter((k) => k.role === 'producer')) {
      for (const consumer of kafka.filter(
        (k) => k.role === 'consumer' && k.topic === producer.topic && k.key !== producer.key,
      )) {
        const from = byKey.get(consumer.key)!.identity;
        const to = byKey.get(producer.key)!.identity;
        proposed.push({
          from,
          to,
          type: 'CONSUMES_EVENT',
          resourceKind: 'kafka_topic',
          resourceKey: producer.topic,
          confidence: consumer.confidence,
          provenance: [
            {
              type: 'kafka_consumer',
              owner: from.owner,
              repository: from.repository,
              filePath: consumer.filePath,
              summary: consumer.summary,
            },
            {
              type: 'kafka_producer',
              owner: to.owner,
              repository: to.repository,
              filePath: producer.filePath,
              summary: producer.summary,
            },
          ],
        });
      }
    }

    // npm packages: dependent → repository publishing that package name.
    for (const dep of packageDeps) {
      const providerKey = [...packageNames].find(
        ([key, name]) => key !== dep.key && name.toLowerCase() === dep.name.toLowerCase(),
      )?.[0];
      if (!providerKey) continue;
      const from = byKey.get(dep.key)!.identity;
      const to = byKey.get(providerKey)!.identity;
      proposed.push({
        from,
        to,
        type: 'DEPENDS_ON_PACKAGE',
        resourceKind: 'package',
        resourceKey: dep.name,
        confidence: 'high',
        provenance: [
          {
            type: 'package_reference',
            owner: from.owner,
            repository: from.repository,
            filePath: dep.filePath,
            summary: `Depends on package ${dep.name}`,
          },
        ],
      });
    }

    // Suggestions: de-duplicated BEFORE any access check, outside the system only, capped.
    const candidates: RelatedRepositoryCandidate[] = [];
    const outside = this.dedupeCandidates(hints).filter(
      (h) => !systemKeys.has(repositoryKey(h.repository)),
    );
    for (const hint of outside.slice(0, MULTI_REPO_MAX_CANDIDATE_LOOKUPS)) {
      if (!budget.take()) break;
      if (await this.tryAuthorize(userId, hint.repository.owner, hint.repository.repository)) {
        candidates.push({ ...hint, recommendation: 'suggest_add' });
      }
    }

    // Persist (this user's rows only), then retire findings a complete re-scan no longer sees.
    const unique = new Map<string, ProposedRelationship>();
    for (const rel of proposed) {
      const key = relationshipRowKey(rel);
      const existing = unique.get(key);
      if (!existing || CONFIDENCE_RANK[rel.confidence] > CONFIDENCE_RANK[existing.confidence]) {
        unique.set(key, rel);
      }
    }
    const { items: limited, truncated: relTruncated } = truncateToBudget(
      [...unique.values()],
      MULTI_REPO_MAX_RELATIONSHIPS,
    );
    truncated = truncated || relTruncated;
    // The system's own workspace (authorized above): rows never cross workspaces.
    const workspaceId = system.workspaceId;
    const kept = new Set<string>();
    for (const rel of limited) {
      await this.upsertRelationship(userId, workspaceId, systemId, rel);
      kept.add(relationshipRowKey(rel));
    }
    if (!relTruncated) {
      const complete = new Set(
        available.filter((s) => s.report.status === 'complete').map((s) => s.key),
      );
      await this.supersedeStaleRelationships(userId, systemId, complete, kept);
    }

    const relationships = (
      await this.prisma.repositoryRelationship.findMany({
        where: { userId, systemId },
        orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        take: MULTI_REPO_MAX_RELATIONSHIPS,
      })
    ).map(toRepositoryRelationship);

    const reports = scanned.map((s) => s.report);
    return {
      analyzed: available.length,
      relationships,
      candidates,
      unavailable,
      truncated,
      scan: {
        partial: reports.some((r) => r.status !== 'complete'),
        repositories: reports,
        githubRequests: budget.requests,
      },
    };
  }

  private hint(
    repository: RepositoryIdentity,
    relationship: RelatedRepositoryCandidate['relationship'],
    confidence: RelationshipConfidence,
    filePath: string,
    source: string,
    observedAt: string,
  ): RelatedRepositoryCandidate {
    return {
      repository,
      relationship,
      confidence,
      evidence: [
        {
          filePath,
          summary: `${source} points to ${repository.owner}/${repository.repository}`,
          observedAt,
        },
      ],
      recommendation: 'suggest_add',
    };
  }

  /** A manifest `service` name → the one system repository with that name (else none). */
  private systemRepositoryByName(
    system: SystemWithRepos,
    service: string | undefined,
  ): RepositoryIdentity | null {
    if (!service) return null;
    const matches = system.repositories.filter(
      (r) => r.repository.toLowerCase() === service.toLowerCase(),
    );
    return matches.length === 1
      ? toRepositoryIdentity(matches[0]!.owner, matches[0]!.repository)
      : null;
  }

  /**
   * Mark this user's scanner findings that a COMPLETE scan of both repositories no longer
   * produced as superseded (kept as history, excluded from analysis context). Never touches
   * other users' rows, user-confirmed rows, or rows involving partially read, unavailable or
   * disabled repositories.
   */
  private async supersedeStaleRelationships(
    userId: string,
    systemId: string,
    completeKeys: Set<string>,
    kept: Set<string>,
  ): Promise<void> {
    if (completeKeys.size === 0) return;
    const rows = await this.prisma.repositoryRelationship.findMany({
      where: { userId, systemId, status: 'active' },
      take: 1000,
    });
    const stale = rows.filter((row) => {
      const provenance = (row.provenanceJson as unknown as RelationshipProvenance[]) ?? [];
      if (provenance.some((p) => p.type === 'user_explicit')) return false;
      const fromKey = repositoryKey({ owner: row.fromOwner, repository: row.fromRepository });
      const toKey = repositoryKey({ owner: row.toOwner, repository: row.toRepository });
      if (!completeKeys.has(fromKey) || !completeKeys.has(toKey)) return false;
      return !kept.has(
        relationshipRowKey({
          from: { owner: row.fromOwner, repository: row.fromRepository },
          to: { owner: row.toOwner, repository: row.toRepository },
          type: row.type,
          resourceKind: row.resourceKind ?? undefined,
          resourceKey: row.resourceKey ?? undefined,
        }),
      );
    });
    if (stale.length === 0) return;
    await this.prisma.repositoryRelationship.updateMany({
      where: { id: { in: stale.map((r) => r.id) }, userId, systemId },
      data: { status: 'superseded' },
    });
  }

  /**
   * Insert or refresh one of THIS user's relationship rows (rows are per user: another
   * member's scan never modifies them). Re-found rows reflect the latest scan's evidence.
   */
  private async upsertRelationship(
    userId: string,
    workspaceId: string,
    systemId: string,
    rel: ProposedRelationship,
  ): Promise<void> {
    const existing = await this.prisma.repositoryRelationship.findFirst({
      where: {
        userId,
        systemId,
        fromOwner: rel.from.owner,
        fromRepository: rel.from.repository,
        toOwner: rel.to.owner,
        toRepository: rel.to.repository,
        type: rel.type,
        resourceKind: rel.resourceKind ?? null,
        resourceKey: rel.resourceKey ?? null,
      },
    });
    const now = new Date();
    const provenance: RelationshipProvenance[] = rel.provenance.map((p) => ({
      ...p,
      observedAt: now.toISOString(),
    }));
    const freshness = { lastValidatedAt: now.toISOString() };

    if (!existing) {
      await this.prisma.repositoryRelationship.create({
        data: {
          userId,
          workspaceId,
          systemId,
          fromOwner: rel.from.owner,
          fromRepository: rel.from.repository,
          toOwner: rel.to.owner,
          toRepository: rel.to.repository,
          type: rel.type,
          resourceKind: rel.resourceKind ?? null,
          resourceKey: rel.resourceKey ?? null,
          confidence: rel.confidence,
          status: 'active',
          provenanceJson: provenance as unknown as Prisma.InputJsonValue,
          freshnessJson: freshness as unknown as Prisma.InputJsonValue,
          lastValidatedAt: now,
        },
      });
      return;
    }

    const existingProvenance =
      (existing.provenanceJson as unknown as RelationshipProvenance[]) ?? [];
    if (existingProvenance.some((p) => p.type === 'user_explicit')) {
      // A user-confirmed relationship keeps its provenance; the scan only re-validates it.
      await this.prisma.repositoryRelationship.update({
        where: { id: existing.id },
        data: {
          lastValidatedAt: now,
          freshnessJson: freshness as unknown as Prisma.InputJsonValue,
        },
      });
      return;
    }

    await this.prisma.repositoryRelationship.update({
      where: { id: existing.id },
      data: {
        confidence: rel.confidence,
        status: 'active',
        provenanceJson: provenance as unknown as Prisma.InputJsonValue,
        freshnessJson: freshness as unknown as Prisma.InputJsonValue,
        lastValidatedAt: now,
      },
    });
  }

  private async fetchHighSignalFiles(
    userId: string,
    owner: string,
    repository: string,
    alreadyUsed: number,
  ): Promise<FetchedFile[]> {
    const remaining = remainingTotalFileBudget(alreadyUsed);
    if (remaining <= 0) return [];

    const budget = Math.min(MULTI_REPO_MAX_FILES_PER_REPO, remaining);
    const paths = [...KNOWN_SIGNAL_PATHS];
    const files: FetchedFile[] = [];

    for (const path of paths) {
      if (files.length >= budget) break;
      try {
        const content = await this.githubContent.fetchRepositoryFileAtRef(
          userId,
          owner,
          repository,
          path,
        );
        if (content != null) {
          files.push({ path, content });
        }
      } catch {
        // Soft miss — continue.
      }
    }

    return files;
  }

  private dedupeCandidates(candidates: RelatedRepositoryCandidate[]): RelatedRepositoryCandidate[] {
    const map = new Map<string, RelatedRepositoryCandidate>();
    for (const c of candidates) {
      const key = repositoryKey(c.repository);
      const existing = map.get(key);
      if (!existing || CONFIDENCE_RANK[c.confidence] > CONFIDENCE_RANK[existing.confidence]) {
        map.set(key, c);
      }
    }
    return [...map.values()];
  }

  private aggregateHttpResources(relationships: RepositoryRelationship[]): MultiRepoHttpResource[] {
    const map = new Map<string, MultiRepoHttpResource>();
    for (const rel of relationships) {
      if (!rel.resource || rel.resource.kind !== 'http_operation') continue;
      const key = rel.resource.key;
      const parts = key.split(' ');
      const method = parts.length > 1 ? parts[0]! : 'GET';
      const path = parts.length > 1 ? parts.slice(1).join(' ') : key;
      let entry = map.get(key);
      if (!entry) {
        entry = {
          method,
          path,
          providerRepository: rel.type === 'PROVIDES_API' ? rel.from : rel.to,
          consumerRepositories: [],
        };
        map.set(key, entry);
      }
      if (rel.type === 'CONSUMES_API' || rel.type === 'HTTP_CALLS') {
        entry.consumerRepositories = entry.consumerRepositories ?? [];
        if (!entry.consumerRepositories.some((c) => sameRepository(c, rel.from))) {
          entry.consumerRepositories.push(rel.from);
        }
      }
      if (rel.type === 'PROVIDES_API') {
        entry.providerRepository = rel.from;
      }
    }
    return [...map.values()];
  }

  private aggregateKafkaResources(
    relationships: RepositoryRelationship[],
  ): MultiRepoKafkaResource[] {
    const map = new Map<string, MultiRepoKafkaResource>();
    for (const rel of relationships) {
      if (!rel.resource || rel.resource.kind !== 'kafka_topic') continue;
      const topic = rel.resource.key;
      let entry = map.get(topic);
      if (!entry) {
        entry = { topic, producerRepositories: [], consumerRepositories: [] };
        map.set(topic, entry);
      }
      if (rel.type === 'PRODUCES_EVENT') {
        entry.producerRepositories = entry.producerRepositories ?? [];
        if (!entry.producerRepositories.some((p) => sameRepository(p, rel.from))) {
          entry.producerRepositories.push(rel.from);
        }
      }
      if (rel.type === 'CONSUMES_EVENT') {
        entry.consumerRepositories = entry.consumerRepositories ?? [];
        if (!entry.consumerRepositories.some((c) => sameRepository(c, rel.from))) {
          entry.consumerRepositories.push(rel.from);
        }
      }
    }
    return [...map.values()];
  }

  private aggregateContractResources(
    relationships: RepositoryRelationship[],
  ): MultiRepoContractResource[] {
    const map = new Map<string, MultiRepoContractResource>();
    for (const rel of relationships) {
      if (!rel.resource || rel.resource.kind !== 'package') continue;
      const key = rel.resource.key;
      let entry = map.get(key);
      if (!entry) {
        entry = {
          packageName: key,
          ownerRepository: rel.type === 'PROVIDES_PACKAGE' ? rel.from : rel.to,
          dependentRepositories: [],
        };
        map.set(key, entry);
      }
      if (rel.type === 'DEPENDS_ON_PACKAGE') {
        entry.dependentRepositories = entry.dependentRepositories ?? [];
        if (!entry.dependentRepositories.some((d) => sameRepository(d, rel.from))) {
          entry.dependentRepositories.push(rel.from);
        }
      }
      if (rel.type === 'PROVIDES_PACKAGE') {
        entry.ownerRepository = rel.from;
      }
    }
    return [...map.values()];
  }

  private impactTypeForRelationship(type: RepositoryRelationshipType): MultiRepoImpactType {
    switch (type) {
      case 'CONSUMES_API':
      case 'HTTP_CALLS':
        return 'api_consumer';
      case 'PROVIDES_API':
        return 'api_provider';
      case 'CONSUMES_EVENT':
        return 'event_consumer';
      case 'PRODUCES_EVENT':
        return 'event_producer';
      case 'DEPENDS_ON_PACKAGE':
      case 'PROVIDES_PACKAGE':
        return 'library_dependency';
      case 'SHARES_CONTRACT':
        return 'shared_contract';
      case 'DEPLOYMENT_DEPENDENCY':
        return 'deployment_dependency';
      default:
        return 'unknown';
    }
  }

  private relationshipMatchesIdentifiers(
    rel: RepositoryRelationship,
    identifiers: {
      paths: string[];
      httpKeys: string[];
      topics: string[];
      packages: string[];
    },
  ): boolean {
    const key = rel.resource?.key ?? '';
    if (rel.resource?.kind === 'http_operation' || rel.resource?.kind === 'service') {
      // Canonical operation match only; a changed file name is never evidence for HTTP.
      return (
        rel.resource.kind === 'http_operation' && httpOperationTouched(key, identifiers.httpKeys)
      );
    }
    if (rel.resource?.kind === 'kafka_topic') {
      return identifiers.topics.includes(key);
    }
    if (rel.resource?.kind === 'package') {
      return identifiers.packages.includes(key);
    }
    return identifiers.paths.some((p) =>
      rel.provenance.some((pr) => pr.filePath?.includes(p) || pr.summary.includes(p)),
    );
  }

  private async extractChangeIdentifiers(
    userId: string,
    input: AnalyzeChangeImpactRequest,
    primary: { owner: string; repository: string },
  ): Promise<{
    paths: string[];
    httpKeys: string[];
    topics: string[];
    packages: string[];
    topicRenames: Array<{ before: string; after: string }>;
    httpRequiredFieldAdds: Array<{ path: string; before: string[]; after: string[] }>;
  }> {
    const paths: string[] = [];
    const httpKeys: string[] = [];
    const topics: string[] = [];
    const packages: string[] = [];
    const topicRenames: Array<{ before: string; after: string }> = [];
    const httpRequiredFieldAdds: Array<{ path: string; before: string[]; after: string[] }> = [];

    if (input.pullRequestNumber) {
      try {
        const resolved = await this.githubAccess.resolveRepositoryAccess(userId, {
          owner: primary.owner,
          repository: primary.repository,
          access: 'read',
        });
        const token = resolved.ok ? resolved.token : null;
        if (token) {
          const url = `https://api.github.com/repos/${encodeURIComponent(primary.owner)}/${encodeURIComponent(primary.repository)}/pulls/${input.pullRequestNumber}/files?per_page=50`;
          const response = await fetch(url, {
            headers: {
              Accept: 'application/vnd.github+json',
              Authorization: `Bearer ${token}`,
              'User-Agent': 'Project-X',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          });
          if (response.ok) {
            const files = (await response.json()) as Array<{ filename?: string; patch?: string }>;
            for (const file of files.slice(0, 40)) {
              if (file.filename) paths.push(file.filename);
              if (file.patch) {
                for (const hit of detectKafkaTopicUsages(file.patch, file.filename ?? 'patch')) {
                  topics.push(hit.topic);
                }
                for (const hit of detectHttpProviderPaths(file.patch, file.filename ?? 'patch')) {
                  httpKeys.push(hit.method ? `${hit.method} ${hit.path}` : hit.path);
                }
                for (const hit of detectHttpConsumerPaths(file.patch, file.filename ?? 'patch')) {
                  httpKeys.push(hit.method ? `${hit.method} ${hit.path}` : hit.path);
                }
              }
            }
          }
        }
      } catch {
        // Fall through to summary-based identifiers.
      }
    }

    const summary = input.summary ?? '';
    const topicRenameMatch = summary.match(
      /topic\s+([A-Za-z0-9._-]+)\s+(?:renamed\s+to|→|->)\s+([A-Za-z0-9._-]+)/i,
    );
    if (topicRenameMatch) {
      topicRenames.push({ before: topicRenameMatch[1]!, after: topicRenameMatch[2]! });
      topics.push(topicRenameMatch[1]!, topicRenameMatch[2]!);
    }

    const requiredFieldMatch = summary.match(
      /required\s+fields?\s+added\s+(?:on|for)?\s*([A-Z]+)?\s*(\/\S+)?\s*:?\s*([A-Za-z0-9_,\s]+)/i,
    );
    if (requiredFieldMatch) {
      const path = requiredFieldMatch[2] ?? '/';
      const fields = (requiredFieldMatch[3] ?? '')
        .split(/[,\s]+/)
        .map((f) => f.trim())
        .filter(Boolean);
      httpRequiredFieldAdds.push({ path, before: [], after: fields });
      if (requiredFieldMatch[1] && requiredFieldMatch[2]) {
        httpKeys.push(`${requiredFieldMatch[1]} ${requiredFieldMatch[2]}`);
      }
    }

    for (const token of summary.split(/[\s,;]+/)) {
      if (token.startsWith('/') && token.length > 1) httpKeys.push(token);
      if (token.includes('.') && /^[A-Za-z0-9._-]+$/.test(token) && token.length > 3) {
        topics.push(token);
      }
    }

    return {
      paths: [...new Set(paths)],
      httpKeys: [...new Set(httpKeys)],
      topics: [...new Set(topics)],
      packages: [...new Set(packages)],
      topicRenames,
      httpRequiredFieldAdds,
    };
  }
}

/** H1: Systems errors for a refused repository credential (no repository-existence leak). */
function systemsAccessError(reason: RepositoryAccessDenial) {
  if (reason === 'not_connected' || reason === 'identity_required') {
    return multiRepoException(
      'SYSTEM_REPOSITORY_NOT_ACCESSIBLE',
      reason === 'identity_required'
        ? 'This workspace uses the Project X GitHub App. Connect your own GitHub token in dashboard Settings so Project X can confirm your repository access.'
        : 'Connect a GitHub token in dashboard Settings before using multi-repo systems.',
    );
  }
  if (reason === 'unavailable') {
    return multiRepoException(
      'SYSTEM_CONTEXT_STALE',
      'Unable to reach GitHub to verify repository access.',
    );
  }
  return multiRepoException(
    'SYSTEM_REPOSITORY_NOT_ACCESSIBLE',
    'GitHub denied access to this repository for the connected account.',
  );
}
