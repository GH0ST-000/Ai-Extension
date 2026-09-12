import { create } from 'zustand';
import {
  annotateArtifact,
  applyApprovedRevision,
  buildEngineeringContext,
  buildPlanningContext,
  buildPlanRevision,
  buildWorkflowGoalOutcome,
  budgetExceededMessage,
  conditionStateFromFacts,
  createWorkflowBudget,
  createWorkflowFact,
  defaultCompletionCriteriaForOutcome,
  detectWorkflowContextChanges,
  formatPlanningContextForPrompt,
  goalMentionsMultipleJiraIssues,
  incrementBudget,
  isWorkflowBindingStale,
  markArtifactsStaleForBindingChange,
  normalizeAgentGoal,
  shouldSkipStepForResume,
  upsertWorkflowFacts,
  validateDeveloperWorkflowPlan,
  wouldExceedBudget,
} from '@project-x/shared';
import type {
  DeveloperAgentGoal,
  DeveloperWorkflowPlan,
  DeveloperWorkflowPlanRevision,
  DeveloperWorkflowSession,
  ExecutionCheckpointKind,
  WorkflowArtifactRef,
  WorkflowContextBinding,
  WorkflowFact,
  WorkflowPlanRevisionReason,
  WorkflowPlanningQuestion,
  WorkflowStepResult,
  WorkflowStepType,
} from '@project-x/types';
import { AIAction, WORKFLOW_MAX_GOAL_CHARS, WorkflowStepType as Step } from '@project-x/types';

import {
  assembleEngineeringBuildInput,
  bindingFromEngineeringContext,
  detectEngineeringSourceFlags,
  useEngineeringSessionStore,
  type EngineeringSessionsInput,
} from '../engineering/engineering.store';
import {
  clearReliabilityResumeSkip,
  getActiveReliabilityExecutionId,
  getLastReliabilityExecutionId,
  getReliabilitySkipCompletedThrough,
  getResumedCompletedStepIds,
  reliabilityCheckpoint,
  reliabilityComplete,
  reliabilityEvent,
  reliabilityFail,
  reliabilityReplayFromServer,
  reliabilityResumeFromServer,
  reliabilityStart,
} from '../reliability/reliability-hooks';
import { contextVersionFromBinding } from '../../api/reliability';
import {
  allStepsTerminal,
  canSkipStep,
  findNextRunnableStep,
  markPlanStepsReady,
  type WorkflowEngineConditionState,
} from './workflow-engine';
import { parseOwnerRepo, useProjectMemoryStore } from '../../project-memory';
import { useMultiRepoStore } from '../multi-repo';
import { runWorkflowStepHandler, type WorkflowOpenPanel } from './workflow-handlers';
import { buildPlannerPrompt, type WorkflowAvailableFlags } from './workflow-planner-prompt';

export type WorkflowUserInputState = {
  stepId: string;
  prompt: string;
  options: { id: string; label: string }[];
};

/** Pending AI launch for selection-toolbar to pick up (avoids store circular imports). */
export type WorkflowPendingAiLaunch = {
  action: AIAction;
  text: string;
  stepId?: string;
};

type WorkflowStoreState = {
  draftGoal: string;
  session: DeveloperWorkflowSession | null;
  planText: string | null;
  pendingPlanGeneration: boolean;
  pendingAgentGoal: DeveloperAgentGoal | null;
  pendingPlanningAssumptions: string[];
  trustedJiraOverride: string | null;
  pendingAiStepId: string | null;
  pendingAiAction: AIAction | null;
  /** One-shot launch request consumed by selection-toolbar. */
  pendingAiLaunch: WorkflowPendingAiLaunch | null;
  openPanelHint: WorkflowOpenPanel | null;
  userInput: WorkflowUserInputState | null;
  lastError: string | null;
  sessionsSnapshot: EngineeringSessionsInput | null;

  setGoal: (goal: string) => void;
  beginPlanGeneration: () => void;
  requestPlan: (sessions: EngineeringSessionsInput) => void | Promise<void>;
  answerPlanningQuestion: (optionId: string) => void | Promise<void>;
  consumePendingAiLaunch: () => WorkflowPendingAiLaunch | null;
  ingestPlan: (content: string) => boolean;
  approvePlan: () => void;
  advance: () => void;
  pauseForConfirmation: (stepId: string, openPanel: WorkflowOpenPanel) => void;
  pauseForUserInput: (
    stepId: string,
    options: { id: string; label: string }[],
    prompt: string,
  ) => void;
  submitUserInput: (optionId: string) => void;
  cancel: () => void;
  retryStep: () => void;
  skipStep: () => void;
  markStepSucceeded: (stepId: string, summary?: string, artifact?: WorkflowArtifactRef) => void;
  markStepFailed: (stepId: string, message: string, retryable?: boolean) => void;
  notifyAssistantSuccess: (action: AIAction, content: string) => void;
  confirmWriteCompleted: () => void;
  proposeRevision: (
    proposedPlan: DeveloperWorkflowPlan,
    reason: WorkflowPlanRevisionReason,
    summary: string,
  ) => void;
  approveRevision: () => void;
  rejectRevision: () => void;
  detectStaleAndPause: (sessions: EngineeringSessionsInput) => boolean;
  clear: () => void;
  isBindingStale: (sessions: EngineeringSessionsInput) => boolean;
  /** Resume a failed/stale execution from its latest checkpoint (skips completed stages). */
  resumeFailedExecution: (executionId?: string) => Promise<boolean>;
  /** Replay creates a fresh execution; write steps still require confirmation. */
  replayExecution: (executionId?: string) => Promise<boolean>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}`;
}

export function bindingFromSessions(sessions: EngineeringSessionsInput): WorkflowContextBinding {
  const built = buildEngineeringContext(assembleEngineeringBuildInput(sessions));
  if (!('error' in built)) {
    return bindingFromEngineeringContext(built);
  }

  const flags = detectEngineeringSourceFlags(sessions);
  const binding: WorkflowContextBinding = {};
  if (flags.jira && sessions.jiraIssue?.key) {
    binding.jira = {
      issueKey: sessions.jiraIssue.key,
      updatedAt: sessions.jiraIssue.updatedAt,
    };
  }
  const github =
    sessions.lastReviewContext?.github ??
    (sessions.pageSnapshot?.type === 'github' ? sessions.pageSnapshot.github : undefined) ??
    sessions.pageSnapshot?.github;
  if (flags.github && github?.owner && github.repository && github.pullRequestNumber) {
    binding.github = {
      repository: `${github.owner}/${github.repository}`,
      prNumber: github.pullRequestNumber,
      headSha: sessions.ciSummary?.headSha ?? `branch:${github.headBranch ?? 'unknown'}`,
    };
  }
  if (flags.api && sessions.openApiContract) {
    binding.api = {
      documentHash: sessions.openApiContract.documentHash,
      operationKey: sessions.openApiOperation
        ? `${sessions.openApiOperation.method}:${sessions.openApiOperation.path}`
        : undefined,
    };
  }
  if (flags.ci && sessions.ciSummary?.headSha) {
    binding.ci = { headSha: sessions.ciSummary.headSha };
  }
  return binding;
}

function applyTrustedJiraOverride(
  binding: WorkflowContextBinding,
  override: string | null,
): WorkflowContextBinding {
  if (!override) {
    return binding;
  }
  return {
    ...binding,
    jira: {
      issueKey: override,
      updatedAt: binding.jira?.updatedAt,
    },
  };
}

function flagsFromSessions(sessions: EngineeringSessionsInput): WorkflowAvailableFlags {
  return detectEngineeringSourceFlags(sessions);
}

function availableContextFromFlags(flags: WorkflowAvailableFlags): {
  jira: boolean;
  github: boolean;
  api: boolean;
  ci: boolean;
} {
  return { jira: flags.jira, github: flags.github, api: flags.api, ci: flags.ci };
}

function trustedScopeFromBinding(binding: WorkflowContextBinding) {
  return {
    ...(binding.jira?.issueKey ? { jiraIssue: binding.jira.issueKey } : {}),
    ...(binding.github?.repository ? { repository: binding.github.repository } : {}),
    ...(binding.github?.prNumber !== undefined
      ? { pullRequestNumber: binding.github.prNumber }
      : {}),
    ...(binding.api?.operationKey ? { apiOperation: binding.api.operationKey } : {}),
  };
}

function availableForPlanning(
  sessions: EngineeringSessionsInput,
  binding: WorkflowContextBinding,
): Parameters<typeof buildPlanningContext>[0]['available'] {
  const available: Parameters<typeof buildPlanningContext>[0]['available'] = {};
  if (binding.jira) {
    available.jira = {
      issueKey: binding.jira.issueKey,
      summary: sessions.jiraIssue?.summary,
      hasNormalizedIssue: Boolean(sessions.jiraIssue?.key === binding.jira.issueKey),
    };
  }
  if (binding.github) {
    available.github = {
      repository: binding.github.repository,
      prNumber: binding.github.prNumber,
      headSha: binding.github.headSha,
      hasPrReport: false,
    };
  }
  if (binding.api) {
    available.api = {
      documentHash: binding.api.documentHash,
      operationKey: binding.api.operationKey,
      hasContractAnalysis: false,
    };
  }
  if (binding.ci || sessions.ciSummary?.headSha) {
    available.ci = {
      headSha: binding.ci?.headSha ?? sessions.ciSummary!.headSha,
      overallStatus: sessions.ciSummary?.overallStatus,
      failedCheckCount: sessions.ciSummary?.counts.failed ?? 0,
      hasFailureAnalysis: false,
    };
  }
  return available;
}

function buildJiraSelectionQuestions(issueKeys: string[]): WorkflowPlanningQuestion[] {
  return [
    {
      id: 'select-jira-issue',
      type: 'SELECT_CONTEXT',
      question: 'Which Jira issue should this workflow use?',
      options: issueKeys.map((key) => ({ id: key, label: key })),
    },
  ];
}

function placeholderPlan(goal: string): DeveloperWorkflowPlan {
  return {
    id: createId('plan-pending'),
    goal,
    summary: 'Awaiting context selection',
    steps: [],
  };
}

/** Live CI / engineering signals merged onto session facts for condition evaluation. */
export function buildLiveConditionFacts(
  sessions: EngineeringSessionsInput | null,
  existingFacts: WorkflowFact[] = [],
): WorkflowFact[] {
  const eng = useEngineeringSessionStore.getState().context;
  const failedCount = sessions?.ciSummary?.counts.failed ?? 0;
  const passedCount = sessions?.ciSummary?.counts.passed ?? 0;
  const live: WorkflowFact[] = [
    createWorkflowFact('CI_TARGET_FAILED', failedCount > 0),
    createWorkflowFact('CI_TARGET_PASSED', failedCount === 0 && passedCount > 0),
    createWorkflowFact('HAS_ENGINEERING_CONTEXT', Boolean(eng)),
    createWorkflowFact('CONTEXT_PARTIAL', !eng && Boolean(sessions)),
  ];
  return upsertWorkflowFacts(existingFacts, live);
}

export function conditionStateForSession(
  sessions: EngineeringSessionsInput | null,
  facts: WorkflowFact[] = [],
): WorkflowEngineConditionState {
  return conditionStateFromFacts(buildLiveConditionFacts(sessions, facts));
}

function factsForSucceededStep(
  stepType: WorkflowStepType | undefined,
  stepId: string,
): WorkflowFact[] {
  if (!stepType) {
    return [];
  }
  switch (stepType) {
    case Step.PREPARE_PATCH:
      return [createWorkflowFact('PATCH_PREPARED', true, stepId)];
    case Step.APPLY_PATCH:
      return [createWorkflowFact('PATCH_APPLIED', true, stepId)];
    case Step.CREATE_REVIEW_DRAFT:
      return [createWorkflowFact('REVIEW_DRAFT_READY', true, stepId)];
    case Step.BUILD_ENGINEERING_CONTEXT:
      return [createWorkflowFact('HAS_ENGINEERING_CONTEXT', true, stepId)];
    case Step.BUILD_MULTI_REPO_CONTEXT:
      return [createWorkflowFact('SYSTEM_CONTEXT_PARTIAL', false, stepId)];
    case Step.ANALYZE_CHANGE_IMPACT: {
      const impact = useMultiRepoStore.getState().lastImpact;
      const highCount =
        impact?.impactedRepositories.filter((i) => i.likelihood === 'high').length ?? 0;
      return [
        createWorkflowFact(
          'MULTI_REPO_IMPACT_FOUND',
          Boolean(impact?.impactedRepositories.length),
          stepId,
        ),
        createWorkflowFact('HIGH_IMPACT_REPOSITORY_COUNT', highCount, stepId),
        createWorkflowFact(
          'CROSS_REPO_CONTRACT_RISK',
          Boolean(impact?.risks.some((r) => r.severity === 'high' || r.severity === 'medium')),
          stepId,
        ),
      ];
    }
    case Step.TRACE_SYSTEM_FLOW: {
      const flow = useMultiRepoStore.getState().lastFlow;
      return [createWorkflowFact('SYSTEM_FLOW_INCOMPLETE', Boolean(flow?.gaps.length), stepId)];
    }
    case Step.FIND_API_CONSUMERS: {
      const consumers = useMultiRepoStore.getState().lastConsumers;
      return [
        createWorkflowFact(
          'KNOWN_API_CONSUMER_FOUND',
          Boolean(consumers?.consumers.length),
          stepId,
        ),
      ];
    }
    case Step.FIND_EVENT_CONSUMERS: {
      const consumers = useMultiRepoStore.getState().lastConsumers;
      return [
        createWorkflowFact(
          'KNOWN_EVENT_CONSUMER_FOUND',
          Boolean(consumers?.consumers.length),
          stepId,
        ),
      ];
    }
    default:
      return [];
  }
}

function touchSession(
  session: DeveloperWorkflowSession,
  patch: Partial<DeveloperWorkflowSession>,
): DeveloperWorkflowSession {
  return { ...session, ...patch, updatedAt: nowIso() };
}

function completedStepIdsFromSession(session: DeveloperWorkflowSession): string[] {
  return Object.values(session.stepResults)
    .filter((result) => result.status === 'SUCCEEDED' || result.status === 'SKIPPED')
    .map((result) => result.stepId);
}

function checkpointStateFromSession(
  session: DeveloperWorkflowSession,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    workflowId: session.id,
    goal: session.goal.slice(0, 200),
    completedStepIds: completedStepIdsFromSession(session),
    ...(session.currentStepId ? { currentStepId: session.currentStepId } : {}),
    ...(extra ?? {}),
  };
}

function reliabilityContextExtras(binding: WorkflowContextBinding): {
  memoryVersion?: string;
  systemContextVersion?: string;
  openapiHash?: string;
  jiraUpdatedAt?: string;
} {
  const memoryVersion = useProjectMemoryStore.getState().memoryVersion ?? undefined;
  const multi = useMultiRepoStore.getState();
  const systemContextVersion = multi.context?.system?.id
    ? `system:${multi.context.system.id}:repos:${multi.enabledRepoKeys.length}`
    : undefined;
  return {
    ...(memoryVersion ? { memoryVersion } : {}),
    ...(systemContextVersion ? { systemContextVersion } : {}),
    ...(binding.api?.documentHash ? { openapiHash: binding.api.documentHash } : {}),
    ...(binding.jira?.updatedAt ? { jiraUpdatedAt: binding.jira.updatedAt } : {}),
  };
}

function emitStepReliabilitySignals(
  session: DeveloperWorkflowSession,
  stepType: WorkflowStepType | undefined,
  stepId: string,
  artifact?: WorkflowArtifactRef,
): void {
  if (!stepType) return;
  const state = checkpointStateFromSession(session, {
    stepType,
    ...(artifact ? { artifactId: artifact.id, artifactKind: artifact.kind } : {}),
  });

  const emit = (
    kind: ExecutionCheckpointKind,
    label: string,
    eventType?: Parameters<typeof reliabilityEvent>[0],
  ) => {
    void reliabilityCheckpoint(kind, label, state, stepId);
    if (eventType) {
      void reliabilityEvent(eventType, {
        stepId,
        ...(artifact ? { artifactId: artifact.id } : {}),
        message: label,
      });
    } else {
      void reliabilityEvent('CONTEXT_LOADED', {
        stepId,
        message: label,
        metadata: { checkpoint: kind },
      });
    }
  };

  switch (stepType) {
    case Step.BUILD_ENGINEERING_CONTEXT:
      emit('GITHUB_CONTEXT_LOADED', 'GitHub Context Loaded');
      break;
    case Step.REVIEW_PULL_REQUEST:
      emit('PR_PARSED', 'PR Parsed');
      break;
    case Step.ANALYZE_API_CONTRACT:
      emit('OPENAPI_LOADED', 'OpenAPI Loaded');
      break;
    case Step.SUMMARIZE_JIRA:
      emit('JIRA_LOADED', 'Jira Loaded');
      emit('AI_SUMMARY_COMPLETE', 'AI Summary Complete');
      break;
    case Step.EXTRACT_ACCEPTANCE_CRITERIA:
      emit('JIRA_LOADED', 'Jira Loaded');
      break;
    case Step.BUILD_MULTI_REPO_CONTEXT:
      emit('MULTI_REPO_LOADED', 'Multi-Repo Context Loaded');
      break;
    case Step.GENERATE_PATCH:
    case Step.PREPARE_PATCH:
    case Step.SUGGEST_FIX:
      emit('PATCH_GENERATED', 'Patch Generated', 'PATCH_GENERATED');
      break;
    case Step.APPLY_PATCH:
      void reliabilityEvent('PATCH_APPLIED', {
        stepId,
        ...(artifact ? { artifactId: artifact.id } : {}),
        message: 'Patch Applied',
      });
      break;
    default:
      if (artifact?.kind === 'generated-patch' || artifact?.kind === 'prepared-patch') {
        emit('PATCH_GENERATED', 'Patch Generated', 'PATCH_GENERATED');
      }
      break;
  }

  const memoryVersion = useProjectMemoryStore.getState().memoryVersion;
  if (
    memoryVersion &&
    (stepType === Step.BUILD_ENGINEERING_CONTEXT || stepType === Step.ANALYZE_ENGINEERING_ALIGNMENT)
  ) {
    void reliabilityCheckpoint(
      'PROJECT_MEMORY_LOADED',
      'Project Memory Loaded',
      { ...state, memoryVersion },
      stepId,
    );
  }
}

function applyResumeSkips(session: DeveloperWorkflowSession): DeveloperWorkflowSession {
  const skipThrough = getReliabilitySkipCompletedThrough();
  const resumedIds = getResumedCompletedStepIds();
  if (!skipThrough && resumedIds.length === 0) {
    return session;
  }

  const results = { ...session.stepResults };
  let changed = false;
  for (const step of session.plan.steps) {
    const existing = results[step.id];
    if (existing && (existing.status === 'SUCCEEDED' || existing.status === 'SKIPPED')) {
      continue;
    }
    if (
      shouldSkipStepForResume({
        stepType: step.type,
        skipCompletedThrough: skipThrough ?? 'PLANNING_COMPLETE',
        completedStepIds: resumedIds,
        stepId: step.id,
      })
    ) {
      results[step.id] = {
        stepId: step.id,
        status: 'SKIPPED',
        completedAt: nowIso(),
        summary: `Skipped on resume (${skipThrough ?? 'checkpoint'})`,
      };
      changed = true;
    }
  }

  if (!changed) {
    return session;
  }

  clearReliabilityResumeSkip();
  return touchSession(session, {
    stepResults: results,
    plan: markPlanStepsReady(session.plan, results),
    status: 'RUNNING',
    execution: {
      ...session.execution,
      lastError: undefined,
      completedAt: undefined,
    },
  });
}

function finishWithOutcome(session: DeveloperWorkflowSession): DeveloperWorkflowSession {
  const withFacts = {
    ...session,
    facts: session.facts ?? [],
  };
  const outcome = buildWorkflowGoalOutcome({ session: withFacts });
  const needsAttention =
    outcome.status === 'PARTIALLY_ACHIEVED' || outcome.status === 'NOT_ACHIEVED';
  return touchSession(session, {
    status: needsAttention ? 'NEEDS_ATTENTION' : 'COMPLETED',
    currentStepId: undefined,
    outcome,
    execution: {
      ...session.execution,
      completedAt: nowIso(),
    },
    plan: markPlanStepsReady(session.plan, session.stepResults),
  });
}

export const useWorkflowSessionStore = create<WorkflowStoreState>((set, get) => ({
  draftGoal: '',
  session: null,
  planText: null,
  pendingPlanGeneration: false,
  pendingAgentGoal: null,
  pendingPlanningAssumptions: [],
  trustedJiraOverride: null,
  pendingAiStepId: null,
  pendingAiAction: null,
  pendingAiLaunch: null,
  openPanelHint: null,
  userInput: null,
  lastError: null,
  sessionsSnapshot: null,

  setGoal: (goal) => {
    set({ draftGoal: goal.slice(0, WORKFLOW_MAX_GOAL_CHARS), lastError: null });
  },

  beginPlanGeneration: () => {
    set({ pendingPlanGeneration: true, lastError: null });
  },

  requestPlan: async (sessions) => {
    const goal = get().draftGoal.trim();
    if (!goal) {
      set({ lastError: 'Enter a goal before generating a plan.' });
      return;
    }

    const binding = applyTrustedJiraOverride(
      bindingFromSessions(sessions),
      get().trustedJiraOverride,
    );
    const agentGoal = normalizeAgentGoal({
      text: goal,
      trustedScope: trustedScopeFromBinding(binding),
    });

    const mentionedIssues = goalMentionsMultipleJiraIssues(goal);
    if (mentionedIssues.length > 1 && !binding.jira?.issueKey) {
      const planningQuestions = buildJiraSelectionQuestions(mentionedIssues);
      const session: DeveloperWorkflowSession = {
        id: createId('wf'),
        goal,
        agentGoal,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        contextBinding: binding,
        status: 'AWAITING_CONTEXT_SELECTION',
        plan: placeholderPlan(goal),
        planHistory: [],
        planningQuestions,
        stepResults: {},
        artifacts: {},
        facts: [],
        budget: createWorkflowBudget(),
        execution: {},
      };
      set({
        sessionsSnapshot: sessions,
        session,
        planText: null,
        pendingPlanGeneration: false,
        pendingAgentGoal: agentGoal,
        pendingPlanningAssumptions: [],
        pendingAiLaunch: null,
        openPanelHint: null,
        userInput: null,
        lastError: null,
      });
      return;
    }

    const parsedRepo = parseOwnerRepo(binding.github?.repository);
    const projectMemory = parsedRepo
      ? ((await useProjectMemoryStore.getState().fetchSummary(parsedRepo.owner, parsedRepo.repo, {
          capability: 'PLANNING',
        })) ?? undefined)
      : undefined;

    const multiRepo = useMultiRepoStore.getState();
    if (multiRepo.systems.length === 0) {
      await multiRepo.loadSystems();
    }
    const multiRepoSystem = useMultiRepoStore.getState().planningSummary() ?? undefined;

    const planningContext = buildPlanningContext({
      goal: agentGoal,
      binding,
      available: availableForPlanning(sessions, binding),
      ...(projectMemory ? { projectMemory } : {}),
      ...(multiRepoSystem ? { multiRepoSystem } : {}),
    });
    const planningContextText = formatPlanningContextForPrompt(planningContext);
    const flags = flagsFromSessions(sessions);
    const prompt = buildPlannerPrompt(goal, binding, flags, undefined, {
      planningContextText,
      agentGoal,
    });

    get().beginPlanGeneration();
    set({
      sessionsSnapshot: sessions,
      planText: null,
      session: null,
      openPanelHint: null,
      userInput: null,
      pendingAgentGoal: agentGoal,
      pendingPlanningAssumptions: planningContext.assumptions,
      pendingAiLaunch: {
        action: AIAction.PLAN_DEVELOPER_WORKFLOW,
        text: prompt,
      },
    });
  },

  answerPlanningQuestion: (optionId) => {
    const { session, sessionsSnapshot } = get();
    if (!session || session.status !== 'AWAITING_CONTEXT_SELECTION') {
      return;
    }
    const question = session.planningQuestions?.[0];
    const selected = question?.options?.find((o) => o.id === optionId);
    if (!selected) {
      set({ lastError: 'Select a valid option to continue.' });
      return;
    }

    set({
      trustedJiraOverride: optionId,
      lastError: null,
    });

    const sessions = sessionsSnapshot ?? {};
    return get().requestPlan(sessions);
  },

  consumePendingAiLaunch: () => {
    const launch = get().pendingAiLaunch;
    if (!launch) {
      return null;
    }
    set({ pendingAiLaunch: null });
    return launch;
  },

  ingestPlan: (content) => {
    if (!get().pendingPlanGeneration) {
      return false;
    }

    const sessions = get().sessionsSnapshot;
    const flags = sessions
      ? availableContextFromFlags(flagsFromSessions(sessions))
      : { jira: false, github: false, api: false, ci: false };

    let raw: unknown = content;
    try {
      const trimmed = content.trim();
      const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
      raw = JSON.parse(fence ? fence[1]!.trim() : trimmed);
    } catch {
      set({
        pendingPlanGeneration: false,
        lastError: 'Planner returned invalid JSON.',
      });
      return false;
    }

    const agentGoal = get().pendingAgentGoal;
    const validated = validateDeveloperWorkflowPlan(raw, flags, {
      ...(agentGoal ? { goal: agentGoal } : {}),
    });
    if (!validated.ok) {
      set({
        pendingPlanGeneration: false,
        lastError: validated.message,
      });
      return false;
    }

    const plan = validated.plan;
    const binding = sessions
      ? applyTrustedJiraOverride(bindingFromSessions(sessions), get().trustedJiraOverride)
      : {};

    const planningAssumptions = get().pendingPlanningAssumptions;
    const mergedAssumptions = [
      ...new Set([...(planningAssumptions ?? []), ...(plan.assumptions ?? [])]),
    ].slice(0, 12);

    const completionCriteria =
      plan.completionCriteria && plan.completionCriteria.length > 0
        ? plan.completionCriteria
        : agentGoal
          ? defaultCompletionCriteriaForOutcome(agentGoal.normalizedIntent.desiredOutcome)
          : [];

    const enrichedPlan: DeveloperWorkflowPlan = {
      ...plan,
      ...(mergedAssumptions.length > 0 ? { assumptions: mergedAssumptions } : {}),
      ...(completionCriteria.length > 0 ? { completionCriteria } : {}),
    };

    const session: DeveloperWorkflowSession = {
      id: createId('wf'),
      goal: get().draftGoal.trim() || enrichedPlan.goal,
      ...(agentGoal ? { agentGoal } : {}),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      contextBinding: binding,
      status: 'AWAITING_PLAN_APPROVAL',
      plan: enrichedPlan,
      planHistory: [],
      stepResults: {},
      artifacts: {},
      facts: [],
      budget: createWorkflowBudget(),
      execution: {},
    };

    set({
      session,
      planText: content,
      pendingPlanGeneration: false,
      pendingAgentGoal: agentGoal,
      lastError: null,
    });

    void (async () => {
      await reliabilityStart({
        workflowId: session.id,
        goal: session.goal,
        binding: session.contextBinding,
        ...reliabilityContextExtras(session.contextBinding),
      });
      await reliabilityEvent('PLANNING_COMPLETED', {
        message: 'Planner produced a validated plan',
      });
      await reliabilityCheckpoint(
        'PLANNING_COMPLETE',
        'Planning Complete',
        checkpointStateFromSession(session, { stepCount: enrichedPlan.steps.length }),
      );
      if (session.contextBinding.jira?.issueKey) {
        await reliabilityCheckpoint(
          'JIRA_LOADED',
          'Jira Loaded',
          checkpointStateFromSession(session, {
            issueKey: session.contextBinding.jira.issueKey,
          }),
        );
      }
      if (session.contextBinding.github?.repository) {
        await reliabilityCheckpoint(
          'GITHUB_CONTEXT_LOADED',
          'GitHub Context Loaded',
          checkpointStateFromSession(session, {
            repository: session.contextBinding.github.repository,
          }),
        );
      }
      if (session.contextBinding.api?.documentHash) {
        await reliabilityCheckpoint(
          'OPENAPI_LOADED',
          'OpenAPI Loaded',
          checkpointStateFromSession(session, {
            openapiHash: session.contextBinding.api.documentHash,
          }),
        );
      }
      const memoryVersion = useProjectMemoryStore.getState().memoryVersion;
      if (memoryVersion) {
        await reliabilityCheckpoint(
          'PROJECT_MEMORY_LOADED',
          'Project Memory Loaded',
          checkpointStateFromSession(session, { memoryVersion }),
        );
      }
    })();

    return true;
  },

  /**
   * Approves the plan and starts execution. NEVER calls apply/submit APIs.
   */
  approvePlan: () => {
    const { session } = get();
    if (!session || session.status !== 'AWAITING_PLAN_APPROVAL') {
      return;
    }

    const next = touchSession(session, {
      status: 'RUNNING',
      plan: markPlanStepsReady(session.plan, session.stepResults),
      execution: { ...session.execution, startedAt: nowIso() },
    });
    set({ session: next, openPanelHint: null, userInput: null });
    get().advance();
  },

  advance: () => {
    const { session: rawSession, sessionsSnapshot, pendingAiStepId } = get();
    if (!rawSession || pendingAiStepId) {
      return;
    }
    const session =
      rawSession.status === 'FAILED' ||
      rawSession.status === 'STALE' ||
      rawSession.status === 'RUNNING'
        ? applyResumeSkips(rawSession)
        : rawSession;
    if (session !== rawSession) {
      set({ session, lastError: null });
    }
    if (session.status === 'AWAITING_CONFIRMATION' || session.status === 'AWAITING_USER_INPUT') {
      return;
    }
    if (
      session.status === 'AWAITING_REVISION_APPROVAL' ||
      session.status === 'STALE' ||
      session.status === 'AWAITING_CONTEXT_SELECTION'
    ) {
      return;
    }
    if (session.status !== 'RUNNING') {
      return;
    }

    const budget = session.budget ?? createWorkflowBudget();
    if (wouldExceedBudget(budget, 'steps')) {
      const blocked = {
        ...session,
        budget,
      };
      set({
        session: touchSession(session, {
          status: 'NEEDS_ATTENTION',
          budget,
          outcome: buildWorkflowGoalOutcome({
            session: blocked,
            blocked: [
              {
                code: 'WORKFLOW_BUDGET_EXCEEDED',
                message: budgetExceededMessage(budget),
              },
            ],
          }),
          execution: {
            ...session.execution,
            completedAt: nowIso(),
            lastError: {
              code: 'WORKFLOW_BUDGET_EXCEEDED',
              message: budgetExceededMessage(budget),
            },
          },
        }),
        lastError: budgetExceededMessage(budget),
      });
      return;
    }

    const mergedFacts = buildLiveConditionFacts(sessionsSnapshot, session.facts ?? []);
    const conditionState = conditionStateFromFacts(mergedFacts);
    const { step: nextStep, results: resultsWithSkips } = findNextRunnableStep(
      session.plan,
      session.stepResults,
      conditionState,
    );

    const working = touchSession(session, {
      facts: mergedFacts,
      stepResults: resultsWithSkips,
      plan: markPlanStepsReady(session.plan, resultsWithSkips),
    });

    if (!nextStep) {
      if (allStepsTerminal(working.plan, working.stepResults)) {
        const finished = finishWithOutcome(working);
        set({ session: finished });
        void reliabilityComplete(
          finished.status === 'COMPLETED' ? 'completed' : 'failed',
          finished.artifacts,
        );
      } else {
        set({ session: working });
      }
      return;
    }

    set({ session: working });

    const started: WorkflowStepResult = {
      stepId: nextStep.id,
      status: 'RUNNING',
      startedAt: nowIso(),
    };
    const steppedBudget = incrementBudget(budget, 'steps');
    const withRunning = touchSession(working, {
      currentStepId: nextStep.id,
      budget: steppedBudget,
      stepResults: { ...working.stepResults, [nextStep.id]: started },
      plan: markPlanStepsReady(working.plan, {
        ...working.stepResults,
        [nextStep.id]: started,
      }),
      status: 'RUNNING',
    });
    set({ session: withRunning });

    const handlerResult = runWorkflowStepHandler(nextStep.type, {
      sessions: sessionsSnapshot ?? {},
    });

    if (!handlerResult.ok) {
      get().markStepFailed(nextStep.id, handlerResult.message, handlerResult.retryable);
      return;
    }

    if ('needsAiAction' in handlerResult && handlerResult.needsAiAction) {
      const current = get().session!;
      const currentBudget = current.budget ?? steppedBudget;
      if (wouldExceedBudget(currentBudget, 'aiCalls')) {
        set({
          session: touchSession(current, {
            status: 'NEEDS_ATTENTION',
            outcome: buildWorkflowGoalOutcome({
              session: current,
              blocked: [
                {
                  code: 'AGENT_BUDGET_EXCEEDED',
                  message: budgetExceededMessage(currentBudget),
                },
              ],
            }),
            execution: {
              ...current.execution,
              lastError: {
                code: 'AGENT_BUDGET_EXCEEDED',
                message: budgetExceededMessage(currentBudget),
              },
            },
          }),
          lastError: budgetExceededMessage(currentBudget),
        });
        return;
      }

      set({
        pendingAiStepId: nextStep.id,
        pendingAiAction: handlerResult.needsAiAction,
        pendingAiLaunch: {
          action: handlerResult.needsAiAction,
          text: handlerResult.text,
          stepId: nextStep.id,
        },
        session: touchSession(current, {
          budget: incrementBudget(currentBudget, 'aiCalls'),
          stepResults: {
            ...current.stepResults,
            [nextStep.id]: {
              ...started,
              status: 'WAITING',
              summary: handlerResult.summary,
            },
          },
        }),
      });
      return;
    }

    if ('needsConfirmation' in handlerResult && handlerResult.needsConfirmation) {
      get().pauseForConfirmation(nextStep.id, handlerResult.openPanel);
      return;
    }

    if ('needsUserInput' in handlerResult && handlerResult.needsUserInput) {
      get().pauseForUserInput(nextStep.id, handlerResult.options, handlerResult.prompt);
      return;
    }

    if ('showPanel' in handlerResult && handlerResult.showPanel === 'multi-repo') {
      useMultiRepoStore.getState().setPanelOpen(true);
      set({ openPanelHint: 'multi-repo' });
    }

    const artifactKind =
      'artifactKind' in handlerResult && handlerResult.artifactKind
        ? handlerResult.artifactKind
        : undefined;
    if (artifactKind) {
      get().markStepSucceeded(nextStep.id, handlerResult.summary, {
        id: createId(artifactKind),
        kind: artifactKind,
        summary: handlerResult.summary,
        createdAt: nowIso(),
      });
      return;
    }

    get().markStepSucceeded(nextStep.id, handlerResult.summary);
  },

  pauseForConfirmation: (stepId, openPanel) => {
    const { session } = get();
    if (!session) {
      return;
    }
    const prev = session.stepResults[stepId];
    const waiting: WorkflowStepResult = {
      stepId,
      status: 'WAITING',
      startedAt: prev?.startedAt ?? nowIso(),
      summary: 'Awaiting explicit write confirmation',
      errorCode: 'WORKFLOW_WRITE_CONFIRMATION_REQUIRED',
    };
    const budget = incrementBudget(session.budget ?? createWorkflowBudget(), 'writeCheckpoints');
    set({
      openPanelHint: openPanel,
      session: touchSession(session, {
        status: 'AWAITING_CONFIRMATION',
        currentStepId: stepId,
        budget,
        stepResults: { ...session.stepResults, [stepId]: waiting },
      }),
    });
  },

  pauseForUserInput: (stepId, options, prompt) => {
    const { session } = get();
    if (!session) {
      return;
    }
    const prev = session.stepResults[stepId];
    const waiting: WorkflowStepResult = {
      stepId,
      status: 'WAITING',
      startedAt: prev?.startedAt ?? nowIso(),
      summary: prompt,
      errorCode: 'WORKFLOW_USER_INPUT_REQUIRED',
    };
    set({
      userInput: { stepId, options, prompt },
      session: touchSession(session, {
        status: 'AWAITING_USER_INPUT',
        currentStepId: stepId,
        stepResults: { ...session.stepResults, [stepId]: waiting },
      }),
    });
  },

  submitUserInput: (optionId) => {
    const { session, userInput } = get();
    if (!session || !userInput) {
      return;
    }
    const selected = userInput.options.find((o) => o.id === optionId);
    get().markStepSucceeded(userInput.stepId, selected ? `Selected: ${selected.label}` : optionId);
    set({ userInput: null });
    const updated = get().session;
    if (updated) {
      set({
        session: touchSession(updated, { status: 'RUNNING' }),
      });
      get().advance();
    }
  },

  cancel: () => {
    const { session } = get();
    if (!session) {
      set({
        pendingPlanGeneration: false,
        pendingAgentGoal: null,
        pendingPlanningAssumptions: [],
        pendingAiStepId: null,
        pendingAiAction: null,
        pendingAiLaunch: null,
        openPanelHint: null,
        userInput: null,
      });
      return;
    }
    const cancelled = touchSession(session, {
      status: 'CANCELLED',
      execution: {
        ...session.execution,
        completedAt: nowIso(),
        lastError: {
          code: 'WORKFLOW_CANCELLED',
          message: 'Workflow cancelled',
        },
      },
    });
    set({
      session: touchSession(cancelled, {
        outcome: buildWorkflowGoalOutcome({ session: cancelled, cancelled: true }),
      }),
      pendingPlanGeneration: false,
      pendingAiStepId: null,
      pendingAiAction: null,
      pendingAiLaunch: null,
      openPanelHint: null,
      userInput: null,
    });
    void reliabilityEvent('WORKFLOW_CANCELLED', { message: 'Workflow cancelled' });
    void reliabilityComplete('cancelled', session.artifacts);
  },

  retryStep: () => {
    const { session } = get();
    if (!session?.currentStepId) {
      return;
    }
    const stepId = session.currentStepId;
    const results = { ...session.stepResults };
    delete results[stepId];
    set({
      session: touchSession(session, {
        status: 'RUNNING',
        stepResults: results,
        plan: markPlanStepsReady(session.plan, results),
      }),
      pendingAiStepId: null,
      pendingAiAction: null,
      openPanelHint: null,
      userInput: null,
      lastError: null,
    });
    get().advance();
  },

  skipStep: () => {
    const { session } = get();
    if (!session?.currentStepId) {
      return;
    }
    const stepId = session.currentStepId;
    const check = canSkipStep(session.plan, stepId, session.stepResults);
    if (!check.ok) {
      set({ lastError: check.reason });
      return;
    }
    const skipped: WorkflowStepResult = {
      stepId,
      status: 'SKIPPED',
      completedAt: nowIso(),
      summary: 'Skipped by user',
    };
    const results = { ...session.stepResults, [stepId]: skipped };
    set({
      session: touchSession(session, {
        status: 'RUNNING',
        stepResults: results,
        currentStepId: undefined,
        plan: markPlanStepsReady(session.plan, results),
      }),
      pendingAiStepId: null,
      pendingAiAction: null,
      openPanelHint: null,
      userInput: null,
    });
    get().advance();
  },

  markStepSucceeded: (stepId, summary, artifact) => {
    const { session } = get();
    if (!session) {
      return;
    }
    const prev = session.stepResults[stepId];
    const step = session.plan.steps.find((s) => s.id === stepId);
    const result: WorkflowStepResult = {
      stepId,
      status: 'SUCCEEDED',
      startedAt: prev?.startedAt,
      completedAt: nowIso(),
      summary,
      artifactId: artifact?.id,
    };
    const artifacts = { ...session.artifacts };
    if (artifact) {
      artifacts[artifact.id] = annotateArtifact(artifact, {
        producedByStepId: stepId,
        provenanceStatus: 'CURRENT',
        binding: artifact.binding ?? session.contextBinding,
      });
    }
    const stepFacts = factsForSucceededStep(step?.type, stepId);
    const facts = upsertWorkflowFacts(session.facts ?? [], stepFacts);
    const results = { ...session.stepResults, [stepId]: result };
    const nextSession = touchSession(session, {
      stepResults: results,
      artifacts,
      facts,
      currentStepId: undefined,
      plan: markPlanStepsReady(session.plan, results),
      status: 'RUNNING',
    });
    emitStepReliabilitySignals(nextSession, step?.type, stepId, artifact);
    set({
      session: nextSession,
      pendingAiStepId: null,
      pendingAiAction: null,
    });
    get().advance();
  },

  markStepFailed: (stepId, message, retryable = true) => {
    const { session } = get();
    if (!session) {
      return;
    }
    const prev = session.stepResults[stepId];
    const result: WorkflowStepResult = {
      stepId,
      status: 'FAILED',
      startedAt: prev?.startedAt,
      completedAt: nowIso(),
      errorMessage: message,
      errorCode: 'WORKFLOW_STEP_FAILED',
      retryable,
    };
    const results = { ...session.stepResults, [stepId]: result };
    set({
      session: touchSession(session, {
        status: 'FAILED',
        stepResults: results,
        plan: markPlanStepsReady(session.plan, results),
        execution: {
          ...session.execution,
          lastError: { code: 'WORKFLOW_STEP_FAILED', message },
        },
      }),
      pendingAiStepId: null,
      pendingAiAction: null,
      lastError: message,
    });
    void reliabilityFail({
      code: 'WORKFLOW_STEP_FAILED',
      message,
      stage: stepId,
    });
    void reliabilityComplete('failed', session.artifacts);
  },

  notifyAssistantSuccess: (action, content) => {
    const { pendingPlanGeneration, pendingAiStepId, pendingAiAction } = get();

    if (pendingPlanGeneration && action === AIAction.PLAN_DEVELOPER_WORKFLOW) {
      get().ingestPlan(content);
      return;
    }

    if (pendingAiStepId && pendingAiAction === action) {
      get().markStepSucceeded(pendingAiStepId, `${action} completed`);
    }
  },

  confirmWriteCompleted: () => {
    const { session } = get();
    if (!session || session.status !== 'AWAITING_CONFIRMATION' || !session.currentStepId) {
      return;
    }
    const stepId = session.currentStepId;
    void reliabilityEvent('GITHUB_WRITE_CONFIRMED', {
      stepId,
      message: 'Write confirmed by user',
    });
    void reliabilityEvent('GITHUB_WRITE_COMPLETED', {
      stepId,
      message: 'Write confirmation recorded (no auto-retry without idempotency)',
    });
    get().markStepSucceeded(stepId, 'Write confirmed by user');
    set({ openPanelHint: null });
  },

  proposeRevision: (proposedPlan, reason, summary) => {
    const { session } = get();
    if (!session) {
      return;
    }
    const revision = buildPlanRevision({
      workflowId: session.id,
      previousPlan: session.plan,
      proposedPlan,
      results: session.stepResults,
      reason,
      summary,
      id: createId('rev'),
    });
    set({
      session: touchSession(session, {
        status: 'AWAITING_REVISION_APPROVAL',
        pendingRevision: revision,
      }),
      openPanelHint: null,
      userInput: null,
      pendingAiStepId: null,
      pendingAiAction: null,
    });
  },

  approveRevision: () => {
    const { session } = get();
    if (!session?.pendingRevision || session.status !== 'AWAITING_REVISION_APPROVAL') {
      return;
    }
    // Revision approval never authorizes writes — confirmation stays separate.
    const nextPlan = applyApprovedRevision(
      session.plan,
      session.pendingRevision,
      session.stepResults,
    );
    const budget = incrementBudget(session.budget ?? createWorkflowBudget(), 'replans');
    const planHistory = [...(session.planHistory ?? []), session.plan];
    set({
      session: touchSession(session, {
        status: 'RUNNING',
        plan: markPlanStepsReady(nextPlan, session.stepResults),
        planHistory,
        pendingRevision: undefined,
        budget,
        currentStepId: undefined,
      }),
    });
    get().advance();
  },

  rejectRevision: () => {
    const { session } = get();
    if (!session?.pendingRevision) {
      return;
    }
    set({
      session: touchSession(session, {
        status: 'CANCELLED',
        pendingRevision: undefined,
        outcome: buildWorkflowGoalOutcome({
          session: { ...session, status: 'CANCELLED' },
          cancelled: true,
          summaryOverride: 'Plan revision rejected.',
        }),
        execution: {
          ...session.execution,
          completedAt: nowIso(),
        },
      }),
    });
  },

  detectStaleAndPause: (sessions) => {
    const { session } = get();
    if (!session) {
      return false;
    }
    const current = applyTrustedJiraOverride(
      bindingFromSessions(sessions),
      get().trustedJiraOverride,
    );
    const changes = detectWorkflowContextChanges(session.contextBinding, current);
    if (changes.length === 0) {
      return false;
    }

    const artifacts = markArtifactsStaleForBindingChange(
      session.artifacts,
      session.contextBinding,
      current,
    );
    const nextStatus =
      session.pendingRevision || session.status === 'AWAITING_REVISION_APPROVAL'
        ? 'AWAITING_REVISION_APPROVAL'
        : 'STALE';

    set({
      sessionsSnapshot: sessions,
      session: touchSession(session, {
        status: nextStatus,
        artifacts,
        execution: {
          ...session.execution,
          lastError: {
            code: 'AGENT_CONTEXT_CHANGED',
            message: 'Trusted context changed since this plan was bound.',
            details: { changes },
          },
        },
      }),
      pendingAiStepId: null,
      pendingAiAction: null,
      openPanelHint: null,
    });
    return true;
  },

  clear: () => {
    set({
      draftGoal: '',
      session: null,
      planText: null,
      pendingPlanGeneration: false,
      pendingAgentGoal: null,
      pendingPlanningAssumptions: [],
      trustedJiraOverride: null,
      pendingAiStepId: null,
      pendingAiAction: null,
      pendingAiLaunch: null,
      openPanelHint: null,
      userInput: null,
      lastError: null,
      sessionsSnapshot: null,
    });
  },

  isBindingStale: (sessions) => {
    const { session } = get();
    if (!session) {
      return false;
    }
    const current = applyTrustedJiraOverride(
      bindingFromSessions(sessions),
      get().trustedJiraOverride,
    );
    return isWorkflowBindingStale(session.contextBinding, current).stale;
  },

  resumeFailedExecution: async (executionId) => {
    const { session } = get();
    if (
      !session ||
      (session.status !== 'FAILED' &&
        session.status !== 'STALE' &&
        session.status !== 'NEEDS_ATTENTION')
    ) {
      set({ lastError: 'Resume requires a failed or stale workflow session.' });
      return false;
    }
    const targetId =
      executionId ?? getActiveReliabilityExecutionId() ?? getLastReliabilityExecutionId();
    if (!targetId) {
      set({ lastError: 'No reliability execution available to resume.' });
      return false;
    }

    const resumed = await reliabilityResumeFromServer(targetId);
    if (!resumed) {
      set({ lastError: 'Unable to resume workflow execution.' });
      return false;
    }

    const withSkips = applyResumeSkips(
      touchSession(session, {
        status: 'RUNNING',
        currentStepId: undefined,
        execution: {
          ...session.execution,
          lastError: undefined,
          completedAt: undefined,
        },
      }),
    );
    set({ session: withSkips, lastError: null, pendingAiStepId: null, pendingAiAction: null });
    get().advance();
    return true;
  },

  replayExecution: async (executionId) => {
    const { session } = get();
    if (!session) {
      set({ lastError: 'Replay requires an existing workflow session.' });
      return false;
    }
    const targetId =
      executionId ?? getActiveReliabilityExecutionId() ?? getLastReliabilityExecutionId();
    if (!targetId) {
      set({ lastError: 'No reliability execution available to replay.' });
      return false;
    }

    const replayed = await reliabilityReplayFromServer(targetId, {
      ...contextVersionFromBinding(session.contextBinding),
      ...reliabilityContextExtras(session.contextBinding),
    });
    if (!replayed) {
      set({ lastError: 'Unable to replay workflow execution.' });
      return false;
    }

    // Fresh execution of the same plan — reset step results; write steps still pause for confirmation.
    clearReliabilityResumeSkip();
    const resetResults: Record<string, WorkflowStepResult> = {};
    set({
      session: touchSession(session, {
        status: 'RUNNING',
        stepResults: resetResults,
        currentStepId: undefined,
        plan: markPlanStepsReady(session.plan, resetResults),
        execution: {
          startedAt: nowIso(),
        },
      }),
      lastError: replayed.drift.hasDrift
        ? `Replay started with context drift: ${replayed.drift.summary}`
        : null,
      pendingAiStepId: null,
      pendingAiAction: null,
      openPanelHint: null,
      userInput: null,
    });
    get().advance();
    return true;
  },
}));

/** Safety sentinel used by specs — approvePlan never mutates GitHub. */
export function didApprovePlanMutateGithub(): boolean {
  return false;
}

export type { DeveloperWorkflowPlan, DeveloperWorkflowPlanRevision };
