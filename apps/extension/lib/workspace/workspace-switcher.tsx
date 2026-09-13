import { useEffect, type CSSProperties, type ChangeEvent } from 'react';

import { useWorkspaceStore } from './workspace.store';

type WorkspaceSwitcherProps = {
  /** When true, bootstrap on mount if not yet loaded. */
  autoBootstrap?: boolean;
  style?: CSSProperties;
};

/**
 * Subtle workspace label + switcher for the extension popup.
 * Hidden noise when only one workspace exists (still shows the name).
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

  useEffect(() => {
    if (!autoBootstrap || bootstrapped || loading) {
      return;
    }
    void bootstrap();
  }, [autoBootstrap, bootstrapped, loading, bootstrap]);

  if (loading && !bootstrapped) {
    return <p style={{ ...metaStyle, ...props.style }}>Loading workspace…</p>;
  }

  if (!current) {
    return error ? <p style={{ ...errorStyle, ...props.style }}>{error}</p> : null;
  }

  const showSwitcher = workspaces.length > 1;

  return (
    <div style={{ marginTop: 12, ...props.style }}>
      <p style={labelStyle}>Workspace</p>
      {showSwitcher ? (
        <select
          aria-label="Current workspace"
          disabled={switching}
          value={currentWorkspaceId ?? current.workspace.id}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => {
            void switchWorkspace(event.target.value);
          }}
          style={selectStyle}
        >
          {workspaces.map((ws) => (
            <option key={ws.id} value={ws.id}>
              {ws.name}
            </option>
          ))}
        </select>
      ) : (
        <p style={nameStyle}>{current.workspace.name}</p>
      )}
      <p style={metaStyle}>
        {current.plan.name}
        {current.membership.role ? ` · ${current.membership.role}` : ''}
      </p>
      {error ? <p style={errorStyle}>{error}</p> : null}
    </div>
  );
}

const labelStyle: CSSProperties = {
  margin: 0,
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: '#64748b',
};

const nameStyle: CSSProperties = {
  margin: '4px 0 0',
  fontSize: 13,
  fontWeight: 600,
  color: '#0f172a',
};

const selectStyle: CSSProperties = {
  marginTop: 4,
  width: '100%',
  boxSizing: 'border-box',
  borderRadius: 10,
  border: '1px solid #cbd5e1',
  padding: '7px 10px',
  fontSize: 13,
  background: '#fff',
  color: '#0f172a',
};

const metaStyle: CSSProperties = {
  margin: '4px 0 0',
  fontSize: 11,
  color: '#64748b',
};

const errorStyle: CSSProperties = {
  margin: '6px 0 0',
  fontSize: 11,
  color: '#b91c1c',
};
