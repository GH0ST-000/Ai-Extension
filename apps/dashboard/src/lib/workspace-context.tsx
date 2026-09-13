'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  CurrentWorkspaceContext,
  ProductEntitlements,
  WorkspaceBootstrapResponse,
  WorkspacePermission,
  WorkspaceRole,
} from '@project-x/types';

import { ApiError, setWorkspaceIdGetter } from './api';
import { bootstrapWorkspaces, createWorkspace as createWorkspaceRequest } from './workspace-api';

const STORAGE_KEY = 'project-x.dashboard.workspaceId';

export type WorkspaceListItem = WorkspaceBootstrapResponse['workspaces'][number];

type WorkspaceContextValue = {
  ready: boolean;
  error: string | null;
  user: WorkspaceBootstrapResponse['user'] | null;
  workspaces: WorkspaceListItem[];
  current: CurrentWorkspaceContext | null;
  currentWorkspaceId: string | null;
  entitlements: ProductEntitlements | null;
  role: WorkspaceRole | null;
  permissions: WorkspacePermission[];
  /** Increments when the active workspace changes so scoped UI can remount. */
  workspaceRevision: number;
  switchWorkspace: (workspaceId: string) => Promise<void>;
  refresh: () => Promise<void>;
  createWorkspace: (name: string, slug?: string) => Promise<void>;
  hasPermission: (permission: WorkspacePermission) => boolean;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function readStoredWorkspaceId(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function writeStoredWorkspaceId(workspaceId: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    if (workspaceId) {
      window.localStorage.setItem(STORAGE_KEY, workspaceId);
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore quota / private mode
  }
}

function apiMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<WorkspaceBootstrapResponse['user'] | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[]>([]);
  const [current, setCurrent] = useState<CurrentWorkspaceContext | null>(null);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);

  const currentWorkspaceIdRef = useRef<string | null>(null);

  const applyBootstrap = useCallback((payload: WorkspaceBootstrapResponse) => {
    const nextId = payload.current.workspace.id;
    const previousId = currentWorkspaceIdRef.current;
    currentWorkspaceIdRef.current = nextId;
    writeStoredWorkspaceId(nextId);
    setUser(payload.user);
    setWorkspaces(payload.workspaces);
    setCurrent(payload.current);
    if (previousId && previousId !== nextId) {
      setWorkspaceRevision((value) => value + 1);
    }
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const payload = await bootstrapWorkspaces();
      applyBootstrap(payload);
    } catch (err) {
      setError(apiMessage(err, 'Unable to load workspaces.'));
      throw err;
    }
  }, [applyBootstrap]);

  useEffect(() => {
    currentWorkspaceIdRef.current = readStoredWorkspaceId();
    setWorkspaceIdGetter(() => currentWorkspaceIdRef.current);

    let cancelled = false;

    async function load() {
      try {
        const payload = await bootstrapWorkspaces();
        if (cancelled) {
          return;
        }
        applyBootstrap(payload);
      } catch (err) {
        if (!cancelled) {
          setError(apiMessage(err, 'Unable to load workspaces.'));
        }
      } finally {
        if (!cancelled) {
          setReady(true);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
      setWorkspaceIdGetter(null);
    };
  }, [applyBootstrap]);

  const switchWorkspace = useCallback(
    async (workspaceId: string) => {
      const nextId = workspaceId.trim();
      if (!nextId || nextId === currentWorkspaceIdRef.current) {
        return;
      }

      const previousId = currentWorkspaceIdRef.current;
      currentWorkspaceIdRef.current = nextId;
      writeStoredWorkspaceId(nextId);
      setWorkspaceRevision((value) => value + 1);
      setError(null);

      try {
        const payload = await bootstrapWorkspaces();
        applyBootstrap(payload);
      } catch (err) {
        currentWorkspaceIdRef.current = previousId;
        writeStoredWorkspaceId(previousId);
        setError(apiMessage(err, 'Unable to switch workspace.'));
        throw err;
      }
    },
    [applyBootstrap],
  );

  const createWorkspace = useCallback(
    async (name: string, slug?: string) => {
      const trimmed = name.trim();
      if (!trimmed) {
        throw new Error('Workspace name is required.');
      }

      setError(null);
      const created = await createWorkspaceRequest({
        name: trimmed,
        ...(slug?.trim() ? { slug: slug.trim() } : {}),
      });
      currentWorkspaceIdRef.current = created.id;
      writeStoredWorkspaceId(created.id);
      setWorkspaceRevision((value) => value + 1);
      await refresh();
    },
    [refresh],
  );

  const permissions = useMemo(
    () => current?.membership.permissions ?? [],
    [current?.membership.permissions],
  );
  const role = current?.membership.role ?? null;
  const entitlements = current?.entitlements ?? null;
  const currentWorkspaceId = current?.workspace.id ?? currentWorkspaceIdRef.current;

  const hasPermission = useCallback(
    (permission: WorkspacePermission) => permissions.includes(permission),
    [permissions],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      ready,
      error,
      user,
      workspaces,
      current,
      currentWorkspaceId,
      entitlements,
      role,
      permissions,
      workspaceRevision,
      switchWorkspace,
      refresh,
      createWorkspace,
      hasPermission,
    }),
    [
      ready,
      error,
      user,
      workspaces,
      current,
      currentWorkspaceId,
      entitlements,
      role,
      permissions,
      workspaceRevision,
      switchWorkspace,
      refresh,
      createWorkspace,
      hasPermission,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error('useWorkspace must be used within WorkspaceProvider.');
  }
  return value;
}
