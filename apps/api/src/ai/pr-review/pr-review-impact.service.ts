import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
  ApiContractChange,
  NormalizedApiContract,
  PrReviewDownstreamImpact,
  PrReviewImpactContract,
  PrReviewImpactWarning,
  RepositoryIdentity,
} from '@project-x/types';
import { OPENAPI_MAX_DOCUMENT_BYTES } from '@project-x/types';
import { looksLikeOpenApiPath, repositoryKey, toRepositoryIdentity } from '@project-x/shared';

import {
  ContractImpactService,
  redactImpactFindings,
} from '../../contract-impact/contract-impact.service';
import { diffApiContracts } from '../../openapi/lib/diff';
import { normalizeOpenApiDocument } from '../../openapi/lib/normalize';
import { parseOpenApiRaw } from '../../openapi/lib/parse-raw';
import type { ChangedFile } from './pr-review-files';
import { PullRequestDiffService, type FileAtRefResult } from './pull-request-diff.service';

/** Contract files compared per review (each costs at most two GitHub reads). */
export const PR_IMPACT_MAX_CONTRACTS = 3;
const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

export interface PrReviewImpactInput {
  userId: string;
  workspaceId: string;
  owner: string;
  repository: string;
  source: 'github_api' | 'page' | string;
  baseSha?: string;
  headSha?: string;
  files: Array<Pick<ChangedFile, 'path' | 'status' | 'previousPath'>>;
  signal?: AbortSignal;
  now?: Date;
}

/** Changed files that are OpenAPI / Swagger documents (by path, incl. a renamed file's old path). */
export function changedContractFiles(
  files: PrReviewImpactInput['files'],
): PrReviewImpactInput['files'] {
  const seen = new Set<string>();
  return files.filter((f) => {
    const isContract =
      looksLikeOpenApiPath(f.path) ||
      (f.previousPath ? looksLikeOpenApiPath(f.previousPath) : false);
    if (!isContract || seen.has(f.path)) return false;
    seen.add(f.path);
    return true;
  });
}

type Parsed = { ok: true; contract: NormalizedApiContract } | { ok: false };

function parseContract(raw: string): Parsed {
  try {
    const { document } = parseOpenApiRaw(raw);
    return { ok: true, contract: normalizeOpenApiDocument(document, { type: 'page' }, raw) };
  } catch {
    return { ok: false };
  }
}

const READ_WARNING: Record<
  Exclude<FileAtRefResult, { ok: true }>['reason'],
  PrReviewImpactWarning
> = {
  not_found: 'contract_unavailable',
  no_access: 'contract_unavailable',
  rate_limited: 'rate_limited',
  too_large: 'contract_too_large',
  unavailable: 'contract_unavailable',
  invalid: 'contract_unavailable',
};

/**
 * Deterministic downstream impact of a PR's OpenAPI changes:
 * changed contract files → base/head read at immutable SHAs (same credentials as the diff)
 * → Phase 1 structural diff → authorized dependency graph → consumers re-authorized with
 * the reviewer's own GitHub connection. No AI, no usage charge, bounded GitHub requests.
 * Every failure becomes an explicit state or warning, never "no impact".
 */
@Injectable()
export class PrReviewImpactService {
  private readonly logger = new Logger(PrReviewImpactService.name);

  constructor(
    private readonly diffService: PullRequestDiffService,
    @Optional() private readonly contractImpact?: ContractImpactService,
  ) {}

  async analyze(input: PrReviewImpactInput): Promise<PrReviewDownstreamImpact> {
    const provider: RepositoryIdentity = toRepositoryIdentity(input.owner, input.repository);
    const analyzedAt = (input.now ?? new Date()).toISOString();
    const warnings = new Set<PrReviewImpactWarning>();
    const base = {
      provider,
      ...(input.baseSha ? { baseSha: input.baseSha } : {}),
      ...(input.headSha ? { headSha: input.headSha } : {}),
      findings: [],
      withheldConsumers: 0,
      analyzedAt,
    };
    const done = (
      status: PrReviewDownstreamImpact['status'],
      contracts: PrReviewImpactContract[],
      extra: Partial<PrReviewDownstreamImpact> = {},
    ): PrReviewDownstreamImpact => ({
      ...base,
      status,
      contracts,
      warnings: [...warnings],
      ...extra,
    });

    let files = changedContractFiles(input.files);
    if (files.length === 0) return done('not_analyzed', []); // no GitHub request at all
    if (files.length > PR_IMPACT_MAX_CONTRACTS) {
      warnings.add('too_many_contracts');
      files = files.slice(0, PR_IMPACT_MAX_CONTRACTS);
    }
    const unavailableContracts = files.map<PrReviewImpactContract>((f) => ({
      path: f.path,
      ...(f.previousPath ? { previousPath: f.previousPath } : {}),
      status: 'unavailable',
      breaking: 0,
      nonBreaking: 0,
      uncertain: 0,
    }));
    if (
      input.source !== 'github_api' ||
      !input.baseSha ||
      !input.headSha ||
      !FULL_SHA.test(input.baseSha) ||
      !FULL_SHA.test(input.headSha)
    ) {
      warnings.add('unverified_shas');
      return done('unavailable', unavailableContracts);
    }

    const read = (sha: string, path: string) =>
      this.diffService.fetchFileAtRef({
        userId: input.userId,
        workspaceId: input.workspaceId,
        owner: provider.owner,
        repository: provider.repository,
        sha,
        path,
        maxBytes: OPENAPI_MAX_DOCUMENT_BYTES,
        ...(input.signal ? { signal: input.signal } : {}),
      });

    const contracts: PrReviewImpactContract[] = [];
    const changes: ApiContractChange[] = [];
    for (const file of files) {
      const entry: PrReviewImpactContract = {
        path: file.path,
        ...(file.previousPath ? { previousPath: file.previousPath } : {}),
        status: 'unavailable',
        breaking: 0,
        nonBreaking: 0,
        uncertain: 0,
      };
      contracts.push(entry);
      if (input.signal?.aborted) {
        warnings.add('timeout');
        continue;
      }
      if (file.status === 'removed') {
        // A deleted spec file is not proof that endpoints were removed (they may have moved).
        entry.status = 'deleted';
        warnings.add('contract_deleted');
        continue;
      }
      const [baseRead, headRead] = await Promise.all([
        file.status === 'added'
          ? Promise.resolve<FileAtRefResult>({ ok: false, reason: 'not_found' })
          : read(input.baseSha, file.previousPath ?? file.path),
        read(input.headSha, file.path),
      ]);
      if (!headRead.ok) {
        if (headRead.reason === 'not_found') {
          entry.status = 'deleted';
          warnings.add('contract_deleted');
        } else {
          warnings.add(input.signal?.aborted ? 'timeout' : READ_WARNING[headRead.reason]);
        }
        continue;
      }
      const head = parseContract(headRead.text);
      if (!head.ok) {
        entry.status = 'unparseable';
        warnings.add('contract_unparseable');
        continue;
      }
      if (!baseRead.ok) {
        if (baseRead.reason === 'not_found') {
          // New contract: every operation is an addition, nothing can break.
          entry.status = 'added';
          entry.nonBreaking = head.contract.operations.length;
        } else {
          warnings.add(input.signal?.aborted ? 'timeout' : READ_WARNING[baseRead.reason]);
        }
        continue;
      }
      const baseContract = parseContract(baseRead.text);
      if (!baseContract.ok) {
        entry.status = 'unparseable';
        warnings.add('contract_unparseable');
        continue;
      }
      const diff = diffApiContracts(baseContract.contract, head.contract, {
        baseRef: input.baseSha,
        headRef: input.headSha,
      });
      entry.status = 'compared';
      entry.breaking = diff.breakingChanges.length;
      entry.nonBreaking = diff.nonBreakingChanges.length;
      entry.uncertain = diff.uncertainChanges.length;
      changes.push(...diff.breakingChanges);
    }

    const verified = contracts.filter((c) => c.status === 'compared' || c.status === 'added');
    const incomplete = contracts.length - verified.length > 0 || warnings.has('too_many_contracts');
    if (verified.length === 0) return done('unavailable', contracts);
    if (changes.length === 0) return done(incomplete ? 'partial' : 'compatible', contracts);
    if (!this.contractImpact) {
      warnings.add('contract_unavailable');
      return done('unavailable', contracts);
    }

    const { result, systemsConsidered } = await this.contractImpact.computeForProvider(
      input.userId,
      input.workspaceId,
      {
        owner: provider.owner,
        repository: provider.repository,
        changes,
        ...(input.now ? { now: input.now } : {}),
      },
    );
    if (systemsConsidered === 0) {
      return done('no_system', contracts, { findings: result.findings });
    }

    // Consumers are shown only when the reviewer can read them with their own connection.
    const consumers = result.findings.flatMap((f) => f.consumers.map((c) => c.repository));
    const unique = [...new Map(consumers.map((r) => [repositoryKey(r), r])).values()];
    const { access, noToken } = await this.contractImpact.verifyAccess(
      input.userId,
      unique,
      input.signal,
    );
    const { findings, withheld } = redactImpactFindings(result.findings, access);
    if (noToken && unique.length > 0) warnings.add('no_personal_token');
    if ([...access.values()].includes('unavailable') || access.size < unique.length) {
      warnings.add('access_check_unavailable');
    }
    if (withheld > 0) warnings.add('consumers_withheld');
    if (result.graph.stale) warnings.add('stale_graph');

    const visible = findings.some((f) => f.consumers.length > 0);
    const status: PrReviewDownstreamImpact['status'] =
      incomplete || warnings.has('access_check_unavailable')
        ? 'partial'
        : visible
          ? 'verified'
          : withheld > 0
            ? 'partial'
            : 'no_known_consumers';
    this.logger.log({
      msg: 'pr_review.impact',
      status,
      contracts: contracts.length,
      breaking: changes.length,
      consumersVisible: findings.reduce((n, f) => n + f.consumers.length, 0),
      withheld,
    });
    return done(status, contracts, { findings, withheldConsumers: withheld, graph: result.graph });
  }
}
