/**
 * Dashboard ↔ extension session bridge signals.
 * Never put JWTs in page JS — the extension reads HttpOnly API cookies via chrome.cookies.
 */

export const EXTENSION_SYNC_KEY = 'project-x.extension-sync';
export const EXTENSION_SYNC_EVENT = 'project-x:extension-sync';
export const EXTENSION_LOGOUT_KEY = 'project-x.extension-logout';
export const EXTENSION_LOGOUT_EVENT = 'project-x:extension-logout';

/** Ask the content script to run SYNC_SESSION (cookies ↔ extension storage). */
export function publishExtensionSync(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.sessionStorage.removeItem(EXTENSION_LOGOUT_KEY);
    window.sessionStorage.setItem(EXTENSION_SYNC_KEY, String(Date.now()));
    window.dispatchEvent(new CustomEvent(EXTENSION_SYNC_EVENT));
  } catch {
    // ignore
  }
}

/** Tell the extension content script to clear its mirrored session. */
export function publishExtensionLogout(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.sessionStorage.removeItem(EXTENSION_SYNC_KEY);
    window.sessionStorage.setItem(EXTENSION_LOGOUT_KEY, String(Date.now()));
    window.dispatchEvent(new CustomEvent(EXTENSION_LOGOUT_EVENT));
  } catch {
    // ignore
  }
}
