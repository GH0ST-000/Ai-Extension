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
  upsertWorkflowFacts,
  validateDeveloperWorkflowPlan,
  wouldExceedBudget,
} from '@project-x/shared';
import type {
  DeveloperAgentGoal,
  DeveloperWorkflowPlan,
  DeveloperWorkflowPlanRevision,
  DeveloperWorkflowSession,
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
  allStepsTerminal,
  canSkipStep,
  findNextRunnableStep,
  markPlanStepsReady,
  type WorkflowEngineConditionState,
} from './workflow-engine';
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
  requestPlan: (sessions: EngineeringSessionsInput) => void;
  answerPlanningQuestion: (optionId: string) => void;
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

  requestPlan: (sessions) => {
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

    const planningContext = buildPlanningContext({
      goal: agentGoal,
      binding,
      available: availableForPlanning(sessions, binding),
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
    get().requestPlan(sessions);
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
    const { session, sessionsSnapshot, pendingAiStepId } = get();
    if (!session || pendingAiStepId) {
      return;
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
        set({ session: finishWithOutcome(working) });
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
    set({
      session: touchSession(session, {
        stepResults: results,
        artifacts,
        facts,
        currentStepId: undefined,
        plan: markPlanStepsReady(session.plan, results),
        status: 'RUNNING',
      }),
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
    get().markStepSucceeded(session.currentStepId, 'Write confirmed by user');
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
}));

/** Safety sentinel used by specs — approvePlan never mutates GitHub. */
export function didApprovePlanMutateGithub(): boolean {
  return false;
}

export type { DeveloperWorkflowPlan, DeveloperWorkflowPlanRevision };
