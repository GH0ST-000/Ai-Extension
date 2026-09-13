'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ApiError } from '../../../lib/api';
import { useWorkspace } from '../../../lib/workspace-context';
import { deleteWorkspace, updateWorkspace } from '../../../lib/workspace-api';

function apiMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export default function WorkspaceSettingsPage() {
  const router = useRouter();
  const { ready, current, refresh, hasPermission, switchWorkspace, workspaces } = useWorkspace();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workspace = current?.workspace ?? null;
  const canUpdate = hasPermission('workspace:update');
  const canDelete = hasPermission('workspace:delete');

  useEffect(() => {
    setName(workspace?.name ?? '');
    setConfirmDelete('');
    setMessage(null);
    setError(null);
  }, [workspace?.id, workspace?.name]);

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || !canUpdate) {
      return;
    }

    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      await updateWorkspace(workspace.id, { name: name.trim() });
      await refresh();
      setMessage('Workspace updated.');
    } catch (err) {
      setError(apiMessage(err, 'Unable to update workspace.'));
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!workspace || !canDelete) {
      return;
    }
    if (confirmDelete.trim() !== workspace.name) {
      setError('Type the workspace name to confirm deletion.');
      return;
    }

    setDeleting(true);
    setMessage(null);
    setError(null);
    try {
      await deleteWorkspace(workspace.id);
      const fallback = workspaces.find((item) => item.id !== workspace.id);
      if (fallback) {
        await switchWorkspace(fallback.id);
      } else {
        await refresh();
      }
      setMessage('Workspace deleted.');
      router.replace('/app');
    } catch (err) {
      setError(apiMessage(err, 'Unable to delete workspace.'));
    } finally {
      setDeleting(false);
    }
  }

  if (!ready) {
    return (
      <div className="rounded-3xl border border-line bg-panel/75 px-5 py-8 text-sm text-muted-foreground shadow-panel">
        Loading workspace…
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="rounded-3xl border border-line bg-panel/75 px-5 py-8 text-sm text-red-600 dark:text-red-400 shadow-panel">
        No workspace selected.
      </div>
    );
  }

  const dirty = name.trim() !== workspace.name && name.trim().length > 0;

  return (
    <div className="space-y-8">
      <header className="rise-in">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
          Workspace
        </p>
        <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight text-ink">
          General
        </h1>
        <p className="mt-3 max-w-xl text-base text-muted-foreground">
          Rename this workspace or soft-delete it. Soft delete revokes access; hard purge is out of
          scope.
        </p>
      </header>

      <section className="rise-in-delay-1 space-y-3">
        <h2 className="px-1 font-display text-lg font-semibold tracking-tight">Details</h2>
        <form
          onSubmit={onSave}
          className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel"
        >
          <div className="flex flex-col gap-3 border-b border-line/80 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-ink">Name</p>
              <p className="mt-0.5 text-sm text-muted-foreground">Shown in the switcher and nav.</p>
            </div>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={!canUpdate || saving}
              className="w-full max-w-xs rounded-xl border border-line bg-mist px-3 py-2 text-sm font-semibold text-ink outline-none ring-accent/30 focus:ring-2 disabled:opacity-60"
            />
          </div>

          <div className="flex flex-col gap-3 border-b border-line/80 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-ink">Slug</p>
              <p className="mt-0.5 text-sm text-muted-foreground">Stable identifier for URLs.</p>
            </div>
            <p className="font-mono text-sm text-muted-foreground">{workspace.slug}</p>
          </div>

          <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-ink">Workspace ID</p>
              <p className="mt-0.5 text-sm text-muted-foreground">For support and debugging.</p>
            </div>
            <p className="break-all font-mono text-xs text-muted-foreground">{workspace.id}</p>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-line/80 bg-mist/50 px-5 py-4">
            <button
              type="submit"
              disabled={!canUpdate || saving || !dirty}
              className="rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            {message ? <p className="text-sm text-accent">{message}</p> : null}
            {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
            {!canUpdate ? (
              <p className="text-sm text-muted-foreground">You need update permission to edit.</p>
            ) : null}
          </div>
        </form>
      </section>

      {canDelete ? (
        <section className="rise-in-delay-1 space-y-3">
          <h2 className="px-1 font-display text-lg font-semibold tracking-tight">Delete</h2>
          <div className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel">
            <div className="space-y-3 px-5 py-4">
              <p className="text-sm text-muted-foreground">
                Soft-deletes the workspace and revokes access. Type{' '}
                <span className="font-semibold text-ink">{workspace.name}</span> to confirm.
              </p>
              <input
                value={confirmDelete}
                onChange={(event) => setConfirmDelete(event.target.value)}
                placeholder={workspace.name}
                className="w-full max-w-md rounded-xl border border-line bg-mist px-3 py-2 text-sm font-semibold text-ink outline-none ring-accent/30 focus:ring-2"
              />
            </div>
            <div className="border-t border-line/80 bg-mist/50 px-5 py-4">
              <button
                type="button"
                disabled={deleting || confirmDelete.trim() !== workspace.name}
                onClick={() => void onDelete()}
                className="rounded-xl border border-line bg-panel px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete workspace'}
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
