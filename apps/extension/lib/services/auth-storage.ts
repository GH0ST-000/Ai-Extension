import type { AuthUser } from '@project-x/types';

const ACCESS_TOKEN_KEY = 'accessToken';
const REFRESH_TOKEN_KEY = 'refreshToken';
const USER_KEY = 'user';

export type StoredAuthSession = {
  accessToken: string;
  refreshToken?: string;
  user: AuthUser;
};

let sessionAccessLevelReady: Promise<void> | null = null;

/**
 * Restrict chrome.storage.session to extension pages + service worker so
 * content scripts cannot read JWTs. Call only from the background/service worker.
 */
export async function ensureTrustedSessionStorage(): Promise<void> {
  if (!sessionAccessLevelReady) {
    sessionAccessLevelReady = (async () => {
      try {
        if (chrome.storage?.session?.setAccessLevel) {
          await chrome.storage.session.setAccessLevel({
            accessLevel: 'TRUSTED_CONTEXTS',
          });
        }
      } catch {
        // Older Chrome / missing API — fall through; tokens still prefer session.
      }
    })();
  }
  await sessionAccessLevelReady;
}

function tokenStorageArea(): chrome.storage.StorageArea {
  return chrome.storage.session ?? chrome.storage.local;
}

/** Profile cache may live in local so CS UI can detect signed-in without JWTs. */
function userStorageArea(): chrome.storage.StorageArea {
  return chrome.storage.local;
}

/** True in service worker / extension pages — not host-page content scripts. */
export function isPrivilegedExtensionContext(): boolean {
  try {
    const href = globalThis.location?.href ?? '';
    if (!href) {
      return true;
    }
    return href.startsWith('chrome-extension:') || href.startsWith('moz-extension:');
  } catch {
    return true;
  }
}

export async function getAccessToken(): Promise<string | null> {
  if (!isPrivilegedExtensionContext()) {
    return null;
  }
  const result = await tokenStorageArea().get(ACCESS_TOKEN_KEY);
  const token = result[ACCESS_TOKEN_KEY];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export async function getRefreshToken(): Promise<string | null> {
  if (!isPrivilegedExtensionContext()) {
    return null;
  }
  const result = await tokenStorageArea().get(REFRESH_TOKEN_KEY);
  const token = result[REFRESH_TOKEN_KEY];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export async function getStoredUser(): Promise<AuthUser | null> {
  const result = await userStorageArea().get(USER_KEY);
  const user = result[USER_KEY];
  if (!user || typeof user !== 'object') {
    // Migrate legacy session-stored profile once.
    if (isPrivilegedExtensionContext() && chrome.storage.session) {
      try {
        const legacy = await chrome.storage.session.get(USER_KEY);
        const legacyUser = legacy[USER_KEY];
        if (legacyUser && typeof legacyUser === 'object') {
          await userStorageArea().set({ [USER_KEY]: legacyUser });
          await chrome.storage.session.remove(USER_KEY);
          return legacyUser as AuthUser;
        }
      } catch {
        // Session may be TRUSTED_CONTEXTS-only for CS — ignore.
      }
    }
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

/** Signed-in check — CS asks the background so JWT presence is authoritative. */
export async function hasAuthSession(): Promise<boolean> {
  if (isPrivilegedExtensionContext()) {
    return Boolean(await getAccessToken());
  }
  try {
    const result = (await chrome.runtime.sendMessage({ type: 'AUTH_STATUS' })) as
      { signedIn?: boolean } | undefined;
    if (result && typeof result.signedIn === 'boolean') {
      return result.signedIn;
    }
  } catch {
    // Fall through to profile hint.
  }
  return Boolean(await getStoredUser());
}

export async function setSession(
  accessToken: string,
  user: AuthUser,
  refreshToken?: string,
): Promise<void> {
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('Cannot persist session without an access token.');
  }
  const tokenPayload: Record<string, unknown> = {
    [ACCESS_TOKEN_KEY]: accessToken,
  };
  if (refreshToken) {
    tokenPayload[REFRESH_TOKEN_KEY] = refreshToken;
  }
  await Promise.all([
    tokenStorageArea().set(tokenPayload),
    userStorageArea().set({ [USER_KEY]: user }),
  ]);
  // Remove legacy local token copies if we use session storage for JWTs.
  if (chrome.storage.session) {
    await chrome.storage.local.remove([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY]);
  }
}

export async function clearSession(): Promise<void> {
  await Promise.all([
    tokenStorageArea().remove([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY]),
    userStorageArea().remove([USER_KEY]),
    chrome.storage.local.remove([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, USER_KEY]),
    chrome.storage.session
      ? chrome.storage.session
          .remove([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, USER_KEY])
          .catch(() => undefined)
      : Promise.resolve(),
  ]);
}
