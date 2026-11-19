/**
 * The Reliability page is read-only: dashboard-side Resume / Replay / Retry only created
 * execution records that nothing executed, so they are not offered (recovery happens in the
 * extension's Workflow panel). Inspection of existing records is preserved.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { WorkflowExecution, WorkflowExecutionDetail } from '@project-x/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { api } = vi.hoisted(() => ({
  api: {
    listWorkflowExecutions: vi.fn(),
    getWorkflowExecution: vi.fn(),
    resumeWorkflowExecution: vi.fn(),
    previewWorkflowReplay: vi.fn(),
    replayWorkflowExecution: vi.fn(),
    retryWorkflowExecution: vi.fn(),
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a href={href} {...rest}>
      {children as never}
    </a>
  ),
}));
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked: Record<string, unknown> = {};
  for (const name of Object.keys(api)) {
    mocked[name] = (...args: unknown[]) => api[name as keyof typeof api](...args);
  }
  return { ...actual, ...mocked };
});

import ReliabilityPage from './page';

const execution: WorkflowExecution = {
  id: 'exe_1',
  workflowId: 'wf_1',
  executionNumber: 1,
  trigger: 'user',
  startedAt: '2026-11-19T10:00:00.000Z',
  completedAt: '2026-11-19T10:00:05.000Z',
  status: 'failed',
  healthScore: 70,
  healthBand: 'Warning',
  durationMs: 5000,
  contextVersion: { repository: 'acme/app', prNumber: 7 },
  goal: 'Review PR and draft comments',
  resumeAvailable: true,
  replayAvailable: true,
  artifactCount: 0,
  failureCount: 1,
  retryCount: 0,
};
const detail = {
  ...execution,
  timeline: [
    { type: 'WORKFLOW_STARTED', label: 'Workflow started', timestamp: execution.startedAt },
  ],
  checkpoints: [
    {
      id: 'cp_1',
      kind: 'PLANNING_COMPLETE',
      label: 'Planning Complete',
      createdAt: execution.startedAt,
      state: {},
    },
  ],
  failures: [{ category: 'TIMEOUT', retryable: true, userMessage: 'The AI request timed out.' }],
  lineage: { nodes: [], edges: [] },
  aiRequests: [],
  events: [],
  health: { score: 70, band: 'Warning' },
} as unknown as WorkflowExecutionDetail;

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(() => cleanup());

describe('Reliability page (read-only)', () => {
  it('empty state explains what appears here and points PR reviews to Review history', async () => {
    api.listWorkflowExecutions.mockResolvedValue([]);
    render(<ReliabilityPage />);
    expect(await screen.findByText('No workflow runs yet')).toBeTruthy();
    expect(screen.getByText(/Runs started from the Workflow tab/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Review history' }).getAttribute('href')).toBe(
      '/app/reviews',
    );
    expect(screen.queryByText(/No workflows yet/)).toBeNull();
  });

  it('existing executions can still be inspected', async () => {
    api.listWorkflowExecutions.mockResolvedValue([execution]);
    api.getWorkflowExecution.mockResolvedValue(detail);
    render(<ReliabilityPage />);
    expect(await screen.findByText('Planning Complete')).toBeTruthy();
    expect(screen.getAllByText('Review PR and draft comments').length).toBeGreaterThan(0);
    expect(screen.getByText('Workflow started')).toBeTruthy();
    expect(screen.getByText(/The AI request timed out/)).toBeTruthy();
    expect(api.getWorkflowExecution).toHaveBeenCalledWith('exe_1');
  });

  it('offers no Resume, Replay or Retry controls and never calls those endpoints', async () => {
    api.listWorkflowExecutions.mockResolvedValue([execution]);
    api.getWorkflowExecution.mockResolvedValue(detail);
    render(<ReliabilityPage />);
    await screen.findByText('Planning Complete');
    for (const name of [/^Resume$/, /Preview replay/, /^Replay$/, /Retry AI/]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    // The only buttons are list navigation (Refresh + execution rows).
    expect(
      screen
        .getAllByRole('button')
        .map((b) => b.textContent)
        .some((t) => /resume|replay|retry/i.test(t ?? '')),
    ).toBe(false);
    await waitFor(() => expect(api.listWorkflowExecutions).toHaveBeenCalledTimes(1));
    expect(api.resumeWorkflowExecution).not.toHaveBeenCalled();
    expect(api.previewWorkflowReplay).not.toHaveBeenCalled();
    expect(api.replayWorkflowExecution).not.toHaveBeenCalled();
    expect(api.retryWorkflowExecution).not.toHaveBeenCalled();
    // Copy no longer promises recovery from the dashboard.
    expect(screen.getByText(/Resume and replay a run from the extension/)).toBeTruthy();
  });
});
