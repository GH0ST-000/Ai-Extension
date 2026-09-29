import { useEffect, useId, useRef, useState } from 'react';

import { useWorkspaceStore } from './workspace.store';

type WorkspaceSwitcherProps = {
  /** When true, bootstrap on mount if not yet loaded. */
  autoBootstrap?: boolean;
  className?: string;
};

/**
 * Workspace card + custom listbox for the extension popup.
 * Avoids native `<select>` menus (OS chrome looks out of place in dark UI).
 */
export function WorkspaceSwitcher(props: WorkspaceSwitcherProps) {
  const autoBootstrap = props.autoBootstrap !== false;
  const bootstrapped = useWorkspaceStore((s) => s.bootstrapped);
  const loading = useWorkspaceStore((s) => s.loading);
  const switching = useWorkspaceStore((s) => s.switching);
  const error = useWorkspaceStore((s) => s.error);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const current = useWorkspaceStore((s) => s.current);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const bootstrap = useWorkspaceStore((s) => s.bootstrap);
  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);

  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!autoBootstrap || bootstrapped || loading) {
      return;
    }
    void bootstrap();
  }, [autoBootstrap, bootstrapped, loading, bootstrap]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (loading && !bootstrapped) {
    return <p className={`text-[11px] text-muted ${props.className ?? ''}`}>Loading workspace…</p>;
  }

  if (!current) {
    return error ? (
      <p className={`text-[11px] text-red-500 ${props.className ?? ''}`}>{error}</p>
    ) : null;
  }

  const showSwitcher = workspaces.length > 1;
  const activeId = currentWorkspaceId ?? current.workspace.id;

  async function onSelect(workspaceId: string) {
    if (workspaceId === activeId) {
      setOpen(false);
      return;
    }
    try {
      await switchWorkspace(workspaceId);
      setOpen(false);
    } catch {
      // Store surfaces error state
    }
  }

  return (
    <div
      ref={rootRef}
      className={`relative rounded-3xl border border-border bg-surface p-3.5 ${open ? 'z-50' : ''} ${props.className ?? ''}`}
    >
      <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted">Workspace</p>

      {showSwitcher ? (
        <>
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={listboxId}
            disabled={switching}
            onClick={() => setOpen((prev) => !prev)}
            className="mt-1.5 flex w-full items-center gap-2 rounded-2xl border border-border bg-elevated px-3 py-2.5 text-left transition hover:border-accent/35 hover:bg-hover disabled:opacity-60"
          >
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold tracking-tight text-primary">
              {current.workspace.name}
            </span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              aria-hidden
              className={[
                'shrink-0 text-muted transition',
                open ? 'rotate-180 text-accent' : '',
              ].join(' ')}
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
              aria-label="Workspaces"
              className="absolute inset-x-2 top-[calc(100%-2px)] z-50 overflow-hidden rounded-2xl border border-border bg-elevated shadow-menu"
            >
              <ul className="max-h-44 overflow-y-auto p-1.5">
                {workspaces.map((ws) => {
                  const active = ws.id === activeId;
                  return (
                    <li key={ws.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        disabled={switching}
                        onClick={() => void onSelect(ws.id)}
                        className={[
                          'flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[12.5px] transition',
                          active
                            ? 'bg-accent-soft font-semibold text-accent'
                            : 'font-medium text-primary hover:bg-hover',
                        ].join(' ')}
                      >
                        <span
                          className={[
                            'flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px]',
                            active
                              ? 'bg-accent text-[#042f2e]'
                              : 'border border-border text-transparent',
                          ].join(' ')}
                          aria-hidden
                        >
                          {active ? '✓' : ''}
                        </span>
                        <span className="min-w-0 truncate">{ws.name}</span>
                        {'role' in ws && ws.role ? (
                          <span className="ml-auto shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted">
                            {String(ws.role)}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <p className="mt-1 truncate text-[13px] font-semibold tracking-tight text-primary">
          {current.workspace.name}
        </p>
      )}

      <p className="mt-1 text-[11px] text-muted">
        {current.plan.name}
        {current.membership.role ? ` · ${current.membership.role}` : ''}
      </p>
      {error ? <p className="mt-1.5 text-[11px] text-red-500">{error}</p> : null}
    </div>
  );
}
