/** Shared API origin for extension network calls. */
export function getApiBaseUrl(): string {
  const configured = process.env.PLASMO_PUBLIC_API_URL?.trim();
  return (configured && configured.length > 0 ? configured : 'http://localhost:3001').replace(
    /\/$/,
    '',
  );
}

export function getApiOrigin(): string {
  try {
    return new URL(getApiBaseUrl()).origin;
  } catch {
    return 'http://localhost:3001';
  }
}

/** True when running inside a host-page content script (CORS applies). */
export function needsApiProxy(): boolean {
  try {
    const href = globalThis.location?.href ?? '';
    return href.startsWith('http:') || href.startsWith('https:');
  } catch {
    return false;
  }
}

export function assertAllowedApiUrl(url: string): void {
  const allowed = getApiOrigin();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid API URL.');
  }
  if (parsed.origin !== allowed) {
    throw new Error('Refusing to proxy request outside the configured API origin.');
  }
}
