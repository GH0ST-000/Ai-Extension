import type {
  WorkflowConditionType,
  WorkflowFact,
  WorkflowFactName,
  WorkflowFactValue,
} from '@project-x/types';

export const WORKFLOW_FACT_NAMES = [
  'HAS_BLOCKING_FINDINGS',
  'HAS_HIGH_FINDINGS',
  'CRITICAL_FINDING_COUNT',
  'HIGH_FINDING_COUNT',
  'PATCH_PREPARED',
  'PATCH_APPLIED',
  'CI_TARGET_PASSED',
  'CI_TARGET_FAILED',
  'CI_DIFFERENT_FAILURE',
  'REVIEW_DRAFT_READY',
  'CONTEXT_PARTIAL',
  'HAS_ENGINEERING_CONTEXT',
  'MULTI_REPO_IMPACT_FOUND',
  'HIGH_IMPACT_REPOSITORY_COUNT',
  'CROSS_REPO_CONTRACT_RISK',
  'KNOWN_API_CONSUMER_FOUND',
  'KNOWN_EVENT_CONSUMER_FOUND',
  'SYSTEM_FLOW_INCOMPLETE',
  'SYSTEM_CONTEXT_PARTIAL',
] as const satisfies ReadonlyArray<WorkflowFactName>;

const FACT_NAME_SET = new Set<string>(WORKFLOW_FACT_NAMES);

export function isKnownWorkflowFactName(name: string): name is WorkflowFactName {
  return FACT_NAME_SET.has(name);
}

export function createWorkflowFact(
  name: WorkflowFactName,
  value: WorkflowFactValue,
  sourceStepId?: string,
): WorkflowFact {
  return sourceStepId ? { name, value, sourceStepId } : { name, value };
}

export function upsertWorkflowFacts(
  existing: WorkflowFact[],
  next: WorkflowFact[],
): WorkflowFact[] {
  const byName = new Map<WorkflowFactName, WorkflowFact>();
  for (const fact of existing) {
    if (isKnownWorkflowFactName(fact.name)) {
      byName.set(fact.name, fact);
    }
  }
  for (const fact of next) {
    if (!isKnownWorkflowFactName(fact.name)) {
      continue;
    }
    byName.set(fact.name, fact);
  }
  return [...byName.values()];
}

/** Reject AI-invented fact names — only allowlisted facts are kept. */
export function sanitizeWorkflowFacts(raw: unknown): WorkflowFact[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkflowFact[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = record.name;
    const value = record.value;
    if (typeof name !== 'string' || !isKnownWorkflowFactName(name)) continue;
    if (typeof value !== 'boolean' && typeof value !== 'number') continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    const sourceStepId =
      typeof record.sourceStepId === 'string' && record.sourceStepId.trim()
        ? record.sourceStepId.trim()
        : undefined;
    out.push(createWorkflowFact(name, value, sourceStepId));
  }
  return out;
}

export function getFactValue(
  facts: WorkflowFact[],
  name: WorkflowFactName,
): WorkflowFactValue | undefined {
  return facts.find((f) => f.name === name)?.value;
}

export function factAsBoolean(facts: WorkflowFact[], name: WorkflowFactName): boolean {
  const value = getFactValue(facts, name);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  return false;
}

/**
 * Map allowlisted condition types onto trusted facts.
 * Unknown / unmapped conditions fail closed (false).
 */
export function conditionTypeToFactName(type: WorkflowConditionType): WorkflowFactName | null {
  switch (type) {
    case 'ALWAYS':
      return null;
    case 'HAS_HIGH_FINDINGS':
      return 'HAS_HIGH_FINDINGS';
    case 'HAS_BLOCKING_FINDINGS':
      return 'HAS_BLOCKING_FINDINGS';
    case 'CI_TARGET_FAILED':
      return 'CI_TARGET_FAILED';
    case 'CI_TARGET_PASSED':
      return 'CI_TARGET_PASSED';
    case 'CI_DIFFERENT_FAILURE':
      return 'CI_DIFFERENT_FAILURE';
    case 'HAS_ENGINEERING_CONTEXT':
      return 'HAS_ENGINEERING_CONTEXT';
    case 'PATCH_PREPARED':
      return 'PATCH_PREPARED';
    case 'PATCH_APPLIED':
      return 'PATCH_APPLIED';
    case 'REVIEW_DRAFT_READY':
      return 'REVIEW_DRAFT_READY';
    case 'CONTEXT_PARTIAL':
      return 'CONTEXT_PARTIAL';
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}
