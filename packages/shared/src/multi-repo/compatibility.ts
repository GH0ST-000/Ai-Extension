import type {
  CompatibilityReason,
  CrossRepoCompatibilityResult,
  MultiRepoEvidence,
  RelationshipConfidence,
} from '@project-x/types';

function result(
  status: CrossRepoCompatibilityResult['status'],
  reasons: CompatibilityReason[],
  evidence: MultiRepoEvidence[],
  confidence: RelationshipConfidence,
): CrossRepoCompatibilityResult {
  return { status, reasons, evidence, confidence };
}

/**
 * Compare required request fields: fields present in `after` but not `before`
 * are treated as newly required — potentially breaking for known callers.
 */
export function compareHttpRequiredFieldsAdded(
  beforeRequired: string[],
  afterRequired: string[],
  evidence: MultiRepoEvidence[] = [],
): CrossRepoCompatibilityResult {
  const before = new Set(beforeRequired.map((f) => f.trim()).filter(Boolean));
  const added = afterRequired.map((f) => f.trim()).filter((f) => f && !before.has(f));

  if (added.length === 0) {
    return result(
      'compatible',
      [{ code: 'NO_REQUIRED_FIELD_ADDED', summary: 'No new required request fields detected.' }],
      evidence,
      'high',
    );
  }

  return result(
    'potentially_breaking',
    added.map((field) => ({
      code: 'REQUIRED_FIELD_ADDED',
      summary: `Required request field "${field}" was added.`,
      field,
    })),
    evidence,
    'high',
  );
}

/** Topic rename is breaking for known consumers of the previous topic. */
export function compareTopicRename(
  beforeTopic: string,
  afterTopic: string,
  evidence: MultiRepoEvidence[] = [],
): CrossRepoCompatibilityResult {
  const before = beforeTopic.trim();
  const after = afterTopic.trim();

  if (!before || !after) {
    return result(
      'uncertain',
      [{ code: 'TOPIC_COMPARE_INCOMPLETE', summary: 'Topic rename comparison is incomplete.' }],
      evidence,
      'low',
    );
  }

  if (before === after) {
    return result(
      'compatible',
      [{ code: 'TOPIC_UNCHANGED', summary: `Topic "${before}" is unchanged.` }],
      evidence,
      'high',
    );
  }

  return result(
    'breaking_evidence',
    [
      {
        code: 'TOPIC_RENAMED',
        summary: `Kafka topic renamed from "${before}" to "${after}".`,
        field: after,
      },
    ],
    evidence,
    'high',
  );
}

export function mergeCompatibilityResults(
  results: CrossRepoCompatibilityResult[],
): CrossRepoCompatibilityResult {
  if (results.length === 0) {
    return result(
      'uncertain',
      [{ code: 'NO_COMPARISON', summary: 'No compatibility comparisons were provided.' }],
      [],
      'low',
    );
  }

  const rank: Record<CrossRepoCompatibilityResult['status'], number> = {
    compatible: 0,
    uncertain: 1,
    potentially_breaking: 2,
    breaking_evidence: 3,
  };

  let status: CrossRepoCompatibilityResult['status'] = 'compatible';
  const reasons: CompatibilityReason[] = [];
  const evidence: MultiRepoEvidence[] = [];
  let confidence: RelationshipConfidence = 'high';

  for (const item of results) {
    if (rank[item.status] > rank[status]) {
      status = item.status;
    }
    reasons.push(...item.reasons);
    evidence.push(...item.evidence);
    if (item.confidence === 'low') confidence = 'low';
    else if (item.confidence === 'medium' && confidence === 'high') confidence = 'medium';
  }

  return result(status, reasons, evidence, confidence);
}
