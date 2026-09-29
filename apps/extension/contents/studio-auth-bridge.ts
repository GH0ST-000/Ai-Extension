import type { PlasmoCSConfig } from 'plasmo';

/**
 * Studio dashboard origin bridge.
 * Tokens never enter page JS — background reads HttpOnly cookies / clears on logout signal.
 *
 * Plasmo requires a static `matches` literal for manifest generation.
 * Add the production Studio origin here (and host_permissions) before shipping.
 */
export const config: PlasmoCSConfig = {
  matches: ['http://localhost:3000/*', 'http://127.0.0.1:3000/*'],
  run_at: 'document_start',
  all_frames: false,
};

const SYNC_KEY = 'project-x.extension-sync';
const SYNC_EVENT = 'project-x:extension-sync';
const LOGOUT_KEY = 'project-x.extension-logout';
const LOGOUT_EVENT = 'project-x:extension-logout';
const MESSAGE_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

async function syncShared(): Promise<void> {
  try {
    sessionStorage.removeItem(SYNC_KEY);
  } catch {
    // ignore
  }
  await withTimeout(chrome.runtime.sendMessage({ type: 'SYNC_SESSION' }), MESSAGE_TIMEOUT_MS);
}

async function applyLogoutSignal(): Promise<boolean> {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(LOGOUT_KEY);
  } catch {
    return false;
  }
  if (!raw) {
    return false;
  }
  try {
    sessionStorage.removeItem(LOGOUT_KEY);
  } catch {
    // ignore
  }
  await withTimeout(chrome.runtime.sendMessage({ type: 'CLEAR_SESSION' }), MESSAGE_TIMEOUT_MS);
  return true;
}

async function applySyncSignal(): Promise<boolean> {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(SYNC_KEY);
  } catch {
    return false;
  }
  if (!raw) {
    return false;
  }
  await syncShared();
  return true;
}

async function bridge(): Promise<void> {
  if (await applyLogoutSignal()) {
    return;
  }
  if (await applySyncSignal()) {
    return;
  }
  await syncShared();
}

void bridge();
window.addEventListener(SYNC_EVENT, () => {
  void bridge();
});
window.addEventListener(LOGOUT_EVENT, () => {
  void bridge();
});
window.setTimeout(() => {
  void bridge();
}, 400);
window.setTimeout(() => {
  void bridge();
}, 1_200);
