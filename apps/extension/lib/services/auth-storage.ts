import type { AuthUser } from '@project-x/types';

const ACCESS_TOKEN_KEY = 'accessToken';
const REFRESH_TOKEN_KEY = 'refreshToken';
const USER_KEY = 'user';

export type StoredAuthSession = {
  accessToken: string;
  refreshToken?: string;
  user: AuthUser;
};

function storageArea(): chrome.storage.StorageArea {
  // Prefer session storage so tokens do not survive browser restart.
  return chrome.storage.session ?? chrome.storage.local;
}

export async function getAccessToken(): Promise<string | null> {
  const result = await storageArea().get(ACCESS_TOKEN_KEY);
  const token = result[ACCESS_TOKEN_KEY];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export async function getRefreshToken(): Promise<string | null> {
  const result = await storageArea().get(REFRESH_TOKEN_KEY);
  const token = result[REFRESH_TOKEN_KEY];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export async function getStoredUser(): Promise<AuthUser | null> {
  const result = await storageArea().get(USER_KEY);
  const user = result[USER_KEY];
  if (!user || typeof user !== 'object') {
    return null;
  }
  return user as AuthUser;
}

export async function getSession(): Promise<StoredAuthSession | null> {
  const [accessToken, refreshToken, user] = await Promise.all([
    getAccessToken(),
    getRefreshToken(),
    getStoredUser(),
  ]);
  if (!accessToken || !user) {
    return null;
  }
  return { accessToken, refreshToken: refreshToken ?? undefined, user };
}

export async function setSession(
  accessToken: string,
  user: AuthUser,
  refreshToken?: string,
): Promise<void> {
  const payload: Record<string, unknown> = {
    [ACCESS_TOKEN_KEY]: accessToken,
    [USER_KEY]: user,
  };
  if (refreshToken) {
    payload[REFRESH_TOKEN_KEY] = refreshToken;
  }
  await storageArea().set(payload);
  // Remove legacy local copies if we migrated to session storage.
  if (chrome.storage.session) {
    await chrome.storage.local.remove([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, USER_KEY]);
  }
}

export async function clearSession(): Promise<void> {
  await Promise.all([
    storageArea().remove([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, USER_KEY]),
    chrome.storage.local.remove([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, USER_KEY]),
  ]);
}
