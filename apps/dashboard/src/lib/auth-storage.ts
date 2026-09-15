const USER_KEY = 'project-x.user';
/** Legacy JWT key — cleared on load so XSS can no longer read access tokens. */
const LEGACY_ACCESS_TOKEN_KEY = 'project-x.accessToken';

export type StoredAuthUser = {
  id: string;
  email: string;
  name?: string | null;
};

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';
}

function purgeLegacyTokenStorage(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.removeItem(LEGACY_ACCESS_TOKEN_KEY);
    window.sessionStorage.removeItem(LEGACY_ACCESS_TOKEN_KEY);
  } catch {
    // ignore quota / private mode
  }
}

/** @deprecated Access tokens live in HttpOnly cookies — always null for dashboard JS. */
export function getAccessToken(): string | null {
  purgeLegacyTokenStorage();
  return null;
}

export function getStoredUser(): StoredAuthUser | null {
  if (!canUseStorage()) {
    return null;
  }
  purgeLegacyTokenStorage();
  const raw = window.sessionStorage.getItem(USER_KEY);
  if (!raw) {
    // Migrate profile from localStorage if present.
    try {
      const legacy = window.localStorage.getItem(USER_KEY);
      if (legacy) {
        window.sessionStorage.setItem(USER_KEY, legacy);
        window.localStorage.removeItem(USER_KEY);
        return JSON.parse(legacy) as StoredAuthUser;
      }
    } catch {
      // ignore
    }
    return null;
  }
  try {
    return JSON.parse(raw) as StoredAuthUser;
  } catch {
    return null;
  }
}

export function setSession(user: StoredAuthUser): void {
  purgeLegacyTokenStorage();
  window.sessionStorage.setItem(USER_KEY, JSON.stringify(user));
  try {
    window.localStorage.removeItem(USER_KEY);
  } catch {
    // ignore
  }
}

export function clearSession(): void {
  purgeLegacyTokenStorage();
  if (!canUseStorage()) {
    return;
  }
  window.sessionStorage.removeItem(USER_KEY);
  try {
    window.localStorage.removeItem(USER_KEY);
  } catch {
    // ignore
  }
}

export function hasCachedUser(): boolean {
  return getStoredUser() !== null;
}
