/**
 * Detect OpenAPI/Swagger spec paths changed on a GitHub PR (Day 18).
 * Matches well-known filenames and *openapi* / *swagger* with json|yaml|yml.
 */
export function isOpenApiSpecPath(path: string): boolean {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) {
    return false;
  }
  const base = normalized.split('/').pop()?.toLowerCase() ?? '';
  if (
    base === 'openapi.json' ||
    base === 'openapi.yaml' ||
    base === 'openapi.yml' ||
    base === 'swagger.json' ||
    base === 'swagger.yaml' ||
    base === 'swagger.yml'
  ) {
    return true;
  }
  return /(?:^|\/)[^/]*(openapi|swagger)[^/]*\.(json|ya?ml)$/i.test(normalized);
}

export function filterOpenApiSpecPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!isOpenApiSpecPath(path)) {
      continue;
    }
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    out.push(path);
  }
  return out;
}
