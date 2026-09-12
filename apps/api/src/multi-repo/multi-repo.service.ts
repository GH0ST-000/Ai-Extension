import { Injectable, Logger } from '@nestjs/common';
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
  detectKafkaTopicUsages,
  knownInSelectedScope,
  MULTI_REPO_MAX_FILES_PER_REPO,
  MULTI_REPO_MAX_HTTP_OPS,
  MULTI_REPO_MAX_KAFKA_TOPICS,
  MULTI_REPO_MAX_RELATIONSHIPS,
  MULTI_REPO_MAX_REPOS_PER_ANALYSIS,
  MULTI_REPO_MAX_REPOS_PER_SYSTEM,
  MULTI_REPO_MAX_TOTAL_FILES,
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
} from '@project-x/shared';
import type {
  AddSystemRepositoryRequest,
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
  ProjectSystem,
  RelatedRepositoryCandidate,
  RelationshipConfidence,
  RelationshipProvenance,
  RelationshipProvenanceType,
  RelationshipResourceKind,
  RepositoryIdentity,
  RepositoryRelationship,
  RepositoryRelationshipType,
  SystemFlowNode,
  SystemFlowTrace,
  TraceSystemFlowRequest,
  UpdateProjectSystemRequest,
} from '@project-x/types';

import { GithubContentService } from '../github/github-content.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectMemoryService } from '../project-memory/project-memory.service';
import { GithubConnectionService } from '../settings/github-connection.service';
import { multiRepoException } from './multi-repo.errors';
import { toProjectSystem, toRepositoryRelationship } from './multi-repo.mapper';

type SystemWithRepos = ProjectSystemRow & {
  repositories: ProjectSystemRepositoryRow[];
};

type FetchedFile = {
  path: string;
  content: string;
};

type RepoScan = {
  identity: RepositoryIdentity;
  available: boolean;
  files: FetchedFile[];
  packageName?: string;
  httpProviders: Array<{
    method?: string;
    path: string;
    filePath: string;
    summary: string;
    confidence: RelationshipConfidence;
  }>;
  httpConsumers: Array<{
    method?: string;
    path: string;
    filePath: string;
    summary: string;
    confidence: RelationshipConfidence;
  }>;
  kafkaProducers: Array<{
    topic: string;
    filePath: string;
    summary: string;
    confidence: RelationshipConfidence;
  }>;
  kafkaConsumers: Array<{
    topic: string;
    filePath: string;
    summary: string;
    confidence: RelationshipConfidence;
  }>;
  packageDeps: Array<{ name: string; filePath: string }>;
  candidateHints: RelatedRepositoryCandidate[];
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly githubConnections: GithubConnectionService,
    private readonly githubContent: GithubContentService,
    private readonly projectMemory: ProjectMemoryService,
  ) {}

  async listSystems(userId: string): Promise<ProjectSystem[]> {
    const rows = await this.prisma.projectSystem.findMany({
      where: { userId },
      include: { repositories: { orderBy: { createdAt: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(toProjectSystem);
  }

  async createSystem(userId: string, input: CreateProjectSystemRequest): Promise<ProjectSystem> {
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

    if (byKey.size > MULTI_REPO_MAX_REPOS_PER_SYSTEM) {
      throw multiRepoException(
        'SYSTEM_REPOSITORY_LIMIT_REACHED',
        `A system may include at most ${MULTI_REPO_MAX_REPOS_PER_SYSTEM} repositories.`,
      );
    }

    for (const repo of byKey.values()) {
      if (repo.owner === primary.owner && repo.repository === primary.repository) continue;
      await this.assertRepositoryAccess(userId, repo.owner, repo.repository);
    }

    const created = await this.prisma.projectSystem.create({
      data: {
        userId,
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
    const existing = await this.requireSystem(userId, systemId);
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
    await this.requireSystem(userId, systemId);
    await this.prisma.projectSystem.delete({ where: { id: systemId } });
    return { deleted: true, id: systemId };
  }

  async addRepository(
    userId: string,
    systemId: string,
    input: AddSystemRepositoryRequest,
  ): Promise<ProjectSystem> {
    const system = await this.requireSystem(userId, systemId);
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
    const system = await this.requireSystem(userId, systemId);
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
    const system = await this.requireSystem(userId, systemId);
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
    await this.requireSystem(userId, systemId);
    const rows = await this.prisma.repositoryRelationship.findMany({
      where: { userId, systemId },
      orderBy: [{ updatedAt: 'desc' }],
      take: MULTI_REPO_MAX_RELATIONSHIPS,
    });
    return rows.map(toRepositoryRelationship);
  }

  async refreshSystemContext(
    userId: string,
    systemId: string,
  ): Promise<{
    analyzed: number;
    relationshipsChecked: number;
    candidates: RelatedRepositoryCandidate[];
    unavailable: RepositoryIdentity[];
    truncated: boolean;
  }> {
    const started = Date.now();
    const discovery = await this.runDiscovery(userId, systemId);
    this.logger.log({
      msg: 'multi_repo_refresh',
      systemId,
      analyzed: discovery.analyzed,
      relationshipsChecked: discovery.relationships.length,
      candidates: discovery.candidates.length,
      unavailable: discovery.unavailable.length,
      truncated: discovery.truncated,
      durationMs: Date.now() - started,
    });
    return {
      analyzed: discovery.analyzed,
      relationshipsChecked: discovery.relationships.length,
      candidates: discovery.candidates,
      unavailable: discovery.unavailable,
      truncated: discovery.truncated,
    };
  }

  async discoverRelationships(
    userId: string,
    systemId: string,
  ): Promise<DiscoverRelationshipsResponse> {
    const discovery = await this.runDiscovery(userId, systemId);
    return {
      systemId,
      relationships: discovery.relationships,
      candidates: discovery.candidates,
      truncated: discovery.truncated,
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
    const relationships = context.relationships.filter(
      (rel) => sameRepository(rel.from, primaryIdentity) || sameRepository(rel.to, primaryIdentity),
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

    for (const rel of relationships) {
      const other = sameRepository(rel.from, primaryIdentity) ? rel.to : rel.from;
      if (sameRepository(other, primaryIdentity)) continue;
      if (
        !analyzed.some((r) => sameRepository(r, other)) &&
        !unavailable.some((r) => sameRepository(r, other))
      ) {
        continue;
      }
      if (unavailable.some((r) => sameRepository(r, other))) continue;

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
    analysis.unaffectedOrNotEvident = enabledIdentities
      .filter(
        (repo) =>
          !sameRepository(repo, primaryIdentity) &&
          !analysis.impactedRepositories.some((i) => sameRepository(i.repository, repo)),
      )
      .map((repository) => ({
        repository,
        reason: unavailable.some((u) => sameRepository(u, repository))
          ? partialScopeUnavailable(`${repository.owner}/${repository.repository}`)
          : notEvidentInScope('Impact'),
      }));

    analysis.requiredCoordination = analysis.impactedRepositories.map((item) => ({
      repository: item.repository,
      reason: item.summary,
      suggestedAction: 'Review consumers/providers in the selected system before merge.',
    }));

    return analysis;
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
    const token = await this.githubConnections.getDecryptedToken(userId);
    if (!token) {
      throw multiRepoException(
        'SYSTEM_REPOSITORY_NOT_ACCESSIBLE',
        'Connect a GitHub token in dashboard Settings before using multi-repo systems.',
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

  private async requireSystem(userId: string, systemId: string): Promise<SystemWithRepos> {
    const row = await this.prisma.projectSystem.findFirst({
      where: { id: systemId, userId },
      include: { repositories: { orderBy: { createdAt: 'asc' } } },
    });
    if (!row) {
      throw multiRepoException('SYSTEM_CONTEXT_NOT_CONFIGURED', 'System not found for this user.');
    }
    return row;
  }

  private async runDiscovery(
    userId: string,
    systemId: string,
  ): Promise<{
    analyzed: number;
    relationships: RepositoryRelationship[];
    candidates: RelatedRepositoryCandidate[];
    unavailable: RepositoryIdentity[];
    truncated: boolean;
  }> {
    const system = await this.requireSystem(userId, systemId);
    const enabled = system.repositories.filter((r) => r.enabled);
    const unavailable: RepositoryIdentity[] = [];
    const scans: RepoScan[] = [];
    let totalFiles = 0;
    let truncated = false;

    for (const repo of enabled) {
      const identity = toRepositoryIdentity(repo.owner, repo.repository);
      const ok = await this.tryAuthorize(userId, repo.owner, repo.repository);
      if (!ok) {
        unavailable.push(identity);
        scans.push({
          identity,
          available: false,
          files: [],
          httpProviders: [],
          httpConsumers: [],
          kafkaProducers: [],
          kafkaConsumers: [],
          packageDeps: [],
          candidateHints: [],
        });
        continue;
      }

      const files = await this.fetchHighSignalFiles(
        userId,
        repo.owner,
        repo.repository,
        totalFiles,
      );
      totalFiles += files.length;
      if (
        files.length >= MULTI_REPO_MAX_FILES_PER_REPO ||
        totalFiles >= MULTI_REPO_MAX_TOTAL_FILES
      ) {
        truncated = true;
      }

      const scan = this.scanRepoFiles(identity, files);
      scans.push(scan);
    }

    const inSystemKeys = new Set(system.repositories.map((r) => `${r.owner}/${r.repository}`));

    const candidates: RelatedRepositoryCandidate[] = [];
    for (const scan of scans) {
      for (const hint of scan.candidateHints) {
        const key = `${hint.repository.owner}/${hint.repository.repository}`;
        if (inSystemKeys.has(key)) continue;
        const accessible = await this.tryAuthorize(
          userId,
          hint.repository.owner,
          hint.repository.repository,
        );
        if (!accessible) continue;
        candidates.push({
          ...hint,
          recommendation: 'suggest_add',
        });
      }
    }

    const proposed = this.buildDetectedRelationships(scans);
    const { items: limited, truncated: relTruncated } = truncateToBudget(
      proposed,
      MULTI_REPO_MAX_RELATIONSHIPS,
    );
    truncated = truncated || relTruncated;

    for (const rel of limited) {
      await this.upsertRelationship(userId, systemId, rel);
    }

    const relationships = (
      await this.prisma.repositoryRelationship.findMany({
        where: { userId, systemId },
        orderBy: { updatedAt: 'desc' },
        take: MULTI_REPO_MAX_RELATIONSHIPS,
      })
    ).map(toRepositoryRelationship);

    // Never auto-add candidates into the system.
    return {
      analyzed: scans.filter((s) => s.available).length,
      relationships,
      candidates: this.dedupeCandidates(candidates),
      unavailable,
      truncated,
    };
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

  private scanRepoFiles(identity: RepositoryIdentity, files: FetchedFile[]): RepoScan {
    const scan: RepoScan = {
      identity,
      available: true,
      files,
      httpProviders: [],
      httpConsumers: [],
      kafkaProducers: [],
      kafkaConsumers: [],
      packageDeps: [],
      candidateHints: [],
    };

    const now = new Date().toISOString();

    for (const file of files) {
      if (file.path.endsWith('package.json') || file.path === 'package.json') {
        const manifest = parsePackageJsonManifest(file.content);
        if (manifest?.name) scan.packageName = manifest.name;
        if (manifest) {
          for (const dep of manifest.dependencies) {
            scan.packageDeps.push({ name: dep.name, filePath: file.path });
          }
          if (manifest.repository?.owner && manifest.repository.repository) {
            const other = toRepositoryIdentity(
              manifest.repository.owner,
              manifest.repository.repository,
            );
            if (!sameRepository(other, identity)) {
              scan.candidateHints.push({
                repository: other,
                relationship: 'documentation_reference',
                confidence: 'medium',
                evidence: [
                  {
                    filePath: file.path,
                    summary: `package.json repository field points to ${other.owner}/${other.repository}`,
                    observedAt: now,
                  },
                ],
                recommendation: 'suggest_add',
              });
            }
          }
        }
      }

      if (/readme\.md$/i.test(file.path)) {
        const linkRe =
          /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi;
        let match: RegExpExecArray | null;
        while ((match = linkRe.exec(file.content)) !== null) {
          const other = toRepositoryIdentity(match[1]!, match[2]!);
          if (sameRepository(other, identity)) continue;
          scan.candidateHints.push({
            repository: other,
            relationship: 'documentation_reference',
            confidence: 'low',
            evidence: [
              {
                filePath: file.path,
                summary: `README references github.com/${other.owner}/${other.repository}`,
                observedAt: now,
              },
            ],
            recommendation: 'suggest_add',
          });
        }
      }

      for (const hit of detectHttpProviderPaths(file.content, file.path)) {
        scan.httpProviders.push({
          method: hit.method,
          path: hit.path,
          filePath: file.path,
          summary: hit.summary,
          confidence: hit.confidence,
        });
      }
      for (const hit of detectHttpConsumerPaths(file.content, file.path)) {
        scan.httpConsumers.push({
          method: hit.method,
          path: hit.path,
          filePath: file.path,
          summary: hit.summary,
          confidence: hit.confidence,
        });
      }
      for (const hit of detectKafkaTopicUsages(file.content, file.path)) {
        const entry = {
          topic: hit.topic,
          filePath: file.path,
          summary: hit.summary,
          confidence: hit.confidence,
        };
        if (hit.role === 'producer') scan.kafkaProducers.push(entry);
        else scan.kafkaConsumers.push(entry);
      }
    }

    return scan;
  }

  private buildDetectedRelationships(scans: RepoScan[]): Array<{
    from: RepositoryIdentity;
    to: RepositoryIdentity;
    type: RepositoryRelationshipType;
    resourceKind?: RelationshipResourceKind;
    resourceKey?: string;
    confidence: RelationshipConfidence;
    provenanceType: RelationshipProvenanceType;
    summary: string;
    filePath?: string;
  }> {
    const out: Array<{
      from: RepositoryIdentity;
      to: RepositoryIdentity;
      type: RepositoryRelationshipType;
      resourceKind?: RelationshipResourceKind;
      resourceKey?: string;
      confidence: RelationshipConfidence;
      provenanceType: RelationshipProvenanceType;
      summary: string;
      filePath?: string;
    }> = [];

    const available = scans.filter((s) => s.available);

    for (const provider of available) {
      for (const api of provider.httpProviders) {
        const resourceKey = api.method ? `${api.method} ${api.path}` : api.path;
        out.push({
          from: provider.identity,
          to: provider.identity,
          type: 'PROVIDES_API',
          resourceKind: 'http_operation',
          resourceKey,
          confidence: api.confidence,
          provenanceType: 'openapi_reference',
          summary: api.summary,
          filePath: api.filePath,
        });

        for (const consumer of available) {
          if (sameRepository(consumer.identity, provider.identity)) continue;
          const match = consumer.httpConsumers.find(
            (c) =>
              c.path === api.path || (api.method && c.method === api.method && c.path === api.path),
          );
          if (!match) continue;
          out.push({
            from: consumer.identity,
            to: provider.identity,
            type: 'CONSUMES_API',
            resourceKind: 'http_operation',
            resourceKey,
            confidence:
              CONFIDENCE_RANK[match.confidence] < CONFIDENCE_RANK[api.confidence]
                ? match.confidence
                : api.confidence,
            provenanceType: 'http_call',
            summary: `${match.summary} → ${api.summary}`,
            filePath: match.filePath,
          });
          out.push({
            from: consumer.identity,
            to: provider.identity,
            type: 'HTTP_CALLS',
            resourceKind: 'http_operation',
            resourceKey,
            confidence: match.confidence,
            provenanceType: 'http_call',
            summary: match.summary,
            filePath: match.filePath,
          });
        }
      }
    }

    for (const producer of available) {
      for (const event of producer.kafkaProducers) {
        out.push({
          from: producer.identity,
          to: producer.identity,
          type: 'PRODUCES_EVENT',
          resourceKind: 'kafka_topic',
          resourceKey: event.topic,
          confidence: event.confidence,
          provenanceType: 'kafka_producer',
          summary: event.summary,
          filePath: event.filePath,
        });

        for (const consumer of available) {
          if (sameRepository(consumer.identity, producer.identity)) continue;
          const match = consumer.kafkaConsumers.find((c) => c.topic === event.topic);
          if (!match) continue;
          out.push({
            from: consumer.identity,
            to: producer.identity,
            type: 'CONSUMES_EVENT',
            resourceKind: 'kafka_topic',
            resourceKey: event.topic,
            confidence: match.confidence,
            provenanceType: 'kafka_consumer',
            summary: `${match.summary} (topic ${event.topic})`,
            filePath: match.filePath,
          });
        }
      }
    }

    for (const dependent of available) {
      for (const dep of dependent.packageDeps) {
        const provider = available.find(
          (s) =>
            s.packageName &&
            s.packageName.toLowerCase() === dep.name.toLowerCase() &&
            !sameRepository(s.identity, dependent.identity),
        );
        if (!provider) continue;
        out.push({
          from: dependent.identity,
          to: provider.identity,
          type: 'DEPENDS_ON_PACKAGE',
          resourceKind: 'package',
          resourceKey: dep.name,
          confidence: 'high',
          provenanceType: 'package_reference',
          summary: `Depends on package ${dep.name}`,
          filePath: dep.filePath,
        });
        out.push({
          from: provider.identity,
          to: provider.identity,
          type: 'PROVIDES_PACKAGE',
          resourceKind: 'package',
          resourceKey: dep.name,
          confidence: 'high',
          provenanceType: 'package_reference',
          summary: `Provides package ${dep.name}`,
          filePath: 'package.json',
        });
      }
    }

    return out;
  }

  private async upsertRelationship(
    userId: string,
    systemId: string,
    rel: {
      from: RepositoryIdentity;
      to: RepositoryIdentity;
      type: RepositoryRelationshipType;
      resourceKind?: RelationshipResourceKind;
      resourceKey?: string;
      confidence: RelationshipConfidence;
      provenanceType: RelationshipProvenanceType;
      summary: string;
      filePath?: string;
    },
  ): Promise<void> {
    const existing = await this.prisma.repositoryRelationship.findFirst({
      where: {
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
    const provenance: RelationshipProvenance[] = [
      {
        type: rel.provenanceType,
        owner: rel.from.owner,
        repository: rel.from.repository,
        filePath: rel.filePath,
        summary: rel.summary,
        observedAt: now.toISOString(),
      },
    ];
    const freshness = {
      lastValidatedAt: now.toISOString(),
    };

    if (!existing) {
      await this.prisma.repositoryRelationship.create({
        data: {
          userId,
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
    if (
      existingProvenance.some((p) => p.type === 'user_explicit') &&
      rel.provenanceType !== 'user_explicit'
    ) {
      await this.prisma.repositoryRelationship.update({
        where: { id: existing.id },
        data: {
          lastValidatedAt: now,
          freshnessJson: freshness as unknown as Prisma.InputJsonValue,
        },
      });
      return;
    }

    const existingConfidence = existing.confidence as RelationshipConfidence;
    if (CONFIDENCE_RANK[rel.confidence] < CONFIDENCE_RANK[existingConfidence]) {
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
    if (rel.resource?.kind === 'http_operation') {
      return (
        identifiers.httpKeys.includes(key) ||
        identifiers.httpKeys.some((k) => key.includes(k) || k.includes(key)) ||
        identifiers.paths.some((p) => key.includes(p)) ||
        identifiers.paths.some((p) => rel.provenance.some((pr) => pr.filePath?.includes(p)))
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
        const token = await this.githubConnections.getDecryptedToken(userId);
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
