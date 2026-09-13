import { APP_NAME } from '@project-x/shared';

const ALLOWED_MESSAGE_TYPES = new Set(['PING']);

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

  return false;
});

export {};
