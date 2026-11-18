import type {
  ApiContractChange,
  DownstreamImpactConsumer,
  DownstreamImpactFinding,
  DownstreamImpactResult,
  RelationshipConfidence,
  RelationshipProvenance,
  RepositoryIdentity,
  RepositoryRelationship,
} from '@project-x/types';

import { httpPathsMatch, normalizeHttpMethod, normalizeHttpPath } from './http-paths';
import { sameRepository } from './identity';

/**
 * Deterministic downstream impact of a provider's contract changes.
 *
 * Pure: no database, network or authorization. Callers must pass only relationships the
 * user may see (their own, in systems of their workspace, between enabled repositories).
 *
 * A finding needs a BREAKING contract change on an operation and an ACTIVE `HTTP_CALLS`
 * relationship consumer → changed provider for the same method and canonical path. Nothing
 * is inferred from file names, shared endpoints or text. A consumer is "potentially affected":
 * whether it actually reads the changed field is not known here.
 */

export interface ScopedRelationship {
  relationship: RepositoryRelationship;
  system?: { id: string; name?: string };
}

export const DEFAULT_GRAPH_FRESHNESS_DAYS = 14;
const MAX_EVIDENCE = 6;
const RANK: Record<RelationshipConfidence, number> = { low: 1, medium: 2, high: 3 };

/** `GET /api/users/{param}` from a relationship resource key ("METHOD /path"). */
function parseOperationKey(key: string | undefined): { method: string; path: string } | null {
  const m = key?.match(/^([A-Za-z]+)\s+(\S+)$/);
  if (!m) return null;
  const method = normalizeHttpMethod(m[1]);
  const path = normalizeHttpPath(m[2]);
  return method && path ? { method, path } : null;
}

function validatedAt(rel: RepositoryRelationship): string | undefined {
  const raw = rel.freshness?.lastValidatedAt ?? rel.lastValidatedAt;
  return raw && !Number.isNaN(Date.parse(raw)) ? new Date(raw).toISOString() : undefined;
}

export function computeDownstreamImpact(input: {
  provider: RepositoryIdentity;
  /** All changes of the diff; only breaking ones with an operation are considered. */
  changes: ApiContractChange[];
  relationships: ScopedRelationship[];
  now?: Date;
  freshnessDays?: number;
}): DownstreamImpactResult {
  const now = input.now ?? new Date();
  const freshnessMs = (input.freshnessDays ?? DEFAULT_GRAPH_FRESHNESS_DAYS) * 24 * 60 * 60 * 1000;
  const isStale = (iso: string | undefined) =>
    iso !== undefined && now.getTime() - Date.parse(iso) > freshnessMs;

  // Consumer → provider HTTP calls into the changed repository only (no self rows, no
  // superseded rows, no provider-operation records).
  const edges = input.relationships.filter(({ relationship: r }) => {
    return (
      r.type === 'HTTP_CALLS' &&
      r.status === 'active' &&
      r.resource?.kind === 'http_operation' &&
      sameRepository(r.to, input.provider) &&
      !sameRepository(r.from, input.provider) &&
      parseOperationKey(r.resource.key) !== null
    );
  });

  const findings: DownstreamImpactFinding[] = [];
  const seenChanges = new Set<string>();
  for (const change of input.changes) {
    if (change.impact !== 'breaking' || !change.method || !change.path) continue;
    const method = normalizeHttpMethod(change.method);
    const path = normalizeHttpPath(change.path);
    if (!method || !path) continue;
    const dedupeKey = `${change.kind}|${method} ${path}|${change.statusCode ?? ''}|${change.fieldPath ?? ''}`;
    if (seenChanges.has(dedupeKey)) continue;
    seenChanges.add(dedupeKey);

    const byConsumer = new Map<string, DownstreamImpactConsumer>();
    for (const { relationship: r, system } of edges) {
      const op = parseOperationKey(r.resource!.key)!;
      if (op.method !== method || !httpPathsMatch(op.path, path)) continue;
      const key = `${r.from.owner}/${r.from.repository}`.toLowerCase();
      const lastValidatedAt = validatedAt(r);
      const existing = byConsumer.get(key);
      if (!existing) {
        byConsumer.set(key, {
          repository: r.from,
          confidence: r.confidence,
          systems: system ? [system] : [],
          evidence: r.provenance.slice(0, MAX_EVIDENCE),
          ...(lastValidatedAt ? { lastValidatedAt } : {}),
          stale: isStale(lastValidatedAt),
        });
        continue;
      }
      // Same consumer through another system or row: merge, keep the strongest evidence.
      if (system && !existing.systems.some((s) => s.id === system.id))
        existing.systems.push(system);
      if (RANK[r.confidence] > RANK[existing.confidence]) existing.confidence = r.confidence;
      const known = new Set(existing.evidence.map(evidenceKey));
      for (const p of r.provenance) {
        if (existing.evidence.length >= MAX_EVIDENCE) break;
        if (!known.has(evidenceKey(p))) existing.evidence.push(p);
      }
      if (
        lastValidatedAt &&
        (!existing.lastValidatedAt || lastValidatedAt > existing.lastValidatedAt)
      ) {
        existing.lastValidatedAt = lastValidatedAt;
        existing.stale = isStale(lastValidatedAt);
      }
    }

    const consumers = [...byConsumer.values()].sort(
      (a, b) =>
        RANK[b.confidence] - RANK[a.confidence] ||
        `${a.repository.owner}/${a.repository.repository}`.localeCompare(
          `${b.repository.owner}/${b.repository.repository}`,
        ),
    );
    findings.push({
      changeId: change.id,
      kind: change.kind,
      title: change.title,
      method,
      path: change.path,
      operation: `${method} ${path}`,
      ...(change.fieldPath ? { fieldPath: change.fieldPath } : {}),
      ...(change.statusCode ? { statusCode: change.statusCode } : {}),
      status: consumers.length > 0 ? 'potentially_affected' : 'no_known_consumers',
      consumers,
    });
  }

  const times = edges
    .map(({ relationship }) => validatedAt(relationship))
    .filter(Boolean) as string[];
  times.sort();
  return {
    provider: input.provider,
    findings,
    graph: {
      relationshipsConsidered: edges.length,
      ...(times.length
        ? { oldestValidatedAt: times[0], newestValidatedAt: times[times.length - 1] }
        : {}),
      stale: times.some((t) => isStale(t)),
    },
  };
}

function evidenceKey(p: RelationshipProvenance): string {
  return `${p.type}|${p.repository ?? ''}|${p.filePath ?? ''}|${p.summary}`;
}
