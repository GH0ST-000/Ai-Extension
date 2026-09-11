import type {
  AgentPlanConfidence,
  DeveloperAgentGoal,
  DeveloperWorkflowPlan,
  DeveloperWorkflowStep,
  WorkflowConditionType,
  WorkflowContextRequirement,
  WorkflowErrorCode,
  WorkflowPlanValidationResult,
  WorkflowStepCondition,
  WorkflowStepStatus,
  WorkflowStepType,
} from '@project-x/types';
import {
  WORKFLOW_MAX_GOAL_CHARS,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_MAX_WRITE_CHECKPOINTS,
  WorkflowStepType as Step,
} from '@project-x/types';

import { getCapability, isKnownWorkflowStepType } from './capabilities';
import {
  parseCompletionCriteria,
  validateCompletionCriteriaAgainstPlan,
  validatePlanAgainstGoalConstraints,
} from './goal-constraints';
import { normalizeStepSafety } from './policy';

export interface WorkflowAvailableContext {
  jira: boolean;
  github: boolean;
  api: boolean;
  ci: boolean;
}

export type ValidatePlanOptions = {
  goal?: DeveloperAgentGoal;
};

const CONTEXT_REQUIREMENTS = new Set<WorkflowContextRequirement>(['jira', 'github', 'api', 'ci']);

const CONDITION_TYPES = new Set<WorkflowConditionType>([
  'HAS_HIGH_FINDINGS',
  'HAS_BLOCKING_FINDINGS',
  'CI_TARGET_FAILED',
  'CI_TARGET_PASSED',
  'CI_DIFFERENT_FAILURE',
  'HAS_ENGINEERING_CONTEXT',
  'PATCH_PREPARED',
  'PATCH_APPLIED',
  'REVIEW_DRAFT_READY',
  'CONTEXT_PARTIAL',
  'ALWAYS',
]);

const STEP_STATUSES = new Set<WorkflowStepStatus>([
  'PENDING',
  'READY',
  'RUNNING',
  'WAITING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
  'STALE',
  'CANCELLED',
]);

const PREPARATION_RULES: ReadonlyArray<{
  writeType: WorkflowStepType;
  requiredEarlier: WorkflowStepType;
}> = [
  { writeType: Step.APPLY_PATCH, requiredEarlier: Step.PREPARE_PATCH },
  { writeType: Step.SUBMIT_PR_REVIEW, requiredEarlier: Step.CREATE_REVIEW_DRAFT },
  { writeType: Step.SUBMIT_PR_COMMENT, requiredEarlier: Step.GENERATE_PR_COMMENT },
];

function fail(
  code: WorkflowErrorCode,
  message: string,
  details?: Record<string, unknown>,
): WorkflowPlanValidationResult {
  return details ? { ok: false, code, message, details } : { ok: false, code, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRaw(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  return raw;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) {
      out.push(item.trim());
    }
  }
  return out;
}

function asContextRequirements(value: unknown): WorkflowContextRequirement[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: WorkflowContextRequirement[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !CONTEXT_REQUIREMENTS.has(item as WorkflowContextRequirement)) {
      return null;
    }
    out.push(item as WorkflowContextRequirement);
  }
  return out;
}

function asCondition(value: unknown): WorkflowStepCondition | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) return null;
  const type = value.type;
  if (typeof type !== 'string' || !CONDITION_TYPES.has(type as WorkflowConditionType)) {
    return null;
  }
  const negate = value.negate === true ? true : undefined;
  return {
    type: type as WorkflowConditionType,
    ...(negate ? { negate: true } : {}),
  };
}

function asStepStatus(value: unknown): WorkflowStepStatus {
  if (typeof value === 'string' && STEP_STATUSES.has(value as WorkflowStepStatus)) {
    return value as WorkflowStepStatus;
  }
  return 'PENDING';
}

function asConfidence(value: unknown): AgentPlanConfidence | undefined {
  if (value === 'HIGH' || value === 'MEDIUM' || value === 'LOW') {
    return value;
  }
  return undefined;
}

function hasTypeInDependencyChain(
  stepId: string,
  requiredType: WorkflowStepType,
  byId: Map<string, DeveloperWorkflowStep>,
): boolean {
  const visited = new Set<string>();
  const stack = [...(byId.get(stepId)?.dependencies ?? [])];

  while (stack.length > 0) {
    const depId = stack.pop();
    if (!depId || visited.has(depId)) continue;
    visited.add(depId);
    const dep = byId.get(depId);
    if (!dep) continue;
    if (dep.type === requiredType) return true;
    stack.push(...dep.dependencies);
  }

  return false;
}

function detectCycle(steps: DeveloperWorkflowStep[]): string[] | null {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const dfs = (id: string): string[] | null => {
    if (visiting.has(id)) {
      const cycleStart = path.indexOf(id);
      return cycleStart >= 0 ? [...path.slice(cycleStart), id] : [id];
    }
    if (visited.has(id)) return null;

    visiting.add(id);
    path.push(id);
    const step = byId.get(id);
    if (step) {
      for (const dep of step.dependencies) {
        if (!byId.has(dep)) continue;
        const cycle = dfs(dep);
        if (cycle) return cycle;
      }
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  for (const step of steps) {
    const cycle = dfs(step.id);
    if (cycle) return cycle;
  }
  return null;
}

function maxDependencyDepth(steps: DeveloperWorkflowStep[]): number {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const memo = new Map<string, number>();

  const depthOf = (id: string, stack: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (stack.has(id)) return 0;
    stack.add(id);
    const step = byId.get(id);
    if (!step || step.dependencies.length === 0) {
      memo.set(id, 1);
      stack.delete(id);
      return 1;
    }
    let max = 0;
    for (const dep of step.dependencies) {
      max = Math.max(max, depthOf(dep, stack));
    }
    const depth = max + 1;
    memo.set(id, depth);
    stack.delete(id);
    return depth;
  };

  let max = 0;
  for (const step of steps) {
    max = Math.max(max, depthOf(step.id, new Set()));
  }
  return max;
}

function normalizeStep(
  raw: unknown,
  index: number,
): { step?: DeveloperWorkflowStep; error?: WorkflowPlanValidationResult } {
  if (!isPlainObject(raw)) {
    return {
      error: fail('WORKFLOW_PLAN_INVALID', `Step at index ${index} is not an object.`),
    };
  }

  const id = asNonEmptyString(raw.id);
  if (!id) {
    return {
      error: fail('WORKFLOW_PLAN_INVALID', `Step at index ${index} is missing a valid id.`),
    };
  }

  const typeRaw = asNonEmptyString(raw.type);
  if (!typeRaw) {
    return {
      error: fail('WORKFLOW_PLAN_INVALID', `Step "${id}" is missing a type.`),
    };
  }
  if (!isKnownWorkflowStepType(typeRaw)) {
    return {
      error: fail(
        'WORKFLOW_CAPABILITY_NOT_ALLOWED',
        `Step "${id}" uses disallowed capability "${typeRaw}".`,
        { type: typeRaw, stepId: id },
      ),
    };
  }

  const title = asNonEmptyString(raw.title) ?? getCapability(typeRaw).title;
  const description = asNonEmptyString(raw.description) ?? getCapability(typeRaw).description;
  const reason = asNonEmptyString(raw.reason) ?? undefined;
  const dependencies = asStringArray(raw.dependencies);
  const requiredContext = asContextRequirements(raw.requiredContext);
  if (requiredContext === null) {
    return {
      error: fail('WORKFLOW_PLAN_INVALID', `Step "${id}" has invalid requiredContext.`, {
        stepId: id,
      }),
    };
  }

  const condition = asCondition(raw.condition);
  if (condition === null) {
    return {
      error: fail('WORKFLOW_PLAN_INVALID', `Step "${id}" has an invalid condition.`, {
        stepId: id,
      }),
    };
  }

  const draft: DeveloperWorkflowStep = {
    id,
    type: typeRaw,
    title,
    description,
    dependencies,
    requiredContext,
    executionMode: 'AUTO_READ',
    mutationRisk: 'NONE',
    status: asStepStatus(raw.status),
    ...(condition ? { condition } : {}),
    ...(reason ? { reason: reason.slice(0, 240) } : {}),
  };

  return { step: normalizeStepSafety(draft) };
}

/**
 * Parse/normalize planner JSON into a safe DeveloperWorkflowPlan.
 * Strips unknown fields and forces safety metadata from the capability catalog.
 */
export function validateDeveloperWorkflowPlan(
  raw: unknown,
  availableContext: WorkflowAvailableContext,
  options?: ValidatePlanOptions,
): WorkflowPlanValidationResult {
  const parsed = parseRaw(raw);
  if (!isPlainObject(parsed)) {
    return fail('WORKFLOW_PLAN_INVALID', 'Workflow plan must be a JSON object.');
  }

  const id = asNonEmptyString(parsed.id);
  if (!id) {
    return fail('WORKFLOW_PLAN_INVALID', 'Workflow plan id is required.');
  }

  const goal = asNonEmptyString(parsed.goal);
  if (!goal) {
    return fail('WORKFLOW_PLAN_INVALID', 'Workflow plan goal is required.');
  }
  if (goal.length > WORKFLOW_MAX_GOAL_CHARS) {
    return fail(
      'WORKFLOW_PLAN_TOO_LARGE',
      `Workflow goal exceeds ${WORKFLOW_MAX_GOAL_CHARS} characters.`,
      { goalLength: goal.length },
    );
  }

  const summary = asNonEmptyString(parsed.summary) ?? goal;

  if (!Array.isArray(parsed.steps)) {
    return fail('WORKFLOW_PLAN_INVALID', 'Workflow plan steps must be an array.');
  }

  if (parsed.steps.length === 0) {
    return fail('WORKFLOW_PLAN_INVALID', 'Workflow plan must include at least one step.');
  }

  if (parsed.steps.length > WORKFLOW_MAX_STEPS) {
    return fail(
      'WORKFLOW_PLAN_TOO_LARGE',
      `Workflow plan exceeds max of ${WORKFLOW_MAX_STEPS} steps.`,
      { stepCount: parsed.steps.length },
    );
  }

  const steps: DeveloperWorkflowStep[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < parsed.steps.length; i += 1) {
    const normalized = normalizeStep(parsed.steps[i], i);
    if (normalized.error) return normalized.error;
    const step = normalized.step!;
    if (seenIds.has(step.id)) {
      return fail('WORKFLOW_PLAN_INVALID', `Duplicate step id "${step.id}".`, {
        stepId: step.id,
      });
    }
    seenIds.add(step.id);
    steps.push(step);
  }

  for (const step of steps) {
    for (const dep of step.dependencies) {
      if (!seenIds.has(dep)) {
        return fail(
          'WORKFLOW_DEPENDENCY_INVALID',
          `Step "${step.id}" depends on unknown step "${dep}".`,
          { stepId: step.id, dependency: dep },
        );
      }
      if (dep === step.id) {
        return fail('WORKFLOW_DEPENDENCY_INVALID', `Step "${step.id}" cannot depend on itself.`, {
          stepId: step.id,
        });
      }
    }
  }

  const cycle = detectCycle(steps);
  if (cycle) {
    return fail(
      'WORKFLOW_DEPENDENCY_INVALID',
      `Workflow plan has a dependency cycle: ${cycle.join(' -> ')}.`,
      { cycle },
    );
  }

  if (maxDependencyDepth(steps) > WORKFLOW_MAX_STEPS) {
    return fail('WORKFLOW_PLAN_TOO_LARGE', `Workflow dependency depth exceeds safe maximum.`, {
      depth: maxDependencyDepth(steps),
    });
  }

  const byId = new Map(steps.map((s) => [s.id, s]));

  for (const rule of PREPARATION_RULES) {
    for (const step of steps) {
      if (step.type !== rule.writeType) continue;
      if (!hasTypeInDependencyChain(step.id, rule.requiredEarlier, byId)) {
        return fail(
          'WORKFLOW_DEPENDENCY_INVALID',
          `${rule.writeType} requires ${rule.requiredEarlier} earlier in its dependency chain.`,
          { stepId: step.id, requiredEarlier: rule.requiredEarlier },
        );
      }
    }
  }

  const writeSteps = steps.filter((s) => s.mutationRisk === 'WRITE');
  if (writeSteps.length > WORKFLOW_MAX_WRITE_CHECKPOINTS) {
    return fail(
      'WORKFLOW_BUDGET_EXCEEDED',
      `Workflow plan exceeds max of ${WORKFLOW_MAX_WRITE_CHECKPOINTS} write checkpoints.`,
      { writeCount: writeSteps.length },
    );
  }

  for (const step of steps) {
    const missing = step.requiredContext.filter((ctx) => !availableContext[ctx]);
    if (missing.length > 0) {
      return fail(
        'WORKFLOW_CONTEXT_INSUFFICIENT',
        `Step "${step.id}" requires unavailable context: ${missing.join(', ')}.`,
        { stepId: step.id, missing },
      );
    }
  }

  const typeCounts = new Map<WorkflowStepType, number>();
  for (const step of steps) {
    const count = (typeCounts.get(step.type) ?? 0) + 1;
    typeCounts.set(step.type, count);
    const max = getCapability(step.type).maxPerWorkflow;
    if (max !== undefined && count > max) {
      return fail(
        'WORKFLOW_BUDGET_EXCEEDED',
        `Capability ${step.type} may appear at most ${max} time(s) per workflow.`,
        { type: step.type, count, max },
      );
    }
  }

  const completionCriteria = parseCompletionCriteria(parsed.completionCriteria);
  if (completionCriteria === null) {
    return fail('AGENT_PLAN_COMPLETION_INVALID', 'Workflow plan has invalid completionCriteria.');
  }

  let estimatedScope: DeveloperWorkflowPlan['estimatedScope'];
  if (isPlainObject(parsed.estimatedScope)) {
    const aiCalls =
      typeof parsed.estimatedScope.aiCalls === 'number' &&
      Number.isFinite(parsed.estimatedScope.aiCalls)
        ? Math.max(0, Math.floor(parsed.estimatedScope.aiCalls))
        : undefined;
    const providerReads =
      typeof parsed.estimatedScope.providerReads === 'number' &&
      Number.isFinite(parsed.estimatedScope.providerReads)
        ? Math.max(0, Math.floor(parsed.estimatedScope.providerReads))
        : undefined;
    const writeCheckpoints =
      typeof parsed.estimatedScope.writeCheckpoints === 'number' &&
      Number.isFinite(parsed.estimatedScope.writeCheckpoints)
        ? Math.max(0, Math.floor(parsed.estimatedScope.writeCheckpoints))
        : writeSteps.length;
    estimatedScope = {
      ...(aiCalls !== undefined ? { aiCalls } : {}),
      ...(providerReads !== undefined ? { providerReads } : {}),
      writeCheckpoints: writeCheckpoints ?? writeSteps.length,
    };
  } else if (writeSteps.length > 0) {
    estimatedScope = { writeCheckpoints: writeSteps.length };
  }

  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings
        .filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
        .map((w) => w.trim())
        .slice(0, 8)
    : undefined;

  const assumptions = Array.isArray(parsed.assumptions)
    ? parsed.assumptions
        .filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
        .map((w) => w.trim().slice(0, 240))
        .slice(0, 12)
    : undefined;

  const confidence = asConfidence(parsed.confidence);

  const plan: DeveloperWorkflowPlan = {
    id,
    goal,
    summary,
    steps,
    ...(estimatedScope ? { estimatedScope } : {}),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
    ...(assumptions && assumptions.length > 0 ? { assumptions } : {}),
    ...(completionCriteria.length > 0 ? { completionCriteria } : {}),
    ...(confidence ? { confidence } : {}),
  };

  const completionCheck = validateCompletionCriteriaAgainstPlan(plan);
  if (!completionCheck.ok) {
    return fail(completionCheck.code, completionCheck.message);
  }

  const goalCheck = validatePlanAgainstGoalConstraints(plan, options?.goal);
  if (!goalCheck.ok) {
    return fail(goalCheck.code, goalCheck.message);
  }

  return { ok: true, plan };
}
