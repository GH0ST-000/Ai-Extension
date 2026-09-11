import type { AcceptanceCriterion, EngineeringFileRelevance } from '@project-x/types';

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'is',
  'are',
  'be',
  'as',
  'by',
  'at',
  'from',
  'that',
  'this',
  'it',
  'if',
  'when',
  'must',
  'should',
  'shall',
  'will',
  'can',
  'not',
  'no',
  'any',
  'all',
]);

/** Deterministic token set from free text (lowercased alphanumerics + path segments). */
export function tokenizeForRelevance(text: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = text.toLowerCase().replace(/[/_.-]+/g, ' ');
  for (const raw of normalized.split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 2 || STOP_WORDS.has(raw)) {
      continue;
    }
    tokens.add(raw);
  }
  return tokens;
}

export function scoreFileRelevance(
  filePath: string,
  criteriaTokens: Set<string>,
  apiPathTokens: Set<string>,
): { score: number; relevance: EngineeringFileRelevance } {
  const pathTokens = tokenizeForRelevance(filePath);
  let score = 0;
  for (const token of pathTokens) {
    if (criteriaTokens.has(token)) {
      score += 3;
    }
    if (apiPathTokens.has(token)) {
      score += 4;
    }
  }

  // Mild boost for common implementation dirs when any overlap exists
  if (score > 0 && /(service|controller|handler|route|api|schema)/i.test(filePath)) {
    score += 1;
  }

  let relevance: EngineeringFileRelevance;
  if (score >= 6) {
    relevance = 'high';
  } else if (score >= 2) {
    relevance = 'medium';
  } else {
    relevance = 'low';
  }

  return { score, relevance };
}

export function buildCriteriaTokenSet(criteria: AcceptanceCriterion[]): Set<string> {
  const tokens = new Set<string>();
  for (const c of criteria) {
    for (const t of tokenizeForRelevance(c.text)) {
      tokens.add(t);
    }
  }
  return tokens;
}

export function buildApiPathTokenSet(apiPath?: string, operationId?: string): Set<string> {
  const tokens = new Set<string>();
  if (apiPath) {
    for (const t of tokenizeForRelevance(apiPath)) {
      tokens.add(t);
    }
  }
  if (operationId) {
    for (const t of tokenizeForRelevance(operationId)) {
      tokens.add(t);
    }
  }
  return tokens;
}
