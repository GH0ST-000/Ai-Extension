import { APP_NAME } from '@project-x/shared';

import {
  API_FETCH_MESSAGE,
  API_STREAM_PORT,
  executeApiFetch,
  executeApiStream,
  type ApiFetchRequestMessage,
  type ApiStreamStartMessage,
} from './lib/api/background-http';

const ALLOWED_MESSAGE_TYPES = new Set(['PING', API_FETCH_MESSAGE]);

type ExtensionMessage = {
  type?: unknown;
};

chrome.runtime.onInstalled.addListener(() => {
  console.info(`[${APP_NAME}] extension installed`);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // After an extension reload, stale workers can still receive events briefly.
  if (!chrome.runtime?.id) {
    return false;
  }

  // Only accept messages from this extension (never from arbitrary web pages).
  if (sender.id && sender.id !== chrome.runtime.id) {
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

  if (typed.type === API_FETCH_MESSAGE) {
    const req = message as ApiFetchRequestMessage;
    if (typeof req.path !== 'string' || !req.path.startsWith('/')) {
      sendResponse({ ok: false, status: 0, headers: {}, bodyText: '', error: 'Invalid API path.' });
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
  if (port.sender?.id && port.sender.id !== chrome.runtime.id) {
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
        !message.path.startsWith('/')
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
