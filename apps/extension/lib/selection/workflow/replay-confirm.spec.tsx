/**
 * Replay re-runs AI steps, so it needs an explicit confirmation. Cancel sends nothing; confirm
 * sends exactly one Replay request even when clicked repeatedly. No real API or AI calls.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkflowStepType as Step, type DeveloperWorkflowPlan } from '@project-x/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { replayApi } = vi.hoisted(() => ({ replayApi: vi.fn() }));
vi.mock('../../api/reliability', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    replayReliabilityExecution: (...args: unknown[]) => replayApi(...args),
    appendWorkflowAuditEvent: vi.fn(async () => undefined),
  };
});

import { ReplayConfirm } from './replay-confirm';
import { AI_WORKFLOW_STEP_TYPES, countAiSteps } from './workflow-handlers';
import { WorkflowPanel } from './workflow-panel';
import { useWorkflowSessionStore } from './workflow.store';

const step = (id: string, type: Step) => ({
  id,
  type,
  title: id,
  description: id,
  reason: id,
  dependencies: [],
  requiredContext: [],
  executionMode: 'AUTO_READ' as const,
  mutationRisk: 'NONE' as const,
  status: 'FAILED' as const,
});
const plan = {
  id: 'plan-1',
  goal: 'Review PR and draft comments',
  summary: 's',
  assumptions: [],
  completionCriteria: [],
  confidence: 'MEDIUM',
  steps: [
    step('s1', Step.BUILD_ENGINEERING_CONTEXT),
    step('s2', Step.REVIEW_PULL_REQUEST),
    step('s3', Step.SUGGEST_FIX),
    step('s4', Step.CREATE_REVIEW_DRAFT),
  ],
} as unknown as DeveloperWorkflowPlan;

function failedSession() {
  const now = new Date().toISOString();
  useWorkflowSessionStore.setState({
    session: {
      id: 'wf-1',
      goal: 'Review PR and draft comments',
      createdAt: now,
      updatedAt: now,
      contextBinding: { github: { repository: 'acme/app', prNumber: 7, headSha: 'abc' } },
      status: 'FAILED',
      plan,
      planHistory: [],
      stepResults: {},
      artifacts: {},
      facts: [],
      budget: { aiCalls: { used: 2, max: 6 } },
      execution: {},
    } as never,
    // Steps must not actually run in these tests.
    advance: vi.fn(),
    replayPending: false,
    lastError: null,
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const replayResult = {
  execution: { id: 'exe_2', workflowId: 'wf-1' },
  drift: { hasDrift: false, summary: '', fields: [] },
};

beforeEach(() => {
  replayApi.mockReset();
  useWorkflowSessionStore.getState().clear();
});
afterEach(() => cleanup());

describe('AI step detection', () => {
  it('counts only steps that call the AI', () => {
    expect(countAiSteps(plan.steps)).toBe(2);
    expect(AI_WORKFLOW_STEP_TYPES.has(Step.CREATE_REVIEW_DRAFT)).toBe(false);
    expect(AI_WORKFLOW_STEP_TYPES.has(Step.SUBMIT_PR_COMMENT)).toBe(false);
  });
});

describe('ReplayConfirm', () => {
  function setup(pending = false) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ReplayConfirm
        goal="Review PR and draft comments"
        binding={{ github: { repository: 'acme/app', prNumber: 7, headSha: 'abc' } }}
        totalSteps={4}
        aiSteps={2}
        pending={pending}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    return { onConfirm, onCancel, dialog: screen.getByRole('alertdialog') };
  }

  it('names the workflow and warns about AI usage, without claiming an exact cost', () => {
    const { dialog } = setup();
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(screen.getByText('Replay this workflow?')).toBeTruthy();
    expect(screen.getByText('acme/app #7')).toBeTruthy();
    expect(screen.getByText(/2 AI steps will call the AI again/)).toBeTruthy();
    expect(screen.getByText(/exact usage depends/)).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/\$|credits? cost/i);
  });

  it('focuses Cancel by default; Escape and Cancel cancel', () => {
    const { onCancel, dialog } = setup();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('cannot be confirmed again while a replay is starting', () => {
    const { onConfirm } = setup(true);
    const confirm = screen.getByRole('button', { name: 'Starting replay…' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('workflow store replay', () => {
  it('concurrent replay calls send exactly one request', async () => {
    failedSession();
    const pending = deferred<typeof replayResult>();
    replayApi.mockReturnValue(pending.promise);
    const store = useWorkflowSessionStore.getState();
    const first = store.replayExecution('exe_1');
    const second = store.replayExecution('exe_1');
    expect(await second).toBe(false);
    pending.resolve(replayResult);
    expect(await first).toBe(true);
    expect(replayApi).toHaveBeenCalledTimes(1);
    expect(useWorkflowSessionStore.getState().replayPending).toBe(false);
  });
});

describe('Workflow panel Replay', () => {
  function renderPanel() {
    failedSession();
    // Panel replays the session's last execution.
    vi.spyOn(useWorkflowSessionStore.getState(), 'replayExecution');
    render(<WorkflowPanel sessions={{} as never} />);
  }

  it('Replay asks first; Cancel sends no request', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    expect(screen.getByRole('alertdialog', { name: 'Replay this workflow?' })).toBeTruthy();
    expect(screen.getByText(/2 AI steps will call the AI again/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(replayApi).not.toHaveBeenCalled();
  });

  it('Confirm sends exactly one Replay request, even on a double click', async () => {
    renderPanel();
    const pending = deferred<typeof replayResult>();
    replayApi.mockReturnValue(pending.promise);
    useWorkflowSessionStore.setState({ replayPending: false });
    // The panel replays the last known execution; provide one through the store API.
    const original = useWorkflowSessionStore.getState().replayExecution;
    useWorkflowSessionStore.setState({ replayExecution: (id?: string) => original(id ?? 'exe_1') });
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    const confirm = screen.getByRole('button', { name: 'Replay workflow' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await act(async () => {
      pending.resolve(replayResult);
      await pending.promise;
    });
    expect(replayApi).toHaveBeenCalledTimes(1);
  });
});
