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

function hostMatchesApi(cookieDomain: string, apiHostname: string): boolean {
  const domain = cookieDomain.replace(/^\./, '');
  return (
    domain === apiHostname ||
    apiHostname === domain ||
    apiHostname.endsWith(`.${domain}`) ||
    (domain === 'localhost' && (apiHostname === 'localhost' || apiHostname === '127.0.0.1')) ||
    (domain === '127.0.0.1' && (apiHostname === 'localhost' || apiHostname === '127.0.0.1'))
  );
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

async function readCookieValue(name: string): Promise<string | null> {
  if (!canUseCookies()) return null;

  const fromUrls = await Promise.all(candidateApiUrls().map((url) => cookiesGet(url, name)));
  for (const cookie of fromUrls) {
    if (cookie?.value) {
      return cookie.value;
    }
  }

  try {
    const apiHostname = new URL(apiUrl()).hostname;
    const all = await cookiesGetAll(name);
    const match = all.find((cookie) => hostMatchesApi(cookie.domain, apiHostname));
    if (match?.value) {
      return match.value;
    }
  } catch {
    // ignore
  }

  return null;
}

/** Read HttpOnly access JWT set by dashboard (or extension) login. */
export async function readAccessTokenFromBrowserCookie(): Promise<string | null> {
  return readCookieValue(ACCESS_COOKIE_NAME);
}

export async function readRefreshTokenFromBrowserCookie(): Promise<string | null> {
  if (!canUseCookies()) return null;

  const refreshUrls = [
    ...candidateApiUrls().map((u) => `${u.replace(/\/$/, '')}/api/auth/refresh`),
    ...candidateApiUrls(),
  ];
  const fromUrls = await Promise.all(
    refreshUrls.map((url) => cookiesGet(url, REFRESH_COOKIE_NAME)),
  );
  for (const cookie of fromUrls) {
    if (cookie?.value) {
      return cookie.value;
    }
  }

  try {
    const apiHostname = new URL(apiUrl()).hostname;
    const all = await cookiesGetAll(REFRESH_COOKIE_NAME);
    const match = all.find((cookie) => hostMatchesApi(cookie.domain, apiHostname));
    if (match?.value) {
      return match.value;
    }
  } catch {
    // ignore
  }

  return null;
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
