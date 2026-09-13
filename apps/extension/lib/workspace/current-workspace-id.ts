import {
  CURRENT_WORKSPACE_ID_KEY,
  getStoredWorkspaceId,
  setStoredWorkspaceId,
  clearStoredWorkspaceId,
} from './workspace-storage';

/** In-memory cache for the current extension JS context (popup / CS / background). */
let memoryWorkspaceId: string | null = null;
let hydrated = false;
let storageListenerBound = false;

function ensureStorageListener(): void {
  if (storageListenerBound || typeof chrome === 'undefined' || !chrome.storage?.onChanged) {
    return;
  }
  storageListenerBound = true;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') {
      return;
    }
    const change = changes[CURRENT_WORKSPACE_ID_KEY];
    if (!change) {
      return;
    }
    const next = change.newValue;
    memoryWorkspaceId = typeof next === 'string' && next.length > 0 ? next : null;
    hydrated = true;
  });
}

/**
 * Sync getter for callers that already hydrated (or have a store-driven set).
 * Prefer {@link getCurrentWorkspaceId} in async API helpers.
 */
export function getCurrentWorkspaceIdSync(): string | null {
  ensureStorageListener();
  return memoryWorkspaceId;
}

/** Lazy hydrate from chrome.storage.local — safe across popup / content-script worlds. */
export async function getCurrentWorkspaceId(): Promise<string | null> {
  ensureStorageListener();
  if (hydrated) {
    return memoryWorkspaceId;
  }
  memoryWorkspaceId = await getStoredWorkspaceId();
  hydrated = true;
  return memoryWorkspaceId;
}

export async function persistCurrentWorkspaceId(workspaceId: string): Promise<void> {
  ensureStorageListener();
  memoryWorkspaceId = workspaceId;
  hydrated = true;
  await setStoredWorkspaceId(workspaceId);
}

export async function clearCurrentWorkspaceId(): Promise<void> {
  ensureStorageListener();
  memoryWorkspaceId = null;
  hydrated = true;
  await clearStoredWorkspaceId();
}

/** Update memory only (storage already written elsewhere). */
export function setCurrentWorkspaceIdMemory(workspaceId: string | null): void {
  ensureStorageListener();
  memoryWorkspaceId = workspaceId;
  hydrated = true;
}
