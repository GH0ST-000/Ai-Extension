import { APP_NAME } from '@project-x/shared';

import {
  API_FETCH_MESSAGE,
  API_STREAM_PORT,
  executeApiFetch,
  executeApiStream,
  type ApiFetchRequestMessage,
  type ApiStreamStartMessage,
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
import { ACCESS_COOKIE_NAME } from './lib/services/auth-cookie-bridge';
import { getApiBaseUrl } from './lib/api/api-base-url';
import { clearCurrentWorkspaceId } from './lib/workspace/current-workspace-id';

const ALLOWED_MESSAGE_TYPES = new Set([
  'PING',
  'AUTH_STATUS',
  'SYNC_SESSION',
  'CLEAR_SESSION',
  'OPEN_SIGN_IN',
  API_FETCH_MESSAGE,
]);

type ExtensionMessage = {
  type?: unknown;
};

function cookieHostMatchesApi(cookieDomain: string, apiHostname: string): boolean {
  const domain = cookieDomain.replace(/^\./, '');
  return (
    domain === apiHostname ||
    apiHostname.endsWith(`.${domain}`) ||
    (domain === 'localhost' && (apiHostname === 'localhost' || apiHostname === '127.0.0.1')) ||
    (domain === '127.0.0.1' && (apiHostname === 'localhost' || apiHostname === '127.0.0.1'))
  );
}

void ensureTrustedSessionStorage();

chrome.runtime.onInstalled.addListener(() => {
  void ensureTrustedSessionStorage();
  console.info(`[${APP_NAME}] extension installed`);
});

chrome.runtime.onStartup?.addListener(() => {
  void ensureTrustedSessionStorage();
});

/**
 * Cookie sync rules:
 * - overwrite → hydrate (dashboard login / account switch; cookies win)
 * - explicit removal → clear extension storage (logout is authoritative; never heal)
 * - expired/evicted → leave storage alone (extension Bearer session remains valid)
 */
if (chrome.cookies?.onChanged) {
  chrome.cookies.onChanged.addListener((change) => {
    if (change.cookie.name !== ACCESS_COOKIE_NAME) return;
    if (isCookieSyncSuppressed()) return;

    let apiHost: string;
    try {
      apiHost = new URL(getApiBaseUrl()).hostname;
    } catch {
      return;
    }
    if (!cookieHostMatchesApi(change.cookie.domain, apiHost)) {
      return;
    }

    if (change.removed) {
      if (
        change.cause === 'overwrite' ||
        change.cause === 'expired_overwrite' ||
        change.cause === 'expired' ||
        change.cause === 'evicted'
      ) {
        return;
      }
      // explicit clear (logout / clearAuthCookies)
      void clearSessionStorageOnly().then(() => clearCurrentWorkspaceId());
      return;
    }

    // New or overwritten cookie — adopt dashboard session.
    void hydrateSessionFromBrowserCookies(true);
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
