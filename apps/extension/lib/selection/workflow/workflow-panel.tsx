import { useCallback, useMemo, useState } from 'react';
import type { DeveloperWorkflowStep } from '@project-x/types';

import { cn } from '~/lib/utils/cn';

import type { EngineeringSessionsInput } from '../engineering/engineering.store';
import { usePatchApplyStore } from '../patch-apply/patch-apply.store';
import { useGithubReviewDraftStore } from '../review-draft';
import { useWorkflowSessionStore } from './workflow.store';

export type WorkflowPanelProps = {
  sessions: EngineeringSessionsInput;
  className?: string;
};

/**
 * Flow tab UI — goal → plan preview → approve → progress with confirmation / user-select pauses.
 * Compact 300px ActionMenu-aligned chrome.
 */
export function WorkflowPanel(props: WorkflowPanelProps) {
  const draftGoal = useWorkflowSessionStore((s) => s.draftGoal);
  const session = useWorkflowSessionStore((s) => s.session);
  const pendingPlanGeneration = useWorkflowSessionStore((s) => s.pendingPlanGeneration);
  const lastError = useWorkflowSessionStore((s) => s.lastError);
  const openPanelHint = useWorkflowSessionStore((s) => s.openPanelHint);
  const userInput = useWorkflowSessionStore((s) => s.userInput);
  const setGoal = useWorkflowSessionStore((s) => s.setGoal);
  const requestPlan = useWorkflowSessionStore((s) => s.requestPlan);
  const answerPlanningQuestion = useWorkflowSessionStore((s) => s.answerPlanningQuestion);
  const approvePlan = useWorkflowSessionStore((s) => s.approvePlan);
  const approveRevision = useWorkflowSessionStore((s) => s.approveRevision);
  const rejectRevision = useWorkflowSessionStore((s) => s.rejectRevision);
  const cancel = useWorkflowSessionStore((s) => s.cancel);
  const retryStep = useWorkflowSessionStore((s) => s.retryStep);
  const skipStep = useWorkflowSessionStore((s) => s.skipStep);
  const submitUserInput = useWorkflowSessionStore((s) => s.submitUserInput);
  const isBindingStale = useWorkflowSessionStore((s) => s.isBindingStale);
  const confirmWriteCompleted = useWorkflowSessionStore((s) => s.confirmWriteCompleted);

  const [selectedOption, setSelectedOption] = useState<string>('');
  const [selectedPlanningOption, setSelectedPlanningOption] = useState<string>('');

  const stale = useMemo(
    () => isBindingStale(props.sessions),
    // Re-check when session binding identity updates after plan/advance.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: session binding fingerprint
    [isBindingStale, props.sessions, session?.contextBinding, session?.updatedAt],
  );

  const handleGenerate = useCallback(() => {
    requestPlan(props.sessions);
  }, [props.sessions, requestPlan]);

  const handleEditGoal = useCallback(() => {
    cancel();
    useWorkflowSessionStore.setState({ session: null, planText: null });
  }, [cancel]);

  const handleOpenWritePanel = useCallback(() => {
    if (openPanelHint === 'patch') {
      usePatchApplyStore.getState().setPhase('idle');
    } else if (openPanelHint === 'review' || openPanelHint === 'comment') {
      useGithubReviewDraftStore.getState().setPhase('editing');
    }
  }, [openPanelHint]);

  const status = session?.status;
  const awaitingContext = status === 'AWAITING_CONTEXT_SELECTION';
  const awaitingRevision = status === 'AWAITING_REVISION_APPROVAL';
  const showGoalEditor =
    !session ||
    status === 'CANCELLED' ||
    status === 'FAILED' ||
    (!session && !pendingPlanGeneration);

  const awaitingApproval = status === 'AWAITING_PLAN_APPROVAL' || status === 'PLAN_READY';
  const running =
    status === 'RUNNING' ||
    status === 'AWAITING_CONFIRMATION' ||
    status === 'AWAITING_USER_INPUT' ||
    status === 'PAUSED' ||
    status === 'STALE';

  const assumptions = session?.plan.assumptions ?? [];
  const completionCriteria = session?.plan.completionCriteria ?? [];
  const unsupported = session?.agentGoal?.unsupportedRequests ?? [];
  const outcome = session?.outcome;
  const pendingRevision = session?.pendingRevision;
  const planningQuestion = session?.planningQuestions?.[0];

  return (
    <div
      className={cn('px-3 py-2.5', props.className)}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Agent Plan</p>

      {stale || status === 'STALE' ? (
        <p className="mt-1.5 rounded-md bg-icon px-2 py-1 text-[11px] text-[#b45309]" role="status">
          Context changed since this plan was bound. Cancel and regenerate, or approve a revision.
        </p>
      ) : null}

      {lastError ? (
        <p className="mt-1.5 text-[11px] text-[#e11d48]" role="alert">
          {lastError}
        </p>
      ) : null}

      {awaitingContext && planningQuestion ? (
        <div className="mt-2 space-y-1.5 rounded-md border border-border px-2 py-2">
          <p className="text-[11px] font-medium text-primary">{planningQuestion.question}</p>
          {(planningQuestion.options ?? []).map((opt) => (
            <label
              key={opt.id}
              className="flex cursor-pointer items-center gap-2 text-[11px] text-secondary"
            >
              <input
                type="radio"
                name="px-workflow-planning-select"
                value={opt.id}
                checked={selectedPlanningOption === opt.id}
                onChange={() => setSelectedPlanningOption(opt.id)}
              />
              <span>
                {opt.label}
                {opt.description ? (
                  <span className="block text-muted">{opt.description}</span>
                ) : null}
              </span>
            </label>
          ))}
          <button
            type="button"
            disabled={!selectedPlanningOption}
            onClick={() => {
              answerPlanningQuestion(selectedPlanningOption);
              setSelectedPlanningOption('');
            }}
            className="mt-1 w-full rounded-lg bg-icon px-2.5 py-1.5 text-left text-[12px] font-semibold text-primary hover:bg-hover disabled:opacity-50"
          >
            Continue
          </button>
          <button
            type="button"
            onClick={() => cancel()}
            className="w-full rounded-lg px-2.5 py-1 text-left text-[11px] font-medium text-muted hover:text-secondary"
          >
            Cancel
          </button>
        </div>
      ) : null}

      {(showGoalEditor || awaitingApproval) && !awaitingContext ? (
        <div className="mt-2">
          <label className="sr-only" htmlFor="px-workflow-goal">
            Workflow goal
          </label>
          <textarea
            id="px-workflow-goal"
            value={draftGoal}
            onChange={(e) => setGoal(e.target.value)}
            rows={3}
            disabled={pendingPlanGeneration || awaitingApproval}
            placeholder="e.g. Align this PR with PAY-321 and fix failing CI"
            className={cn(
              'w-full resize-none rounded-lg border border-border bg-icon px-2.5 py-2',
              'text-[12px] leading-4 text-primary placeholder:text-muted',
              'focus:outline-none focus:ring-1 focus:ring-border',
            )}
          />
          {!awaitingApproval ? (
            <button
              type="button"
              disabled={!draftGoal.trim() || pendingPlanGeneration}
              onClick={handleGenerate}
              className={cn(
                'mt-2 w-full rounded-lg px-2.5 py-1.5 text-left',
                'bg-icon text-[12px] font-semibold text-primary',
                'hover:bg-hover transition-colors disabled:opacity-50',
              )}
            >
              {pendingPlanGeneration ? 'Generating plan…' : 'Generate Plan'}
            </button>
          ) : null}
        </div>
      ) : null}

      {awaitingApproval && session ? (
        <div className="mt-2 space-y-2">
          <p className="text-[12px] font-medium leading-4 text-primary">{session.plan.summary}</p>

          {unsupported.length > 0 ? (
            <p className="rounded-md border border-border bg-icon px-2 py-1.5 text-[11px] leading-4 text-[#b45309]">
              Unsupported requests (out of scope): {unsupported.join(', ')}.
            </p>
          ) : null}

          {assumptions.length > 0 ? (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                Assumptions
              </p>
              <ul className="mt-1 space-y-0.5">
                {assumptions.map((item) => (
                  <li key={item} className="text-[11px] leading-4 text-secondary">
                    · {item}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {completionCriteria.length > 0 ? (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                Completion
              </p>
              <ul className="mt-1 space-y-0.5">
                {completionCriteria.map((c, i) => (
                  <li key={`${c.type}-${i}`} className="text-[11px] leading-4 text-secondary">
                    · {formatCriterion(c.type)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {hasWriteCheckpoint(session.plan.steps) ? (
            <p className="rounded-md border border-border bg-icon px-2 py-1.5 text-[11px] leading-4 text-secondary">
              Write checkpoints require your confirmation — Apply Fix / Submit Review never run
              automatically.
            </p>
          ) : null}
          <ol className="space-y-1">
            {session.plan.steps.map((step, index) => (
              <li
                key={step.id}
                className="rounded-md px-2 py-1.5 text-[11px] leading-4 text-secondary"
              >
                <span className="font-semibold text-primary">
                  {index + 1}. {step.title}
                </span>
                <span className="mt-0.5 block text-muted">
                  {step.type}
                  {step.mutationRisk === 'WRITE' ? ' · write' : ''}
                  {step.reason ? ` — ${step.reason}` : ''}
                </span>
              </li>
            ))}
          </ol>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => approvePlan()}
              className={cn(
                'flex-1 rounded-lg px-2.5 py-1.5',
                'bg-icon text-[12px] font-semibold text-primary hover:bg-hover',
              )}
            >
              Approve
            </button>
            <button
              type="button"
              onClick={handleEditGoal}
              className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-muted hover:text-secondary"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => cancel()}
              className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-muted hover:text-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {awaitingRevision && session && pendingRevision ? (
        <div className="mt-2 space-y-2">
          <p className="text-[12px] font-medium leading-4 text-primary">Updated plan</p>
          <p className="text-[11px] leading-4 text-secondary">{pendingRevision.summary}</p>
          {pendingRevision.removedRemainingSteps.length > 0 ? (
            <p className="text-[11px] text-muted">
              Removed: {pendingRevision.removedRemainingSteps.length} step(s)
            </p>
          ) : null}
          {pendingRevision.addedSteps.length > 0 ? (
            <ul className="space-y-0.5">
              {pendingRevision.addedSteps.map((step) => (
                <li key={step.id} className="text-[11px] text-secondary">
                  + {step.title}
                  {step.mutationRisk === 'WRITE' ? ' · write' : ''}
                </li>
              ))}
            </ul>
          ) : null}
          {revisionIntroducesWrite(pendingRevision.addedSteps) ? (
            <p className="rounded-md border border-border bg-icon px-2 py-1.5 text-[11px] leading-4 text-[#b45309]">
              This revision adds a write checkpoint. Approving it does not authorize the write.
            </p>
          ) : null}
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => approveRevision()}
              className="flex-1 rounded-lg bg-icon px-2.5 py-1.5 text-[12px] font-semibold text-primary hover:bg-hover"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => rejectRevision()}
              className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-muted hover:text-secondary"
            >
              Stop
            </button>
          </div>
        </div>
      ) : null}

      {running && session ? (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] text-muted">{session.status.replace(/_/g, ' ')}</p>
          <ul className="space-y-1">
            {session.plan.steps.map((step) => {
              const result = session.stepResults[step.id];
              const label = result?.status ?? step.status;
              return (
                <li
                  key={step.id}
                  className={cn(
                    'rounded-md px-2 py-1 text-[11px] leading-4',
                    session.currentStepId === step.id ? 'bg-icon' : '',
                  )}
                >
                  <span className="font-medium text-primary">{step.title}</span>
                  <span className="ml-1 text-muted">{label}</span>
                </li>
              );
            })}
          </ul>

          {status === 'AWAITING_CONFIRMATION' ? (
            <div className="space-y-1.5 rounded-md border border-border px-2 py-2">
              <p className="text-[11px] leading-4 text-secondary">
                Confirmation required. Use the existing Apply Fix / Review UI — nothing is written
                until you confirm there.
              </p>
              <button
                type="button"
                onClick={handleOpenWritePanel}
                className="w-full rounded-lg bg-icon px-2.5 py-1.5 text-left text-[12px] font-semibold text-primary hover:bg-hover"
              >
                Open {openPanelHint === 'patch' ? 'Apply Fix' : 'Review'} panel
              </button>
              <button
                type="button"
                onClick={() => confirmWriteCompleted()}
                className="w-full rounded-lg px-2.5 py-1 text-left text-[11px] font-medium text-muted hover:text-secondary"
              >
                Mark step done after confirming
              </button>
            </div>
          ) : null}

          {status === 'AWAITING_USER_INPUT' && userInput ? (
            <div className="space-y-1.5 rounded-md border border-border px-2 py-2">
              <p className="text-[11px] font-medium text-primary">{userInput.prompt}</p>
              {userInput.options.map((opt) => (
                <label
                  key={opt.id}
                  className="flex cursor-pointer items-center gap-2 text-[11px] text-secondary"
                >
                  <input
                    type="radio"
                    name="px-workflow-user-select"
                    value={opt.id}
                    checked={selectedOption === opt.id}
                    onChange={() => setSelectedOption(opt.id)}
                  />
                  {opt.label}
                </label>
              ))}
              <button
                type="button"
                disabled={!selectedOption}
                onClick={() => {
                  submitUserInput(selectedOption);
                  setSelectedOption('');
                }}
                className="mt-1 w-full rounded-lg bg-icon px-2.5 py-1.5 text-left text-[12px] font-semibold text-primary hover:bg-hover disabled:opacity-50"
              >
                Continue
              </button>
            </div>
          ) : null}

          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => cancel()}
              className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-muted hover:text-secondary"
            >
              Stop
            </button>
            <button
              type="button"
              onClick={() => retryStep()}
              className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-muted hover:text-secondary"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => skipStep()}
              className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-muted hover:text-secondary"
            >
              Skip
            </button>
          </div>
        </div>
      ) : null}

      {(status === 'COMPLETED' ||
        status === 'NEEDS_ATTENTION' ||
        status === 'FAILED' ||
        status === 'CANCELLED') &&
      session ? (
        <div className="mt-2 space-y-2">
          <p className="text-[12px] font-medium text-primary">
            {status === 'COMPLETED'
              ? 'Goal achieved'
              : status === 'NEEDS_ATTENTION'
                ? 'Needs attention'
                : status === 'FAILED'
                  ? 'Flow failed'
                  : 'Cancelled'}
          </p>
          {outcome ? (
            <div className="space-y-1 rounded-md border border-border px-2 py-1.5">
              <p className="text-[11px] leading-4 text-secondary">{outcome.summary}</p>
              {outcome.satisfiedCriteria.length > 0 ? (
                <p className="text-[10px] text-muted">
                  Done: {outcome.satisfiedCriteria.join(' · ')}
                </p>
              ) : null}
              {outcome.unsatisfiedCriteria.length > 0 ? (
                <p className="text-[10px] text-[#b45309]">
                  Remaining: {outcome.unsatisfiedCriteria.join(' · ')}
                </p>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            onClick={handleEditGoal}
            className="w-full rounded-lg bg-icon px-2.5 py-1.5 text-left text-[12px] font-semibold text-primary hover:bg-hover"
          >
            New goal
          </button>
        </div>
      ) : null}
    </div>
  );
}

function hasWriteCheckpoint(steps: DeveloperWorkflowStep[]): boolean {
  return steps.some(
    (s) => s.mutationRisk === 'WRITE' || s.executionMode === 'EXPLICIT_CONFIRMATION',
  );
}

function revisionIntroducesWrite(steps: DeveloperWorkflowStep[]): boolean {
  return steps.some((s) => s.mutationRisk === 'WRITE');
}

function formatCriterion(type: string): string {
  switch (type) {
    case 'ANALYSIS_PRESENTED':
      return 'Analysis presented';
    case 'PR_REVIEW_COMPLETED':
      return 'PR review completed';
    case 'PATCH_PREPARED':
      return 'Patch prepared';
    case 'PATCH_APPLIED':
      return 'Patch applied';
    case 'CI_CHECK_VERIFIED':
      return 'CI check verified';
    case 'REVIEW_DRAFT_PREPARED':
      return 'Review draft prepared';
    case 'REVIEW_SUBMITTED':
      return 'Review submitted';
    default:
      return type;
  }
}
