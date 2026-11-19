import type { RelationshipConfidence } from '@project-x/types';

import type { HttpCall } from './http-calls';
import {
  httpMethodsMatch,
  httpPathsMatch,
  isGenericHttpPath,
  type HttpMethodName,
} from './http-paths';

/**
 * Deterministic consumer → provider matching between repositories of one system.
 *
 * A relationship needs evidence that identifies ONE provider:
 *  - a call matches exactly one other repository's route / OpenAPI operation (a call matching
 *    several providers is ambiguous, unless the consumer's manifest ties the call's base-URL
 *    variable to one of them), and
 *  - at least one matched endpoint is not a generic one (`/health`, `/status`, ...).
 * A manifest declaration alone yields a low-confidence "declared" link; declaration plus code
 * evidence yields high confidence. External absolute URLs are never matched.
 */

export interface ProviderOperation {
  method?: HttpMethodName;
  path: string;
  filePath: string;
  line?: number;
  source: 'openapi' | 'route';
  confidence: RelationshipConfidence;
  summary: string;
}

export interface CallSite extends HttpCall {
  filePath: string;
}

export interface DeclaredDependency {
  /** repositoryKey() of the target repository (already resolved to a system member). */
  targetKey: string;
  filePath: string;
  baseUrlEnv?: string;
  endpoints: Array<{ method?: HttpMethodName; path: string }>;
}

export interface RepoHttpFacts {
  key: string;
  operations: ProviderOperation[];
  calls: CallSite[];
  declared: DeclaredDependency[];
}

export interface MatchedEndpoint {
  method?: HttpMethodName;
  /** Provider's path (normalized) — or the declared/called path when the provider route is unknown. */
  path: string;
  generic: boolean;
  calls: CallSite[];
  /** Best provider evidence (OpenAPI preferred). */
  operation?: ProviderOperation;
  /** Every provider operation describing this endpoint (e.g. OpenAPI and the Express route). */
  operations: ProviderOperation[];
  /**
   * Several repositories serve this endpoint; it was attributed only because the consumer's
   * manifest lists it for this provider. Corroborating, never strong evidence on its own.
   */
  disambiguatedByManifest: boolean;
}

export interface HttpDependencyLink {
  consumerKey: string;
  providerKey: string;
  endpoints: MatchedEndpoint[];
  declared?: DeclaredDependency;
  /** Code in the consumer uses the base-URL variable the manifest declares for this provider. */
  declaredEnvUsed: boolean;
  /** Matched to provider routes / OpenAPI (not only declared). */
  corroborated: boolean;
  confidence: RelationshipConfidence;
}

export interface HttpMatchResult {
  links: HttpDependencyLink[];
  /** Calls per consumer that matched no provider or several (ambiguous). */
  unresolved: Map<string, number>;
}

const RANK: Record<RelationshipConfidence, number> = { low: 1, medium: 2, high: 3 };

/** All provider operations matching the call, best first (OpenAPI, then confidence). */
function operationsFor(call: CallSite, provider: RepoHttpFacts): ProviderOperation[] {
  return provider.operations
    .filter((op) => httpMethodsMatch(call.method, op.method) && httpPathsMatch(call.path, op.path))
    .sort(
      (a, b) =>
        (a.source === 'openapi' ? 0 : 1) - (b.source === 'openapi' ? 0 : 1) ||
        RANK[b.confidence] - RANK[a.confidence],
    );
}

/**
 * Strong evidence: a concrete call (known method, medium+ confidence) matched to a provider
 * operation that is OpenAPI or a medium+ confidence route, on a non-generic endpoint.
 */
function isStrong(e: MatchedEndpoint): boolean {
  const op = e.operation;
  if (!op || e.generic || e.disambiguatedByManifest) return false;
  const trustedProvider = op.source === 'openapi' || RANK[op.confidence] >= RANK.medium;
  return trustedProvider && e.calls.some((c) => c.method && RANK[c.confidence] >= RANK.medium);
}

export function matchHttpDependencies(repos: RepoHttpFacts[]): HttpMatchResult {
  const links = new Map<string, HttpDependencyLink>();
  const unresolved = new Map<string, number>();
  const byKey = new Map(repos.map((r) => [r.key, r]));

  const linkFor = (consumer: RepoHttpFacts, providerKey: string): HttpDependencyLink => {
    const id = `${consumer.key}->${providerKey}`;
    let link = links.get(id);
    if (!link) {
      const declared = consumer.declared.find((d) => d.targetKey === providerKey);
      link = {
        consumerKey: consumer.key,
        providerKey,
        endpoints: [],
        ...(declared ? { declared } : {}),
        declaredEnvUsed: false,
        corroborated: false,
        confidence: 'low',
      };
      links.set(id, link);
    }
    return link;
  };

  const addEndpoint = (
    link: HttpDependencyLink,
    call: CallSite,
    operations: ProviderOperation[],
    byManifest: boolean,
  ) => {
    const operation = operations[0];
    const method = call.method ?? operation?.method;
    const path = operation?.path ?? call.path;
    let endpoint = link.endpoints.find((e) => e.method === method && e.path === path);
    if (!endpoint) {
      endpoint = {
        ...(method ? { method } : {}),
        path,
        generic: isGenericHttpPath(path),
        calls: [],
        ...(operation ? { operation } : {}),
        operations: [],
        disambiguatedByManifest: byManifest,
      };
      link.endpoints.push(endpoint);
    }
    for (const op of operations) {
      const known = endpoint.operations.some(
        (o) => o.source === op.source && o.filePath === op.filePath && o.line === op.line,
      );
      if (!known && endpoint.operations.length < 4) endpoint.operations.push(op);
    }
    // Any unambiguous call makes the endpoint unambiguous.
    if (!byManifest) endpoint.disambiguatedByManifest = false;
    if (endpoint.calls.length < 5) endpoint.calls.push(call);
  };

  for (const consumer of repos) {
    for (const call of consumer.calls) {
      if (call.external) continue;
      const envDecl = call.baseRef
        ? consumer.declared.find(
            (d) => d.baseUrlEnv && d.baseUrlEnv.toLowerCase() === call.baseRef!.toLowerCase(),
          )
        : undefined;

      const providers = repos
        .filter((p) => p.key !== consumer.key)
        .map((p) => ({ provider: p, operations: operationsFor(call, p) }))
        .filter((x) => x.operations.length > 0);

      let chosen: { provider: RepoHttpFacts; operations: ProviderOperation[] } | undefined;
      let byManifest = false;
      if (envDecl) {
        // The manifest says which repository this base URL points to.
        const target = byKey.get(envDecl.targetKey);
        if (target && target.key !== consumer.key) {
          const operations = operationsFor(call, target);
          const elsewhere = providers.some((x) => x.provider.key !== target.key);
          // Conflict: the declared target does not serve this endpoint but another one does.
          // Neither attribution is trustworthy, so the call is reported as unresolved.
          if (operations.length > 0 || !elsewhere) chosen = { provider: target, operations };
        }
      } else if (providers.length === 1) {
        chosen = providers[0];
      } else if (providers.length > 1) {
        // Several repositories serve it: the consumer's manifest may list it for exactly one.
        const declaredFor = providers.filter((x) =>
          consumer.declared.some(
            (d) =>
              d.targetKey === x.provider.key &&
              d.endpoints.some(
                (ep) =>
                  httpMethodsMatch(call.method, ep.method) && httpPathsMatch(call.path, ep.path),
              ),
          ),
        );
        if (declaredFor.length === 1) {
          chosen = declaredFor[0];
          byManifest = true;
        }
      }

      if (!chosen) {
        unresolved.set(consumer.key, (unresolved.get(consumer.key) ?? 0) + 1);
        continue;
      }
      const link = linkFor(consumer, chosen.provider.key);
      if (envDecl) link.declaredEnvUsed = true;
      addEndpoint(link, call, chosen.operations, byManifest);
    }

    // Declarations with no matching code still count as (low-confidence) declared links.
    for (const decl of consumer.declared) {
      if (decl.targetKey === consumer.key || !byKey.has(decl.targetKey)) continue;
      linkFor(consumer, decl.targetKey);
    }
  }

  const result: HttpDependencyLink[] = [];
  for (const link of links.values()) {
    // Confidence comes from evidence quality only; a manifest never raises it by itself.
    const matched = link.endpoints.filter((e) => e.operation && !e.generic);
    link.corroborated = matched.length > 0;
    if (matched.some(isStrong)) link.confidence = 'high';
    else if (link.corroborated) link.confidence = 'medium';
    else if (link.declared && link.declaredEnvUsed) link.confidence = 'medium';
    else if (link.declared) link.confidence = 'low';
    else continue; // only generic endpoints (e.g. /health) — not proof of a dependency
    // Keep endpoints that carry evidence: provider-matched, or called via the declared base URL.
    link.endpoints = link.endpoints.filter((e) => e.operation || link.declaredEnvUsed);
    result.push(link);
  }
  return { links: result, unresolved };
}
