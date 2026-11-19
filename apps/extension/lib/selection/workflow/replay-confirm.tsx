import { type KeyboardEvent, useEffect, useId, useRef } from 'react';
import type { WorkflowContextBinding } from '@project-x/types';

type ReplayConfirmProps = {
  goal: string;
  binding: WorkflowContextBinding;
  totalSteps: number;
  /** Steps that call the AI (see AI_WORKFLOW_STEP_TYPES). */
  aiSteps: number;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Explicit confirmation before Replay, which runs every step again — AI steps make new,
 * metered AI requests. A UX safeguard only: each AI request is still authorized and
 * usage-limited by the API, and GitHub writes still pause for their own confirmation.
 */
export function ReplayConfirm({
  goal,
  binding,
  totalSteps,
  aiSteps,
  pending,
  onConfirm,
  onCancel,
}: ReplayConfirmProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Safe default: focus Cancel, so Enter / Space never replays by accident.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const context = [
    binding.github ? `${binding.github.repository} #${binding.github.prNumber}` : null,
    binding.jira ? binding.jira.issueKey : null,
  ].filter(Boolean);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !pending) {
      event.stopPropagation();
      onCancel();
    }
  }

  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={onKeyDown}
      className="space-y-2 rounded-lg border border-border bg-surface/80 px-2.5 py-2"
    >
      <p id={titleId} className="text-[12px] font-semibold text-primary">
        Replay this workflow?
      </p>
      <div id={descriptionId} className="space-y-1 text-[11px] leading-4 text-secondary">
        <p className="break-words font-medium text-primary">{goal}</p>
        {context.length > 0 ? <p className="break-all font-mono">{context.join(' · ')}</p> : null}
        <p>
          Replay runs all {totalSteps} step{totalSteps === 1 ? '' : 's'} again from the start.
        </p>
        {aiSteps > 0 ? (
          <p className="font-medium text-primary">
            {aiSteps} AI step{aiSteps === 1 ? '' : 's'} will call the AI again and use your
            workspace&apos;s AI usage. The exact usage depends on each step&apos;s input.
          </p>
        ) : (
          <p>This plan has no AI steps.</p>
        )}
        <p>GitHub comments and reviews still wait for your confirmation before posting.</p>
      </div>
      <div className="flex gap-1">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="flex-1 rounded-lg border border-border px-2.5 py-1.5 text-[12px] font-medium text-secondary hover:text-primary disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          aria-busy={pending}
          className="flex-1 rounded-lg bg-icon px-2.5 py-1.5 text-[12px] font-semibold text-primary hover:bg-hover disabled:opacity-50"
        >
          {pending ? 'Starting replay…' : 'Replay workflow'}
        </button>
      </div>
    </div>
  );
}
