'use client';

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../../lib/api';
import {
  deleteWorkspace,
  listPendingDeletions,
  type PendingWorkspaceDeletion,
} from '../../lib/workspace-api';

/**
 * N-2: workspaces the user owns that are stuck in deletion (billing cancellation not yet
 * confirmed). They are never shown as normal workspaces; this notice lets the owner see them
 * and retry the deletion (the server also retries automatically). Renders nothing when there
 * are none.
 */
export function PendingDeletionsNotice() {
  const [items, setItems] = useState<PendingWorkspaceDeletion[]>([]);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await listPendingDeletions());
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function retry(workspaceId: string) {
    if (retrying) return;
    setRetrying(workspaceId);
    setMessage(null);
    setError(null);
    try {
      await deleteWorkspace(workspaceId);
      setMessage('Workspace deleted. Billing was cancelled.');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Deletion could not be completed yet. Project X keeps retrying automatically.',
      );
    } finally {
      setRetrying(null);
      await load();
    }
  }

  if (items.length === 0 && !message) return null;

  return (
    <section
      aria-labelledby="pending-deletions-title"
      className="space-y-3 rounded-3xl border border-line bg-panel/75 px-5 py-4 shadow-panel"
    >
      <h2 id="pending-deletions-title" className="font-display text-lg font-semibold text-ink">
        Workspaces pending deletion
      </h2>
      <p className="text-sm text-muted-foreground">
        These workspaces are no longer usable. Deletion finishes once the billing provider confirms
        the subscription is cancelled — Project X retries automatically, or you can retry now.
      </p>
      {message ? (
        <p role="status" className="text-sm text-ink">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <ul className="divide-y divide-line/80">
        {items.map((item) => (
          <li
            key={item.workspaceId}
            className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">{item.name}</p>
              <p className="text-xs text-muted-foreground">
                {item.openCancellations > 0
                  ? 'Waiting for the billing provider to confirm the cancellation.'
                  : 'Ready to finish.'}
              </p>
            </div>
            <button
              type="button"
              disabled={retrying !== null}
              onClick={() => void retry(item.workspaceId)}
              aria-label={`Retry deleting ${item.name}`}
              className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-ink disabled:opacity-50"
            >
              {retrying === item.workspaceId ? 'Retrying…' : 'Retry deletion'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
