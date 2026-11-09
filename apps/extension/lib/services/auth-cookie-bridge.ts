import { getApiBaseUrl } from '../api/api-base-url';

/** Must match apps/api auth-cookies ACCESS_COOKIE / REFRESH_COOKIE. */
export const ACCESS_COOKIE_NAME = 'px_at';
export const REFRESH_COOKIE_NAME = 'px_rt';

const COOKIE_OP_TIMEOUT_MS = 800;

function apiUrl(): string {
  return getApiBaseUrl().replace(/\/$/, '');
}

function cookieSecure(): boolean {
  return apiUrl().startsWith('https:');
}

function candidateApiUrls(): string[] {
  const primary = apiUrl();
  const urls = new Set<string>([primary, `${primary}/`]);
  try {
    const parsed = new URL(primary);
    if (parsed.hostname === 'localhost') {
      urls.add(`${parsed.protocol}//127.0.0.1${parsed.port ? `:${parsed.port}` : ''}`);
    } else if (parsed.hostname === '127.0.0.1') {
      urls.add(`${parsed.protocol}//localhost${parsed.port ? `:${parsed.port}` : ''}`);
    }
  } catch {
    // ignore
  }
  return [...urls];
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function canUseCookies(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.cookies?.get);
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/**
 * The API sets px_at / px_rt as host-only cookies on its own hostname. Accept only
 * those: a cookie scoped to a parent domain (Domain=.example.com) can be planted by
 * any sibling subdomain and must never be adopted as the user's session.
 */
export function isTrustedApiCookie(
  cookie: Pick<chrome.cookies.Cookie, 'domain' | 'hostOnly'>,
  apiHost: string,
): boolean {
  if (!cookie.hostOnly) {
    return false;
  }
  const domain = cookie.domain.replace(/^\./, '');
  return domain === apiHost || (isLoopback(domain) && isLoopback(apiHost));
}

function apiHostname(): string | null {
  try {
    return new URL(apiUrl()).hostname;
  } catch {
    return null;
  }
}

async function cookiesGet(url: string, name: string): Promise<chrome.cookies.Cookie | null> {
  if (!canUseCookies()) return null;
  return withTimeout(
    new Promise<chrome.cookies.Cookie | null>((resolve) => {
      try {
        chrome.cookies.get({ url, name }, (cookie) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(cookie ?? null);
        });
      } catch {
        resolve(null);
      }
    }),
    COOKIE_OP_TIMEOUT_MS,
    null,
  );
}

async function cookiesGetAll(name: string): Promise<chrome.cookies.Cookie[]> {
  if (!canUseCookies()) return [];
  return withTimeout(
    new Promise<chrome.cookies.Cookie[]>((resolve) => {
      try {
        chrome.cookies.getAll({ name }, (cookies) => {
          if (chrome.runtime.lastError) {
            resolve([]);
            return;
          }
          resolve(cookies ?? []);
        });
      } catch {
        resolve([]);
      }
    }),
    COOKIE_OP_TIMEOUT_MS,
    [],
  );
}

async function readTrustedCookieValue(name: string, urls: string[]): Promise<string | null> {
  if (!canUseCookies()) return null;
  const host = apiHostname();
  if (!host) return null;

  // cookies.get(url) can return a parent-domain cookie, so every hit is re-checked.
  const fromUrls = await Promise.all(urls.map((url) => cookiesGet(url, name)));
  for (const cookie of fromUrls) {
    if (cookie?.value && isTrustedApiCookie(cookie, host)) {
      return cookie.value;
    }
  }

  const all = await cookiesGetAll(name);
  const match = all.find((cookie) => cookie.value && isTrustedApiCookie(cookie, host));
  return match?.value ?? null;
}

/** Read HttpOnly access JWT set by dashboard (or extension) login. */
export async function readAccessTokenFromBrowserCookie(): Promise<string | null> {
  return readTrustedCookieValue(ACCESS_COOKIE_NAME, candidateApiUrls());
}

export async function readRefreshTokenFromBrowserCookie(): Promise<string | null> {
  return readTrustedCookieValue(REFRESH_COOKIE_NAME, [
    ...candidateApiUrls().map((u) => `${u.replace(/\/$/, '')}/api/auth/refresh`),
    ...candidateApiUrls(),
  ]);
}

/**
 * Whether the browser still holds any trusted auth cookie for the API.
 * Returns null when that cannot be determined (no cookies API, timeout, error), so
 * callers never treat a failed read as a logout.
 */
export async function hasTrustedAuthCookies(): Promise<boolean | null> {
  if (!canUseCookies()) return null;
  const host = apiHostname();
  if (!host) return null;
  const lists = await Promise.all(
    [ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME].map((name) =>
      withTimeout(
        new Promise<chrome.cookies.Cookie[] | null>((resolve) => {
          try {
            chrome.cookies.getAll({ name }, (cookies) => {
              resolve(chrome.runtime.lastError ? null : (cookies ?? []));
            });
          } catch {
            resolve(null);
          }
        }),
        COOKIE_OP_TIMEOUT_MS,
        null,
      ),
    ),
  );
  if (lists.some((list) => list === null)) {
    return null;
  }
  return lists.some((list) =>
    list!.some((cookie) => Boolean(cookie.value) && isTrustedApiCookie(cookie, host)),
  );
}

/** Write auth cookies so the dashboard SPA shares the extension session. */
export async function writeAuthCookiesToBrowser(input: {
  accessToken: string;
  refreshToken?: string;
  accessMaxAgeSeconds?: number;
  refreshMaxAgeSeconds?: number;
}): Promise<void> {
  if (!canUseCookies()) return;

  const secure = cookieSecure();
  const accessMaxAge = input.accessMaxAgeSeconds ?? 15 * 60;
  const refreshMaxAge = input.refreshMaxAgeSeconds ?? 7 * 24 * 60 * 60;
  const now = Date.now() / 1000;

  // Prefer the configured API origin first; mirror to the localhost/127 twin.
  const urls = candidateApiUrls().filter((u) => !u.endsWith('/') || u === `${apiUrl()}/`);
  const unique = [...new Set(urls.map((u) => u.replace(/\/$/, '')))];

  for (const base of unique) {
    await withTimeout(
      new Promise<void>((resolve) => {
        try {
          chrome.cookies.set(
            {
              url: base,
              name: ACCESS_COOKIE_NAME,
              value: input.accessToken,
              path: '/',
              httpOnly: true,
              secure,
              sameSite: 'lax',
              expirationDate: now + accessMaxAge,
            },
            () => {
              void chrome.runtime.lastError;
              resolve();
            },
          );
        } catch {
          resolve();
        }
      }),
      COOKIE_OP_TIMEOUT_MS,
      undefined,
    );

    if (input.refreshToken) {
      await withTimeout(
        new Promise<void>((resolve) => {
          try {
            chrome.cookies.set(
              {
                url: `${base}/api/auth/refresh`,
                name: REFRESH_COOKIE_NAME,
                value: input.refreshToken!,
                path: '/api/auth',
                httpOnly: true,
                secure,
                sameSite: 'lax',
                expirationDate: now + refreshMaxAge,
              },
              () => {
                void chrome.runtime.lastError;
                resolve();
              },
            );
          } catch {
            resolve();
          }
        }),
        COOKIE_OP_TIMEOUT_MS,
        undefined,
      );
    }
  }
}

export async function clearAuthCookiesFromBrowser(): Promise<void> {
  if (!canUseCookies()) return;
  const removals: Promise<unknown>[] = [];
  for (const url of candidateApiUrls()) {
    const base = url.replace(/\/$/, '');
    for (const target of [
      { url: base, name: ACCESS_COOKIE_NAME },
      { url: `${base}/api/auth/refresh`, name: REFRESH_COOKIE_NAME },
      { url: base, name: REFRESH_COOKIE_NAME },
    ] as const) {
      removals.push(
        withTimeout(
          new Promise<void>((resolve) => {
            try {
              chrome.cookies.remove(target, () => resolve());
            } catch {
              resolve();
            }
          }),
          COOKIE_OP_TIMEOUT_MS,
          undefined,
        ),
      );
    }
  }
  await Promise.all(removals);
}
