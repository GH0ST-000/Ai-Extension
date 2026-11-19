import { MULTI_REPO_MAX_MANIFEST_BYTES } from '@project-x/types';

import { parseEndpointSpec, type HttpMethodName } from './http-paths';
import { parseOwnerRepo, type OwnerRepo } from './identity';

/**
 * `service-dependencies.json` — a repository's own declaration of the services it calls.
 * A declaration is a claim by the repository author, not proof: callers must still require
 * the target to be an enabled, accessible repository of the same system, and should report
 * declared-only dependencies separately from ones corroborated by code or OpenAPI.
 *
 * {
 *   "service": "project-x-test-client",
 *   "dependencies": [{
 *     "service": "project-x-test-api",
 *     "type": "http",
 *     "repository": "https://github.com/gh0st-000/project-x-test-api",
 *     "baseUrlEnv": "USER_API_BASE_URL",
 *     "endpoints": ["GET /health", "GET /api/users", "GET /api/users/{id}"]
 *   }]
 * }
 */

export const SERVICE_MANIFEST_PATH = 'service-dependencies.json';
const MAX_DEPENDENCIES = 25;
const MAX_ENDPOINTS = 50;
const MAX_STRING = 200;
const DEPENDENCY_TYPES = ['http', 'event', 'package', 'unknown'] as const;
type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export interface ManifestDependency {
  type: DependencyType;
  /** Normalized GitHub repository when one was given (github.com URL or owner/repo). */
  repository?: OwnerRepo;
  /** Service name, used to find a system repository when no repository is given. */
  service?: string;
  baseUrlEnv?: string;
  endpoints: Array<{ method?: HttpMethodName; path: string }>;
}

export type ManifestParseResult =
  | { ok: true; service?: string; dependencies: ManifestDependency[]; issues: string[] }
  | { ok: false; error: string };

const isString = (v: unknown, max = MAX_STRING): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function parseServiceDependencyManifest(raw: string): ManifestParseResult {
  if (typeof raw !== 'string') return { ok: false, error: 'not_text' };
  if (raw.length > MULTI_REPO_MAX_MANIFEST_BYTES) return { ok: false, error: 'too_large' };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: 'not_an_object' };
  }
  const record = doc as Record<string, unknown>;
  if (!Array.isArray(record.dependencies)) return { ok: false, error: 'missing_dependencies' };

  const issues: string[] = [];
  const byKey = new Map<string, ManifestDependency>();
  if (record.dependencies.length > MAX_DEPENDENCIES) issues.push('too_many_dependencies');

  record.dependencies.slice(0, MAX_DEPENDENCIES).forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push(`dependency_${index}_invalid`);
      return;
    }
    const dep = entry as Record<string, unknown>;
    const type: DependencyType = (DEPENDENCY_TYPES as readonly string[]).includes(String(dep.type))
      ? (dep.type as DependencyType)
      : 'unknown';
    let repository: OwnerRepo | undefined;
    if (dep.repository !== undefined) {
      const parsed = isString(dep.repository, 300) ? parseOwnerRepo(dep.repository) : null;
      // Only github.com URLs or owner/repo; any other host is not a repository reference.
      const otherHost =
        isString(dep.repository, 300) &&
        /^[a-z]+:\/\//i.test(dep.repository) &&
        !/^https?:\/\/(www\.)?github\.com\//i.test(dep.repository);
      if (!parsed || otherHost) {
        issues.push(`dependency_${index}_repository_invalid`);
        return;
      }
      repository = parsed;
    }
    const service = isString(dep.service) ? dep.service.trim() : undefined;
    if (!repository && !service) {
      issues.push(`dependency_${index}_target_missing`);
      return;
    }
    const baseUrlEnv =
      isString(dep.baseUrlEnv, 64) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(dep.baseUrlEnv)
        ? dep.baseUrlEnv
        : undefined;
    if (dep.baseUrlEnv !== undefined && !baseUrlEnv) issues.push(`dependency_${index}_env_invalid`);

    const endpoints: ManifestDependency['endpoints'] = [];
    if (Array.isArray(dep.endpoints)) {
      for (const spec of dep.endpoints.slice(0, MAX_ENDPOINTS)) {
        const parsed = parseEndpointSpec(spec);
        if (!parsed) {
          issues.push(`dependency_${index}_endpoint_invalid`);
          continue;
        }
        if (!endpoints.some((e) => e.method === parsed.method && e.path === parsed.path)) {
          endpoints.push(parsed);
        }
      }
    }

    const key = repository
      ? `repo:${repository.owner}/${repository.repository}`
      : `service:${service!.toLowerCase()}`;
    const existing = byKey.get(key);
    if (existing) {
      // Duplicate declaration of the same target: merge endpoints, keep the first settings.
      issues.push(`dependency_${index}_duplicate`);
      for (const e of endpoints) {
        if (!existing.endpoints.some((x) => x.method === e.method && x.path === e.path)) {
          existing.endpoints.push(e);
        }
      }
      existing.baseUrlEnv ??= baseUrlEnv;
      return;
    }
    byKey.set(key, {
      type,
      ...(repository ? { repository } : {}),
      ...(service ? { service } : {}),
      ...(baseUrlEnv ? { baseUrlEnv } : {}),
      endpoints,
    });
  });

  return {
    ok: true,
    ...(isString(record.service) ? { service: record.service.trim() } : {}),
    dependencies: [...byKey.values()],
    issues,
  };
}
