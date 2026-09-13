const CURRENT_WORKSPACE_ID_KEY = 'currentWorkspaceId';

export async function getStoredWorkspaceId(): Promise<string | null> {
  const result = await chrome.storage.local.get(CURRENT_WORKSPACE_ID_KEY);
  const value = result[CURRENT_WORKSPACE_ID_KEY];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function setStoredWorkspaceId(workspaceId: string): Promise<void> {
  await chrome.storage.local.set({ [CURRENT_WORKSPACE_ID_KEY]: workspaceId });
}

export async function clearStoredWorkspaceId(): Promise<void> {
  await chrome.storage.local.remove(CURRENT_WORKSPACE_ID_KEY);
}

export { CURRENT_WORKSPACE_ID_KEY };
