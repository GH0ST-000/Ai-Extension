import { APP_NAME } from '@project-x/shared';

chrome.runtime.onInstalled.addListener(() => {
  console.info(`[${APP_NAME}] extension installed`);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'PING') {
    sendResponse({ type: 'PONG', service: APP_NAME });
    return true;
  }

  return false;
});

export {};
