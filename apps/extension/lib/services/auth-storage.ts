import type { AuthUser } from '@project-x/types';

const ACCESS_TOKEN_KEY = 'accessToken';
const USER_KEY = 'user';

export type StoredAuthSession = {
  accessToken: string;
  user: AuthUser;
};

export async function getAccessToken(): Promise<string | null> {
  const result = await chrome.storage.local.get(ACCESS_TOKEN_KEY);
  const token = result[ACCESS_TOKEN_KEY];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export async function getStoredUser(): Promise<AuthUser | null> {
  const result = await chrome.storage.local.get(USER_KEY);
  const user = result[USER_KEY];
  if (!user || typeof user !== 'object') {
    return null;
  }
  return user as AuthUser;
}

export async function getSession(): Promise<StoredAuthSession | null> {
  const [accessToken, user] = await Promise.all([getAccessToken(), getStoredUser()]);
  if (!accessToken || !user) {
    return null;
  }
  return { accessToken, user };
}

export async function setSession(accessToken: string, user: AuthUser): Promise<void> {
  await chrome.storage.local.set({
    [ACCESS_TOKEN_KEY]: accessToken,
    [USER_KEY]: user,
  });
}

export async function clearSession(): Promise<void> {
  await chrome.storage.local.remove([ACCESS_TOKEN_KEY, USER_KEY]);
}
