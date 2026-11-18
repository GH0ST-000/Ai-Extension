import { Injectable } from '@nestjs/common';
import type {
  ApiContractChange,
  DownstreamImpactFinding,
  DownstreamImpactResult,
  RepositoryIdentity,
} from '@project-x/types';
import {
  computeDownstreamImpact,
  repositoryKey,
  toRepositoryIdentity,
  type ScopedRelationship,
} from '@project-x/shared';
import { MULTI_REPO_MAX_RELATIONSHIPS, MULTI_REPO_MAX_REPOS_PER_SYSTEM } from '@project-x/types';

import { GithubAccessService } from '../github-app/github-access.service';
import { toRepositoryRelationship } from '../multi-repo/multi-repo.mapper';
import { PrismaService } from '../prisma/prisma.service';

/** Consumer repositories re-authorized per analysis / per history read. */
export const CONSUMER_ACCESS_MAX_CHECKS = 10;
const ACCESS_CONCURRENCY = 4;
const ACCESS_TIMEOUT_MS = 10_000;

export type RepositoryAccessVerdict = 'allowed' | 'denied' | 'unavailable';

/**
 * The caller's authorized view of the dependency graph into `provider`: systems of the
 * workspace that contain the provider as an ENABLED repository (optionally one system), the
 * caller's own ACTIVE `HTTP_CALLS` rows into the provider, from consumers enabled in that
 * system. Pure database reads — no GitHub calls, no usage.
 */
export async function loadScopedHttpConsumers(
  prisma: PrismaService,
  input: { userId: string; workspaceId: string; provider: RepositoryIdentity; systemId?: string },
): Promise<{ relationships: ScopedRelationship[]; systemsConsidered: number }> {
  const { provider } = input;
  const systems = await prisma.projectSystem.findMany({
    where: {
      workspaceId: input.workspaceId,
      ...(input.systemId ? { id: input.systemId } : {}),
      repositories: {
        // GitHub owner/repository names are case-insensitive.
        some: {
          owner: { equals: provider.owner, mode: 'insensitive' },
          repository: { equals: provider.repository, mode: 'insensitive' },
          enabled: true,
        },
      },
    },
    include: { repositories: true },
    take: MULTI_REPO_MAX_REPOS_PER_SYSTEM * 10,
  });
  const relationships: ScopedRelationship[] = [];
  for (const system of systems) {
    const enabled = new Set(
      system.repositories
        .filter((r) => r.enabled)
        .map((r) => repositoryKey(toRepositoryIdentity(r.owner, r.repository))),
    );
    const rows = await prisma.repositoryRelationship.findMany({
      where: {
        userId: input.userId,
        workspaceId: input.workspaceId,
        systemId: system.id,
        status: 'active',
        type: 'HTTP_CALLS',
        toOwner: { equals: provider.owner, mode: 'insensitive' },
        toRepository: { equals: provider.repository, mode: 'insensitive' },
      },
      take: MULTI_REPO_MAX_RELATIONSHIPS,
    });
    for (const row of rows) {
      const relationship = toRepositoryRelationship(row);
      if (!enabled.has(repositoryKey(relationship.from))) continue; // disabled consumer
      relationships.push({ relationship, system: { id: system.id, name: system.name } });
    }
  }
  return { relationships, systemsConsidered: systems.length };
}

/**
 * Remove consumers the viewer is not verified to access. Fail closed: `denied`,
 * `unavailable` and unchecked repositories are all removed, and nothing about them (name,
 * paths, evidence) remains — only a count.
 */
export function redactImpactFindings(
  findings: DownstreamImpactFinding[],
  access: Map<string, RepositoryAccessVerdict>,
): { findings: DownstreamImpactFinding[]; withheld: number } {
  const hidden = new Set<string>();
  const redacted = findings.map((finding) => {
    const consumers = finding.consumers.filter((c) => {
      const key = repositoryKey(c.repository);
      const ok = access.get(key) === 'allowed';
      if (!ok) hidden.add(key);
      return ok;
    });
    return { ...finding, consumers };
  });
  return { findings: redacted, withheld: hidden.size };
}

/**
 * Deterministic downstream impact for PR Review and Review History. Kept apart from
 * MultiRepoService so PR Review can use it without the Systems module graph.
 */
@Injectable()
export class ContractImpactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly githubAccess: GithubAccessService,
  ) {}

  async computeForProvider(
    userId: string,
    workspaceId: string,
    input: {
      owner: string;
      repository: string;
      changes: ApiContractChange[];
      systemId?: string;
      now?: Date;
    },
  ): Promise<{ result: DownstreamImpactResult; systemsConsidered: number }> {
    const provider = toRepositoryIdentity(input.owner, input.repository);
    const { relationships, systemsConsidered } = await loadScopedHttpConsumers(this.prisma, {
      userId,
      workspaceId,
      provider,
      ...(input.systemId ? { systemId: input.systemId } : {}),
    });
    const result = computeDownstreamImpact({
      provider,
      changes: input.changes,
      relationships,
      ...(input.now ? { now: input.now } : {}),
    });
    return { result, systemsConsidered };
  }

  /**
   * Can `userId` read these repositories with THEIR OWN GitHub connection (the credential
   * Systems discovered them with)? Never another user's token and never the workspace App.
   * Bounded (deduplicated, at most CONSUMER_ACCESS_MAX_CHECKS, 4 at a time, 10 s each).
   * Repositories beyond the cap stay unchecked (callers treat them as not allowed).
   */
  async verifyAccess(
    userId: string,
    repositories: RepositoryIdentity[],
    signal?: AbortSignal,
  ): Promise<{ access: Map<string, RepositoryAccessVerdict>; noToken: boolean }> {
    const access = new Map<string, RepositoryAccessVerdict>();
    const unique = new Map<string, RepositoryIdentity>();
    for (const repo of repositories) unique.set(repositoryKey(repo), repo);
    if (unique.size === 0) return { access, noToken: false };

    let token: string | null;
    try {
      token = await this.githubAccess.getDecryptedToken(userId);
    } catch {
      token = null;
    }
    if (!token) {
      for (const key of unique.keys()) access.set(key, 'denied');
      return { access, noToken: true };
    }

    const queue = [...unique.entries()].slice(0, CONSUMER_ACCESS_MAX_CHECKS);
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const [key, repo] = item;
        access.set(key, await this.checkOne(token, repo, signal));
      }
    };
    await Promise.all(Array.from({ length: ACCESS_CONCURRENCY }, worker));
    return { access, noToken: false };
  }

  private async checkOne(
    token: string,
    repo: RepositoryIdentity,
    signal?: AbortSignal,
  ): Promise<RepositoryAccessVerdict> {
    if (signal?.aborted) return 'unavailable';
    try {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repository)}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'Project-X',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: signal
            ? AbortSignal.any([AbortSignal.timeout(ACCESS_TIMEOUT_MS), signal])
            : AbortSignal.timeout(ACCESS_TIMEOUT_MS),
        },
      );
      if (response.ok) return 'allowed';
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get('x-ratelimit-remaining') === '0' ||
            response.headers.has('retry-after')));
      if (rateLimited) return 'unavailable';
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        return 'denied';
      }
      return 'unavailable';
    } catch {
      return 'unavailable';
    }
  }
}
