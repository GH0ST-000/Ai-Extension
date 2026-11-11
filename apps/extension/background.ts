import { APP_NAME } from '@project-x/shared';

import {
  API_FETCH_MESSAGE,
  API_STREAM_PORT,
  executeApiFetch,
  executeApiStream,
  REFRESH_SESSION_MESSAGE,
  tryRefresh,
  type ApiFetchRequestMessage,
  type ApiStreamStartMessage,
  type RefreshSessionMessage,
} from './lib/api/background-http';
import { isAllowedExtensionApiPath } from './lib/api/allowed-api-paths';
import {
  clearSession,
  clearSessionStorageOnly,
  ensureTrustedSessionStorage,
  getStoredSessionFast,
  hydrateSessionFromBrowserCookies,
  isCookieSyncSuppressed,
  syncSharedSession,
} from './lib/services/auth-storage';
import {
  ACCESS_COOKIE_NAME,
  isTrustedApiCookie,
  REFRESH_COOKIE_NAME,
} from './lib/services/auth-cookie-bridge';
import { getApiBaseUrl } from './lib/api/api-base-url';
import { clearCurrentWorkspaceId } from './lib/workspace/current-workspace-id';

const ALLOWED_MESSAGE_TYPES = new Set([
  'PING',
  'AUTH_STATUS',
  'SYNC_SESSION',
  'CLEAR_SESSION',
  'OPEN_SIGN_IN',
  API_FETCH_MESSAGE,
  REFRESH_SESSION_MESSAGE,
]);

type ExtensionMessage = {
  type?: unknown;
};

void ensureTrustedSessionStorage();

chrome.runtime.onInstalled.addListener(() => {
  void ensureTrustedSessionStorage();
  console.info(`[${APP_NAME}] extension installed`);
});

chrome.runtime.onStartup?.addListener(() => {
  void ensureTrustedSessionStorage();
});

/**
 * Cookie sync rules (px_at / px_rt, host-only on the API hostname only):
 * - px_at set/overwritten → hydrate (dashboard login / account switch; cookies win)
 * - explicit removal, or a server clear (Set-Cookie with a past expiry, reported as
 *   expired_overwrite) → clear extension storage (logout is authoritative; never heal)
 * - natural expiry / eviction / rotation overwrite → leave storage alone
 */
if (chrome.cookies?.onChanged) {
  chrome.cookies.onChanged.addListener((change) => {
    const name = change.cookie.name;
    if (name !== ACCESS_COOKIE_NAME && name !== REFRESH_COOKIE_NAME) return;
    if (isCookieSyncSuppressed()) return;

    let apiHost: string;
    try {
      apiHost = new URL(getApiBaseUrl()).hostname;
    } catch {
      return;
    }
    if (!isTrustedApiCookie(change.cookie, apiHost)) {
      return;
    }

    if (change.removed) {
      if (change.cause === 'explicit' || change.cause === 'expired_overwrite') {
        void clearSessionStorageOnly().then(() => clearCurrentWorkspaceId());
      }
      return;
    }

    if (name === ACCESS_COOKIE_NAME) {
      // New or overwritten access cookie — adopt dashboard session.
      void hydrateSessionFromBrowserCookies(true);
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!chrome.runtime?.id) {
    return false;
  }

  if (!sender.id || sender.id !== chrome.runtime.id) {
    return false;
  }

  if (!message || typeof message !== 'object') {
    return false;
  }

  const typed = message as ExtensionMessage;
  if (typeof typed.type !== 'string' || !ALLOWED_MESSAGE_TYPES.has(typed.type)) {
    return false;
  }

  if (typed.type === 'PING') {
    sendResponse({ type: 'PONG', service: APP_NAME });
    return true;
  }

  if (typed.type === 'AUTH_STATUS' || typed.type === 'SYNC_SESSION') {
    void (async () => {
      try {
        await Promise.race([
          syncSharedSession(),
          new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(false), 3_000);
          }),
        ]);
        const session = await getStoredSessionFast();
        sendResponse({
          ok: true,
          signedIn: Boolean(session),
          user: session?.user ?? null,
        });
      } catch {
        sendResponse({ ok: false, signedIn: false, user: null });
      }
    })();
    return true;
  }

  if (typed.type === 'CLEAR_SESSION') {
    void (async () => {
      try {
        await clearSession();
        await clearCurrentWorkspaceId();
        sendResponse({ ok: true, signedIn: false });
      } catch {
        sendResponse({ ok: false, signedIn: false });
      }
    })();
    return true;
  }

  if (typed.type === REFRESH_SESSION_MESSAGE) {
    // Extension pages (popup) only; content scripts refresh implicitly via API_FETCH.
    if (sender.tab) {
      return false;
    }
    const rejected = (message as RefreshSessionMessage).rejectedAccessToken;
    void tryRefresh(typeof rejected === 'string' ? rejected : null)
      .then((refreshed) => sendResponse({ refreshed }))
      .catch(() => sendResponse({ refreshed: false }));
    return true;
  }

  if (typed.type === 'OPEN_SIGN_IN') {
    const popupUrl = chrome.runtime.getURL('popup.html');
    void chrome.tabs.create({ url: popupUrl });
    sendResponse({ ok: true });
    return true;
  }

  if (typed.type === API_FETCH_MESSAGE) {
    const req = message as ApiFetchRequestMessage;
    if (typeof req.path !== 'string' || !isAllowedExtensionApiPath(req.path)) {
      sendResponse({
        ok: false,
        status: 0,
        headers: {},
        bodyText: '',
        error: 'API path is not allowed.',
      });
      return true;
    }
    void executeApiFetch(req)
      .then((result) => sendResponse(result))
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          status: 0,
          headers: {},
          bodyText: '',
          error: error instanceof Error ? error.message : 'API proxy failed.',
        });
      });
    return true;
  }

  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== API_STREAM_PORT) {
    return;
  }
  if (!port.sender?.id || port.sender.id !== chrome.runtime.id) {
    port.disconnect();
    return;
  }

  let aborted = false;
  const abortController = new AbortController();

  port.onMessage.addListener(
    (message: { type?: 'START' | 'ABORT' } & Partial<Omit<ApiStreamStartMessage, 'type'>>) => {
      if (message?.type === 'ABORT') {
        aborted = true;
        abortController.abort();
        return;
      }
      if (
        message?.type !== 'START' ||
        typeof message.path !== 'string' ||
        !isAllowedExtensionApiPath(message.path)
      ) {
        port.postMessage({ type: 'ERROR', error: 'Invalid stream request.' });
        return;
      }

      void (async () => {
        try {
          const start = message as ApiStreamStartMessage;
          const result = await executeApiStream(
            {
              path: start.path,
              method: start.method,
              headers: start.headers,
              body: start.body,
              auth: start.auth,
            },
            (chunk) => {
              if (!aborted) {
                port.postMessage({ type: 'CHUNK', chunk });
              }
            },
            abortController.signal,
          );
          if (!aborted) {
            port.postMessage({
              type: 'DONE',
              status: result.status,
              bodyText: result.bodyText,
              headers: result.headers,
            });
          }
        } catch (error) {
          if (!aborted) {
            port.postMessage({
              type: 'ERROR',
              error: error instanceof Error ? error.message : 'Stream proxy failed.',
            });
          }
        }
      })();
    },
  );
});

export {};
