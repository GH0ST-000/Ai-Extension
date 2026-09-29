import type { AuthUser } from '@project-x/types';

import { getApiBaseUrl } from '../api/api-base-url';
import {
  clearAuthCookiesFromBrowser,
  readAccessTokenFromBrowserCookie,
  readRefreshTokenFromBrowserCookie,
  writeAuthCookiesToBrowser,
} from './auth-cookie-bridge';

const ACCESS_TOKEN_KEY = 'accessToken';
const REFRESH_TOKEN_KEY = 'refreshToken';
const USER_KEY = 'user';
const HYDRATE_FETCH_TIMEOUT_MS = 2_500;

export type StoredAuthSession = {
  accessToken: string;
  refreshToken?: string;
  user: AuthUser;
};

let sessionAccessLevelReady: Promise<void> | null = null;
/** Ignore cookie onChanged side-effects while we are writing/clearing cookies ourselves. */
let cookieSyncSuppressedUntil = 0;

export function suppressCookieSyncBriefly(ms = 2_500): void {
  cookieSyncSuppressedUntil = Date.now() + ms;
}

export function isCookieSyncSuppressed(): boolean {
  return Date.now() < cookieSyncSuppressedUntil;
}

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

function userStorageArea(): chrome.storage.StorageArea {
  return chrome.storage.local;
}

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

async function readStoredAccessToken(): Promise<string | null> {
  const result = await tokenStorageArea().get(ACCESS_TOKEN_KEY);
  const stored = result[ACCESS_TOKEN_KEY];
  return typeof stored === 'string' && stored.length > 0 ? stored : null;
}

async function readStoredRefreshToken(): Promise<string | null> {
  const result = await tokenStorageArea().get(REFRESH_TOKEN_KEY);
  const stored = result[REFRESH_TOKEN_KEY];
  return typeof stored === 'string' && stored.length > 0 ? stored : null;
}

/**
 * Extension API auth uses storage as source of truth.
 * Browser cookies are only a mirror for the dashboard SPA.
 */
export async function getAccessToken(): Promise<string | null> {
  if (!isPrivilegedExtensionContext()) {
    return null;
  }
  const storedToken = await readStoredAccessToken();
  if (storedToken) {
    return storedToken;
  }
  return readAccessTokenFromBrowserCookie();
}

export async function getRefreshToken(): Promise<string | null> {
  if (!isPrivilegedExtensionContext()) {
    return null;
  }
  const storedToken = await readStoredRefreshToken();
  if (storedToken) {
    return storedToken;
  }
  return readRefreshTokenFromBrowserCookie();
}

export async function getStoredUser(): Promise<AuthUser | null> {
  const result = await userStorageArea().get(USER_KEY);
  const user = result[USER_KEY];
  if (!user || typeof user !== 'object') {
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
        // ignore
      }
    }
    return null;
  }
  return user as AuthUser;
}

/** Storage-only session read — never touches cookies or network. */
export async function getStoredSessionFast(): Promise<StoredAuthSession | null> {
  if (!isPrivilegedExtensionContext()) {
    return null;
  }
  const [accessToken, refreshToken, user] = await Promise.all([
    readStoredAccessToken(),
    readStoredRefreshToken(),
    getStoredUser(),
  ]);
  if (!accessToken || !user) {
    return null;
  }
  return { accessToken, refreshToken: refreshToken ?? undefined, user };
}

export async function getSession(): Promise<StoredAuthSession | null> {
  await syncSharedSession();
  return getStoredSessionFast();
}

/** Push extension storage tokens into browser cookies for the dashboard. */
export async function pushSessionCookiesToBrowser(): Promise<boolean> {
  if (!isPrivilegedExtensionContext()) {
    return false;
  }
  const session = await getStoredSessionFast();
  if (!session) {
    return false;
  }
  suppressCookieSyncBriefly();
  await writeAuthCookiesToBrowser({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
  });
  return true;
}

/**
 * If the dashboard already set auth cookies but extension storage is empty/stale,
 * pull /auth/me and mirror tokens into extension storage.
 */
export async function hydrateSessionFromBrowserCookies(force = false): Promise<boolean> {
  if (!isPrivilegedExtensionContext()) {
    return false;
  }

  if (!force) {
    const existing = await getStoredSessionFast();
    if (existing) {
      return true;
    }
  }

  const cookieToken = await readAccessTokenFromBrowserCookie();
  if (!cookieToken) {
    return false;
  }

  // Already have the same token in storage — nothing to do.
  if (!force) {
    const stored = await readStoredAccessToken();
    if (stored === cookieToken && (await getStoredUser())) {
      return true;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HYDRATE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/auth/me`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cookieToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { user?: AuthUser };
    if (!body.user) {
      return false;
    }
    const refreshToken = (await readRefreshTokenFromBrowserCookie()) ?? undefined;
    await setSession(cookieToken, body.user, refreshToken);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bidirectional sync with clear precedence:
 * - If an API cookie exists and differs from storage → cookies win (dashboard login / account switch).
 * - If no cookie but extension storage has a session → push cookies for the dashboard.
 * - If neither → signed out.
 */
export async function syncSharedSession(): Promise<boolean> {
  if (!isPrivilegedExtensionContext()) {
    return false;
  }

  const cookieToken = await readAccessTokenFromBrowserCookie();
  const local = await getStoredSessionFast();

  if (cookieToken) {
    if (!local || local.accessToken !== cookieToken) {
      return hydrateSessionFromBrowserCookies(true);
    }
    return true;
  }

  if (local) {
    await pushSessionCookiesToBrowser();
    return true;
  }

  return false;
}

export async function hasAuthSession(): Promise<boolean> {
  if (isPrivilegedExtensionContext()) {
    if (await getStoredSessionFast()) {
      return true;
    }
    await hydrateSessionFromBrowserCookies(true);
    return Boolean(await getStoredSessionFast());
  }
  try {
    const result = (await chrome.runtime.sendMessage({ type: 'AUTH_STATUS' })) as
      { signedIn?: boolean } | undefined;
    if (result && typeof result.signedIn === 'boolean') {
      return result.signedIn;
    }
  } catch {
    // Fall through.
  }
  return Boolean(await getStoredUser());
}

export async function setSession(
  accessToken: string,
  user: AuthUser,
  refreshToken?: string,
  options?: { accessMaxAgeSeconds?: number; refreshMaxAgeSeconds?: number },
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
  suppressCookieSyncBriefly();
  await writeAuthCookiesToBrowser({
    accessToken,
    refreshToken,
    accessMaxAgeSeconds: options?.accessMaxAgeSeconds,
    refreshMaxAgeSeconds: options?.refreshMaxAgeSeconds,
  });
}

export async function clearSession(): Promise<void> {
  suppressCookieSyncBriefly();
  await Promise.all([clearSessionStorageOnly(), clearAuthCookiesFromBrowser()]);
}

/** Clear extension storage without touching browser cookies (used when cookies were already removed). */
export async function clearSessionStorageOnly(): Promise<void> {
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
