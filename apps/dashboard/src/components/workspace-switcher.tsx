'use client';

import { type FormEvent, useEffect, useId, useRef, useState } from 'react';

import { ApiError } from '../lib/api';
import { useWorkspace } from '../lib/workspace-context';

function apiMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function WorkspaceSwitcher() {
  const { ready, workspaces, current, switchWorkspace, createWorkspace } = useWorkspace();
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setCreating(false);
        setError(null);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        setCreating(false);
        setError(null);
      }
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function onSelect(workspaceId: string) {
    if (workspaceId === current?.workspace.id) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await switchWorkspace(workspaceId);
      setOpen(false);
      setCreating(false);
    } catch (err) {
      setError(apiMessage(err, 'Unable to switch workspace.'));
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createWorkspace(name);
      setName('');
      setCreating(false);
      setOpen(false);
    } catch (err) {
      setError(apiMessage(err, 'Unable to create workspace.'));
    } finally {
      setBusy(false);
    }
  }

  const label = !ready
    ? 'Loading…'
    : (current?.workspace.name ?? workspaces[0]?.name ?? 'Workspace');

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={!ready || busy}
        onClick={() => setOpen((prev) => !prev)}
        className="flex max-w-[220px] items-center gap-2 rounded-xl border border-line bg-panel/70 px-3 py-1.5 text-left transition hover:bg-panel disabled:opacity-60"
      >
        <span className="min-w-0">
          <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Workspace
          </span>
          <span className="block truncate font-display text-sm font-semibold tracking-tight text-ink">
            {label}
          </span>
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden
          className="ml-auto shrink-0 text-muted-foreground"
        >
          <path
            d="M2.5 4.25 6 7.75l3.5-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <div
          id={listboxId}
          role="listbox"
          className="absolute left-0 top-[calc(100%+6px)] z-40 w-[260px] overflow-hidden rounded-2xl border border-line bg-panel shadow-panel"
        >
          <ul className="max-h-56 overflow-y-auto p-1.5">
            {workspaces.map((workspace) => {
              const active = workspace.id === current?.workspace.id;
              return (
                <li key={workspace.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    disabled={busy}
                    onClick={() => void onSelect(workspace.id)}
                    className={[
                      'flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-sm transition',
                      active ? 'bg-accent-soft text-ink' : 'text-ink hover:bg-mist',
                    ].join(' ')}
                  >
                    <span className="min-w-0 truncate font-semibold">{workspace.name}</span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {workspace.role}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="border-t border-line/80 p-2">
            {creating ? (
              <form onSubmit={onCreate} className="space-y-2">
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Workspace name"
                  className="w-full rounded-xl border border-line bg-mist px-3 py-2 text-sm font-semibold text-ink outline-none ring-accent/30 focus:ring-2"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={busy || !name.trim()}
                    className="rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-inverse disabled:opacity-50"
                  >
                    {busy ? 'Creating…' : 'Create'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setCreating(false);
                      setName('');
                      setError(null);
                    }}
                    className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setCreating(true)}
                className="w-full rounded-xl px-3 py-2 text-left text-sm font-semibold text-ink transition hover:bg-mist"
              >
                Create workspace
              </button>
            )}
            {error ? (
              <p className="mt-2 px-1 text-xs text-red-600 dark:text-red-400">{error}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
