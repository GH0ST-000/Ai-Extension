import type {
  ProjectConstraintContext,
  ProjectMemoryCandidateRecommendation,
  ProjectMemoryCategory,
  ProjectMemoryConfidence,
  ProjectMemoryEvidence,
  ProjectMemoryProvenanceType,
  ProjectMemoryValue,
} from '@project-x/types';

import { containsSensitiveMemoryContent } from './secrets';

const UNSAFE_RULE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bskip\s+confirmation\b|\bno[_ ]?confirmation\b|\bwithout\s+confirmation\b|\bauto(?:matically)?\s+confirm\b/i,
  /\bauto(?:matically)?\s+merge\b|\balways\s+approve\s+pr\b|\balways\s+merge\b/i,
  /\bshell\b|\bterminal\b|\brm\s+-rf\b|\bexec(?:ute)?\s+command\b/i,
  /\bsend\s+(?:credentials|secrets?|tokens?|api[_ -]?keys?)\b/i,
  /\bexfiltrat/i,
  /\b(?:post|send|upload|curl|wget)\b.{0,80}\bhttps?:\/\//i,
  /\bwebhook\b.{0,40}\bhttps?:\/\//i,
];

const DETERMINISTIC_AUTO_ACCEPT_KEYS = new Set([
  'tooling.package_manager',
  'tooling.monorepo',
  'framework.nestjs',
  'framework.next',
  'framework.react',
  'testing.framework',
  'tooling.typescript_strict',
  'tooling.eslint',
  'tooling.prettier',
  'database.prisma',
  'dependency.nestjs_cqrs',
]);

export type EvaluateCandidateInput = {
  category: ProjectMemoryCategory;
  key: string;
  proposedValue: ProjectMemoryValue;
  confidence: ProjectMemoryConfidence;
  evidence?: ProjectMemoryEvidence[];
  provenanceType?: ProjectMemoryProvenanceType;
  /** When true, treat as weak AI inference regardless of confidence claim. */
  aiInferred?: boolean;
};

export function isUnsafeMemoryRuleText(text: string): boolean {
  if (!text.trim()) return false;
  if (containsSensitiveMemoryContent(text)) return true;
  return UNSAFE_RULE_PATTERNS.some((pattern) => pattern.test(text));
}

export function canAutoAcceptDeterministicFact(
  category: ProjectMemoryCategory,
  key: string,
): boolean {
  if (DETERMINISTIC_AUTO_ACCEPT_KEYS.has(key)) return true;
  if (category === 'FRAMEWORK' && key.startsWith('framework.')) return true;
  if (category === 'TESTING_CONVENTION' && key === 'testing.framework') return true;
  if (category === 'DEPENDENCY_CONVENTION' && key.startsWith('dependency.')) return true;
  if (category === 'ARCHITECTURE' && key === 'architecture.pattern.cqrs') return false;
  return false;
}

export function userExplicitMayStore(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (containsSensitiveMemoryContent(trimmed)) return false;
  if (isUnsafeMemoryRuleText(trimmed)) return false;
  return true;
}

export function evaluateCandidateRecommendation(
  candidate: EvaluateCandidateInput,
): ProjectMemoryCandidateRecommendation {
  const summary = candidate.proposedValue.summary ?? '';
  const detailsText = candidate.proposedValue.details
    ? JSON.stringify(candidate.proposedValue.details)
    : '';
  const combined = `${summary}\n${detailsText}`;

  if (containsSensitiveMemoryContent(combined) || isUnsafeMemoryRuleText(combined)) {
    return 'do_not_store';
  }

  if (candidate.provenanceType === 'user_explicit') {
    return userExplicitMayStore(summary) ? 'auto_accept' : 'do_not_store';
  }

  if (candidate.aiInferred) {
    return candidate.confidence === 'high' && (candidate.evidence?.length ?? 0) >= 3
      ? 'ask_user'
      : 'do_not_store';
  }

  if (
    canAutoAcceptDeterministicFact(candidate.category, candidate.key) &&
    candidate.confidence === 'high'
  ) {
    return 'auto_accept';
  }

  if (candidate.confidence === 'high' && (candidate.evidence?.length ?? 0) >= 2) {
    return 'ask_user';
  }

  if (candidate.confidence === 'medium' && (candidate.evidence?.length ?? 0) >= 3) {
    return 'ask_user';
  }

  return 'do_not_store';
}

/**
 * Intersection only — project constraints may further restrict, never expand.
 */
export function effectiveCapabilitiesWithProjectConstraints(
  globalAllowed: string[],
  project: ProjectConstraintContext,
): string[] {
  const allowed = new Set(globalAllowed);
  let result = [...allowed];

  if (project.noNewDependencies) {
    result = result.filter(
      (cap) => !/INSTALL_DEPENDENCY|ADD_DEPENDENCY|NPM_INSTALL|PNPM_ADD|YARN_ADD/i.test(cap),
    );
  }

  return result.filter((cap) => allowed.has(cap));
}

/**
 * Returns true when project rules do not attempt to enable anything in `forbidden`.
 * Project rules are descriptive constraints — they must never expand the allowlist.
 */
export function projectRulesCannotEnableForbidden(
  forbidden: string[],
  projectRules: { key: string; text: string }[],
): boolean {
  if (forbidden.length === 0) return true;
  const forbiddenLower = forbidden.map((f) => f.toLowerCase());

  for (const rule of projectRules) {
    const text = `${rule.key} ${rule.text}`.toLowerCase();
    for (const item of forbiddenLower) {
      // Rules that explicitly try to enable a forbidden capability are unsafe.
      if (
        new RegExp(
          `\\b(?:allow|enable|permit|always)\\b.{0,40}\\b${escapeRegExp(item)}\\b`,
          'i',
        ).test(text)
      ) {
        return false;
      }
    }
  }
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
