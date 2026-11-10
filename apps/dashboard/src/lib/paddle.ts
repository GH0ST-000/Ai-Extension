/**
 * Minimal Paddle.js v2 loader. Paddle returns checkout URLs as
 * `<default payment link>?_ptxn=txn_…`; once Paddle.js is initialized on that page it
 * opens the checkout overlay for the transaction automatically.
 */

const PADDLE_JS_URL = 'https://cdn.paddle.com/paddle/v2/paddle.js';

export type PaddleEvent = { name?: string; data?: unknown };

type PaddleGlobal = {
  Environment: { set(env: 'sandbox' | 'production'): void };
  Initialize(options: { token: string; eventCallback?: (event: PaddleEvent) => void }): void;
  Checkout: { open(options: { transactionId: string }): void; close(): void };
};

declare global {
  interface Window {
    Paddle?: PaddleGlobal;
  }
}

let scriptPromise: Promise<PaddleGlobal> | null = null;
let initializedToken: string | null = null;

function loadPaddleScript(): Promise<PaddleGlobal> {
  if (window.Paddle) {
    return Promise.resolve(window.Paddle);
  }
  scriptPromise ??= new Promise<PaddleGlobal>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PADDLE_JS_URL;
    script.async = true;
    script.onload = () =>
      window.Paddle ? resolve(window.Paddle) : reject(new Error('Paddle.js did not load.'));
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Unable to load Paddle.js.'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

type PaddleEventHandler = (event: PaddleEvent) => void;

/**
 * Paddle.js accepts its event callback only once (at Initialize), but the component that
 * cares about events mounts and unmounts as the user navigates. Initialize with a stable
 * dispatcher and let whichever page is mounted right now register the real handler.
 */
let currentEventHandler: PaddleEventHandler | null = null;

export function setPaddleEventHandler(handler: PaddleEventHandler): () => void {
  currentEventHandler = handler;
  return () => {
    if (currentEventHandler === handler) {
      currentEventHandler = null;
    }
  };
}

/** Load and initialize Paddle.js once per page; later calls with the same token are no-ops. */
export async function initPaddle(options: {
  token: string;
  environment: 'sandbox' | 'production';
}): Promise<void> {
  const paddle = await loadPaddleScript();
  if (initializedToken === options.token) {
    return;
  }
  if (options.environment === 'sandbox') {
    paddle.Environment.set('sandbox');
  }
  paddle.Initialize({
    token: options.token,
    eventCallback: (event) => currentEventHandler?.(event),
  });
  initializedToken = options.token;
}

/** Open the Paddle checkout overlay on the current page (works on localhost in sandbox). */
export async function openPaddleCheckout(transactionId: string): Promise<void> {
  const paddle = await loadPaddleScript();
  if (!initializedToken) {
    throw new Error('Paddle.js is not initialized.');
  }
  paddle.Checkout.open({ transactionId });
}

/** Close the overlay (Paddle leaves its success screen open until the user closes it). */
export function closePaddleCheckout(): void {
  window.Paddle?.Checkout.close();
}
