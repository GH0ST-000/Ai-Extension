import {
  clearSession,
  getAccessToken,
  getRefreshToken,
  setSession,
} from '../services/auth-storage';
import { applyWorkspaceHeader } from './workspace-header';
import { assertAllowedApiUrl, getApiBaseUrl, needsApiProxy } from './api-base-url';

export const API_FETCH_MESSAGE = 'API_FETCH' as const;
export const API_STREAM_PORT = 'api-stream' as const;

export type ApiFetchRequestMessage = {
  type: typeof API_FETCH_MESSAGE;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  auth?: boolean;
};

export type ApiFetchResponseMessage = {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  error?: string;
};

export type ApiStreamStartMessage = {
  type: 'START';
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  auth?: boolean;
};

async function attachAuthHeaders(
  headers: Headers,
  auth: boolean,
): Promise<{ unauthorized: boolean }> {
  if (!auth) {
    return { unauthorized: false };
  }
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { unauthorized: true };
  }
  headers.set('Authorization', `Bearer ${accessToken}`);
  await applyWorkspaceHeader(headers);
  return { unauthorized: false };
}

async function tryRefresh(): Promise<boolean> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    return false;
  }
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) {
      return false;
    }
    const result = (await response.json()) as {
      accessToken?: string;
      refreshToken?: string;
      user?: { id: string; email: string; name?: string | null };
    };
    if (!result.accessToken || !result.user) {
      return false;
    }
    await setSession(result.accessToken, result.user, result.refreshToken);
    return true;
  } catch {
    return false;
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** Background-side executor — never call from content scripts directly. */
export async function executeApiFetch(
  input: Omit<ApiFetchRequestMessage, 'type'>,
): Promise<ApiFetchResponseMessage> {
  const path = input.path.startsWith('/') ? input.path : `/${input.path}`;
  const url = `${getApiBaseUrl()}/api${path}`;
  assertAllowedApiUrl(url);

  const headers = new Headers(input.headers ?? {});
  const auth = input.auth !== false;
  const authState = await attachAuthHeaders(headers, auth);
  if (authState.unauthorized) {
    return {
      ok: false,
      status: 401,
      headers: {},
      bodyText: JSON.stringify({ message: 'Not signed in.' }),
    };
  }

  const init: RequestInit = {
    method: input.method ?? (input.body ? 'POST' : 'GET'),
    headers,
    body: input.body ?? undefined,
  };

  let response = await fetch(url, init);
  if (response.status === 401 && auth) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      const retryHeaders = new Headers(input.headers ?? {});
      await attachAuthHeaders(retryHeaders, true);
      response = await fetch(url, { ...init, headers: retryHeaders });
    } else {
      await clearSession();
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    headers: headersToRecord(response.headers),
    bodyText: await response.text(),
  };
}

export async function executeApiStream(
  input: Omit<ApiStreamStartMessage, 'type'>,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; bodyText: string }> {
  const path = input.path.startsWith('/') ? input.path : `/${input.path}`;
  const url = `${getApiBaseUrl()}/api${path}`;
  assertAllowedApiUrl(url);

  const headers = new Headers(input.headers ?? {});
  const auth = input.auth !== false;
  const authState = await attachAuthHeaders(headers, auth);
  if (authState.unauthorized) {
    return { ok: false, status: 401, bodyText: JSON.stringify({ message: 'Not signed in.' }) };
  }

  let response = await fetch(url, {
    method: input.method ?? 'POST',
    headers,
    body: input.body ?? undefined,
    signal,
  });

  if (response.status === 401 && auth) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      const retryHeaders = new Headers(input.headers ?? {});
      await attachAuthHeaders(retryHeaders, true);
      response = await fetch(url, {
        method: input.method ?? 'POST',
        headers: retryHeaders,
        body: input.body ?? undefined,
        signal,
      });
    } else {
      await clearSession();
    }
  }

  if (!response.ok || !response.body) {
    return {
      ok: response.ok,
      status: response.status,
      bodyText: await response.text(),
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (chunk) {
      full += chunk;
      onChunk(chunk);
    }
  }
  full += decoder.decode();
  return { ok: true, status: response.status, bodyText: full };
}

function recordToHeaders(record: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(record)) {
    headers.set(key, value);
  }
  return headers;
}

/** Content-script / shared fetch that proxies through the background when needed. */
export async function extensionApiFetch(
  path: string,
  init?: RequestInit & { auth?: boolean },
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }

  const auth = init?.auth !== false;
  const method = init?.method ?? (init?.body ? 'POST' : 'GET');
  const body =
    typeof init?.body === 'string' ? init.body : init?.body != null ? String(init.body) : null;

  if (!needsApiProxy()) {
    const result = await executeApiFetch({
      path,
      method,
      headers: headersToRecord(headers),
      body,
      auth,
    });
    return new Response(result.bodyText, {
      status: result.status,
      headers: recordToHeaders(result.headers),
    });
  }

  const message: ApiFetchRequestMessage = {
    type: API_FETCH_MESSAGE,
    path,
    method,
    headers: headersToRecord(headers),
    body,
    auth,
  };

  const result = (await chrome.runtime.sendMessage(message)) as ApiFetchResponseMessage;
  if (!result || typeof result.status !== 'number') {
    throw new Error(result?.error || 'Background API proxy failed.');
  }
  if (result.error && result.status === 0) {
    throw new Error(result.error);
  }
  return new Response(result.bodyText, {
    status: result.status,
    headers: recordToHeaders(result.headers ?? {}),
  });
}

export async function extensionApiStream(
  path: string,
  init: RequestInit & { auth?: boolean },
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (!headers.has('Accept')) {
    headers.set('Accept', 'text/plain');
  }

  const auth = init.auth !== false;
  const method = init.method ?? 'POST';
  const body =
    typeof init.body === 'string' ? init.body : init.body != null ? String(init.body) : null;

  if (!needsApiProxy()) {
    const result = await executeApiStream(
      {
        path,
        method,
        headers: headersToRecord(headers),
        body,
        auth,
      },
      onChunk,
      signal,
    );
    return new Response(result.bodyText, { status: result.status });
  }

  return new Promise<Response>((resolve, reject) => {
    const port = chrome.runtime.connect({ name: API_STREAM_PORT });
    let settled = false;
    let full = '';
    let status = 0;

    const abort = () => {
      try {
        port.postMessage({ type: 'ABORT' });
        port.disconnect();
      } catch {
        // ignore
      }
    };

    if (signal) {
      if (signal.aborted) {
        abort();
        reject(new DOMException('Request cancelled', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => {
        abort();
        if (!settled) {
          settled = true;
          reject(new DOMException('Request cancelled', 'AbortError'));
        }
      });
    }

    port.onMessage.addListener(
      (msg: {
        type?: string;
        chunk?: string;
        status?: number;
        bodyText?: string;
        error?: string;
      }) => {
        if (msg.type === 'CHUNK' && typeof msg.chunk === 'string') {
          full += msg.chunk;
          onChunk(msg.chunk);
          return;
        }
        if (msg.type === 'DONE') {
          settled = true;
          status = typeof msg.status === 'number' ? msg.status : 0;
          port.disconnect();
          resolve(new Response(typeof msg.bodyText === 'string' ? msg.bodyText : full, { status }));
          return;
        }
        if (msg.type === 'ERROR') {
          settled = true;
          port.disconnect();
          reject(new Error(msg.error || 'Stream proxy failed.'));
        }
      },
    );

    port.onDisconnect.addListener(() => {
      if (!settled) {
        settled = true;
        reject(new Error(chrome.runtime.lastError?.message || 'Stream proxy disconnected.'));
      }
    });

    const start: ApiStreamStartMessage = {
      type: 'START',
      path,
      method,
      headers: headersToRecord(headers),
      body,
      auth,
    };
    port.postMessage(start);
  });
}
