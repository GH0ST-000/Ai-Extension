import type { ProjectMemoryCandidate, ProjectMemoryEvidence } from '@project-x/types';
import {
  PROJECT_MEMORY_MAX_LEARN_BYTES,
  PROJECT_MEMORY_MAX_LEARN_FILES,
  ProjectMemoryCategory,
} from '@project-x/types';

import { evaluateCandidateRecommendation } from './policy';
import { containsSensitiveMemoryContent } from './secrets';

export type ExtractConfigFile = {
  path: string;
  content: string;
};

const ENV_PATH_RE = /(?:^|\/)\.env(?:\..+)?$/i;
const MAX_FILE_CHARS = 48_000;

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? path;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function boundContent(content: string): string {
  if (content.length <= MAX_FILE_CHARS) return content;
  return content.slice(0, MAX_FILE_CHARS);
}

function isBlockedPath(path: string): boolean {
  const normalized = normalizePath(path);
  if (ENV_PATH_RE.test(normalized)) return true;
  if (/(^|\/)secrets?\//i.test(normalized)) return true;
  if (/\.(pem|key|p12|pfx)$/i.test(normalized)) return true;
  return false;
}

function parseJsonSafe(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function depsOf(pkg: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const block = pkg[field];
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      for (const [k, v] of Object.entries(block as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
    }
  }
  return out;
}

function makeCandidate(input: {
  id: string;
  category: ProjectMemoryCandidate['category'];
  key: string;
  summary: string;
  details?: Record<string, unknown>;
  evidence: ProjectMemoryEvidence[];
  confidence: ProjectMemoryCandidate['confidence'];
  aiInferred?: boolean;
}): ProjectMemoryCandidate {
  const proposedValue = {
    summary: input.summary,
    ...(input.details ? { details: input.details } : {}),
  };
  const recommendation = evaluateCandidateRecommendation({
    category: input.category,
    key: input.key,
    proposedValue,
    confidence: input.confidence,
    evidence: input.evidence,
    provenanceType: 'repository_observation',
    aiInferred: input.aiInferred,
  });

  return {
    id: input.id,
    category: input.category,
    key: input.key,
    proposedValue,
    evidence: input.evidence,
    confidence: input.confidence,
    recommendation,
    reason:
      recommendation === 'auto_accept'
        ? 'Deterministic repository configuration fact.'
        : recommendation === 'ask_user'
          ? 'Needs user confirmation before durable storage.'
          : 'Not safe or strong enough to store automatically.',
    scope: { type: 'repository' },
  };
}

/**
 * Extract safe deterministic facts from bounded config files.
 * Never returns secrets; never includes .env content.
 */
export function extractDeterministicFactsFromConfigs(
  files: ExtractConfigFile[],
): ProjectMemoryCandidate[] {
  const candidates: ProjectMemoryCandidate[] = [];
  let totalBytes = 0;
  const accepted: ExtractConfigFile[] = [];

  for (const file of files.slice(0, PROJECT_MEMORY_MAX_LEARN_FILES)) {
    if (isBlockedPath(file.path)) continue;
    const content = boundContent(file.content ?? '');
    if (containsSensitiveMemoryContent(content)) continue;
    const bytes =
      typeof TextEncoder !== 'undefined'
        ? new TextEncoder().encode(content).byteLength
        : content.length;
    if (totalBytes + bytes > PROJECT_MEMORY_MAX_LEARN_BYTES) break;
    totalBytes += bytes;
    accepted.push({ path: normalizePath(file.path), content });
  }

  const byBase = new Map(accepted.map((f) => [basename(f.path), f]));
  const packageJson = byBase.get('package.json');
  const pkg = packageJson ? parseJsonSafe(packageJson.content) : null;
  const deps = pkg ? depsOf(pkg) : {};

  // Package manager
  let packageManager: string | undefined;
  if (pkg && typeof pkg.packageManager === 'string') {
    const pm = pkg.packageManager.split('@')[0]?.toLowerCase();
    if (pm === 'pnpm' || pm === 'npm' || pm === 'yarn') packageManager = pm;
  }
  if (!packageManager) {
    if (byBase.has('pnpm-lock.yaml') || byBase.has('pnpm-workspace.yaml')) {
      packageManager = 'pnpm';
    } else if (byBase.has('yarn.lock')) {
      packageManager = 'yarn';
    } else if (byBase.has('package-lock.json')) {
      packageManager = 'npm';
    }
  }
  if (packageManager) {
    const evidencePath =
      packageJson?.path ??
      byBase.get('pnpm-lock.yaml')?.path ??
      byBase.get('yarn.lock')?.path ??
      byBase.get('package-lock.json')?.path ??
      'package.json';
    candidates.push(
      makeCandidate({
        id: 'cand-package-manager',
        category: ProjectMemoryCategory.DEPENDENCY_CONVENTION,
        key: 'tooling.package_manager',
        summary: `Package manager is ${packageManager}.`,
        details: { packageManager },
        evidence: [{ filePath: evidencePath, summary: `Detected ${packageManager}` }],
        confidence: 'high',
      }),
    );
  }

  // Monorepo
  if (byBase.has('pnpm-workspace.yaml') || byBase.has('turbo.json')) {
    const evidence: ProjectMemoryEvidence[] = [];
    const ws = byBase.get('pnpm-workspace.yaml');
    const turbo = byBase.get('turbo.json');
    if (ws) evidence.push({ filePath: ws.path, summary: 'pnpm workspace present' });
    if (turbo) evidence.push({ filePath: turbo.path, summary: 'turbo.json present' });
    candidates.push(
      makeCandidate({
        id: 'cand-monorepo',
        category: ProjectMemoryCategory.ARCHITECTURE,
        key: 'tooling.monorepo',
        summary: 'Repository is a monorepo.',
        details: {
          pnpmWorkspace: Boolean(ws),
          turbo: Boolean(turbo),
        },
        evidence,
        confidence: 'high',
      }),
    );
  }

  // Frameworks
  if (deps['@nestjs/core'] || deps['@nestjs/common']) {
    candidates.push(
      makeCandidate({
        id: 'cand-framework-nestjs',
        category: ProjectMemoryCategory.FRAMEWORK,
        key: 'framework.nestjs',
        summary: 'Uses NestJS.',
        details: { framework: 'nestjs' },
        evidence: [
          {
            filePath: packageJson?.path ?? 'package.json',
            summary: 'NestJS dependency present',
          },
        ],
        confidence: 'high',
      }),
    );
  }
  if (deps.next) {
    candidates.push(
      makeCandidate({
        id: 'cand-framework-next',
        category: ProjectMemoryCategory.FRAMEWORK,
        key: 'framework.next',
        summary: 'Uses Next.js.',
        details: { framework: 'next' },
        evidence: [
          { filePath: packageJson?.path ?? 'package.json', summary: 'next dependency present' },
        ],
        confidence: 'high',
      }),
    );
  }
  if (deps.react) {
    candidates.push(
      makeCandidate({
        id: 'cand-framework-react',
        category: ProjectMemoryCategory.FRAMEWORK,
        key: 'framework.react',
        summary: 'Uses React.',
        details: { framework: 'react' },
        evidence: [
          { filePath: packageJson?.path ?? 'package.json', summary: 'react dependency present' },
        ],
        confidence: 'high',
      }),
    );
  }

  // Test framework
  if (deps.vitest || byBase.has('vitest.config.ts') || byBase.has('vitest.config.js')) {
    const evidencePath =
      byBase.get('vitest.config.ts')?.path ??
      byBase.get('vitest.config.js')?.path ??
      packageJson?.path ??
      'package.json';
    candidates.push(
      makeCandidate({
        id: 'cand-testing-vitest',
        category: ProjectMemoryCategory.TESTING_CONVENTION,
        key: 'testing.framework',
        summary: 'Tests use Vitest.',
        details: { framework: 'vitest' },
        evidence: [{ filePath: evidencePath, summary: 'Vitest configured' }],
        confidence: 'high',
      }),
    );
  } else if (deps.jest || byBase.has('jest.config.js') || byBase.has('jest.config.ts')) {
    const evidencePath =
      byBase.get('jest.config.ts')?.path ??
      byBase.get('jest.config.js')?.path ??
      packageJson?.path ??
      'package.json';
    candidates.push(
      makeCandidate({
        id: 'cand-testing-jest',
        category: ProjectMemoryCategory.TESTING_CONVENTION,
        key: 'testing.framework',
        summary: 'Tests use Jest.',
        details: { framework: 'jest' },
        evidence: [{ filePath: evidencePath, summary: 'Jest configured' }],
        confidence: 'high',
      }),
    );
  }

  // TypeScript strict
  const tsconfigs = accepted.filter((f) => /^tsconfig.*\.json$/i.test(basename(f.path)));
  for (const ts of tsconfigs) {
    const json = parseJsonSafe(ts.content);
    const compilerOptions = json?.compilerOptions;
    if (
      compilerOptions &&
      typeof compilerOptions === 'object' &&
      !Array.isArray(compilerOptions) &&
      (compilerOptions as Record<string, unknown>).strict === true
    ) {
      candidates.push(
        makeCandidate({
          id: 'cand-ts-strict',
          category: ProjectMemoryCategory.CODE_CONVENTION,
          key: 'tooling.typescript_strict',
          summary: 'TypeScript strict mode is enabled.',
          details: { strict: true },
          evidence: [{ filePath: ts.path, summary: 'compilerOptions.strict = true' }],
          confidence: 'high',
        }),
      );
      break;
    }
  }

  // ESLint / Prettier
  const hasEslint =
    Boolean(deps.eslint) ||
    accepted.some((f) => /eslint/i.test(basename(f.path))) ||
    Boolean(pkg?.eslintConfig);
  if (hasEslint) {
    candidates.push(
      makeCandidate({
        id: 'cand-eslint',
        category: ProjectMemoryCategory.CODE_CONVENTION,
        key: 'tooling.eslint',
        summary: 'ESLint is present.',
        details: { eslint: true },
        evidence: [
          {
            filePath: packageJson?.path ?? accepted.find((f) => /eslint/i.test(f.path))?.path,
            summary: 'ESLint tooling detected',
          },
        ],
        confidence: 'high',
      }),
    );
  }

  const hasPrettier =
    Boolean(deps.prettier) ||
    accepted.some((f) => /prettier/i.test(basename(f.path))) ||
    Boolean(pkg?.prettier);
  if (hasPrettier) {
    candidates.push(
      makeCandidate({
        id: 'cand-prettier',
        category: ProjectMemoryCategory.CODE_CONVENTION,
        key: 'tooling.prettier',
        summary: 'Prettier is present.',
        details: { prettier: true },
        evidence: [
          {
            filePath: packageJson?.path ?? accepted.find((f) => /prettier/i.test(f.path))?.path,
            summary: 'Prettier tooling detected',
          },
        ],
        confidence: 'high',
      }),
    );
  }

  // Prisma
  if (
    deps.prisma ||
    deps['@prisma/client'] ||
    accepted.some((f) => /schema\.prisma$/i.test(f.path))
  ) {
    const evidencePath =
      accepted.find((f) => /schema\.prisma$/i.test(f.path))?.path ??
      packageJson?.path ??
      'package.json';
    candidates.push(
      makeCandidate({
        id: 'cand-prisma',
        category: ProjectMemoryCategory.DATABASE_CONVENTION,
        key: 'database.prisma',
        summary: 'Uses Prisma.',
        details: { orm: 'prisma' },
        evidence: [{ filePath: evidencePath, summary: 'Prisma detected' }],
        confidence: 'high',
      }),
    );
  }

  // CQRS dependency (deterministic) + architectural pattern (ask_user if enough handlers)
  if (deps['@nestjs/cqrs']) {
    candidates.push(
      makeCandidate({
        id: 'cand-nestjs-cqrs-dep',
        category: ProjectMemoryCategory.DEPENDENCY_CONVENTION,
        key: 'dependency.nestjs_cqrs',
        summary: 'Depends on @nestjs/cqrs.',
        details: { package: '@nestjs/cqrs' },
        evidence: [
          {
            filePath: packageJson?.path ?? 'package.json',
            summary: '@nestjs/cqrs dependency present',
          },
        ],
        confidence: 'high',
      }),
    );

    const handlerPaths = accepted.filter(
      (f) =>
        /\.(command|query)-handler\.(ts|js)$/i.test(f.path) ||
        /handlers?\/.+\.(ts|js)$/i.test(f.path),
    );
    if (handlerPaths.length >= 3) {
      candidates.push(
        makeCandidate({
          id: 'cand-architecture-cqrs',
          category: ProjectMemoryCategory.ARCHITECTURE,
          key: 'architecture.pattern.cqrs',
          summary: 'Write operations appear to use NestJS CQRS handlers.',
          details: { pattern: 'cqrs', handlerCount: handlerPaths.length },
          evidence: handlerPaths.slice(0, 5).map((f) => ({
            filePath: f.path,
            summary: 'Handler-like path',
          })),
          confidence: 'high',
          aiInferred: false,
        }),
      );
      // Force ask_user for architectural CQRS pattern even with strong path evidence
      const last = candidates[candidates.length - 1];
      if (last) {
        last.recommendation = 'ask_user';
        last.reason = 'Architectural CQRS pattern requires user confirmation.';
      }
    }
  }

  // Drop any candidate that somehow included sensitive content
  return candidates.filter((c) => {
    const blob = `${c.proposedValue.summary}\n${JSON.stringify(c.proposedValue.details ?? {})}`;
    return !containsSensitiveMemoryContent(blob);
  });
}
