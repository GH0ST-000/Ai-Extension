import { parseOwnerRepo } from './identity';

export interface ParsedPackageDependency {
  name: string;
  versionRange: string;
  kind: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';
}

export interface ParsedPackageRepositoryField {
  type?: string;
  url?: string;
  owner?: string;
  repository?: string;
}

export interface ParsedPackageJson {
  name?: string;
  dependencies: ParsedPackageDependency[];
  repository?: ParsedPackageRepositoryField;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseDependencyMap(
  value: unknown,
  kind: ParsedPackageDependency['kind'],
): ParsedPackageDependency[] {
  const record = asRecord(value);
  if (!record) return [];
  const out: ParsedPackageDependency[] = [];
  for (const [name, versionRange] of Object.entries(record)) {
    if (typeof name !== 'string' || !name.trim()) continue;
    if (typeof versionRange !== 'string') continue;
    out.push({ name: name.trim(), versionRange: versionRange.trim(), kind });
  }
  return out;
}

function parseRepositoryField(value: unknown): ParsedPackageRepositoryField | undefined {
  if (typeof value === 'string' && value.trim()) {
    const url = value.trim();
    const parsed = parseOwnerRepo(url);
    return parsed ? { url, owner: parsed.owner, repository: parsed.repository } : { url };
  }

  const record = asRecord(value);
  if (!record) return undefined;

  const type = typeof record.type === 'string' ? record.type : undefined;
  const url = typeof record.url === 'string' ? record.url.trim() : undefined;
  if (!url && !type) return undefined;

  const parsed = url ? parseOwnerRepo(url) : null;
  return {
    type,
    url,
    owner: parsed?.owner,
    repository: parsed?.repository,
  };
}

/**
 * Parse package.json dependencies and optional repository field.
 * Does not invent GitHub mappings from package names alone.
 */
export function parsePackageJsonManifest(raw: string): ParsedPackageJson | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  if (!record) return null;

  const dependencies = [
    ...parseDependencyMap(record.dependencies, 'dependencies'),
    ...parseDependencyMap(record.devDependencies, 'devDependencies'),
    ...parseDependencyMap(record.peerDependencies, 'peerDependencies'),
    ...parseDependencyMap(record.optionalDependencies, 'optionalDependencies'),
  ];

  const name = typeof record.name === 'string' ? record.name.trim() : undefined;
  const repository = parseRepositoryField(record.repository);

  return {
    name: name || undefined,
    dependencies,
    repository,
  };
}

export function findDependencyByName(
  manifest: ParsedPackageJson,
  packageName: string,
): ParsedPackageDependency | undefined {
  const target = packageName.trim().toLowerCase();
  return manifest.dependencies.find((d) => d.name.toLowerCase() === target);
}
