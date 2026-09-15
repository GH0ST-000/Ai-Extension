# Extension host permissions

## Network vs page access

- **Content script `matches`:** `<all_urls>` — required so the selection toolbar can run on arbitrary developer pages (GitHub, Jira, Swagger, localhost apps).
- **`host_permissions` (network):** narrowed to the Project X API origin only (`localhost:3001` in development). Production builds must add the real API origin (or grant via `optional_host_permissions`).

Content scripts **do not** call the API directly. All authenticated HTTP (including AI streams) goes through the **background service worker proxy** (`API_FETCH` / `api-stream` port). That removes host-page Origin CORS dependency and keeps tokens out of the page world.

## Compensating controls

- Access/refresh tokens live in `chrome.storage.session` (fallback: `local`), read only from extension contexts
- Background message allowlist: `PING`, `API_FETCH`; stream port `api-stream`
- Sender id checked; API proxy refuses URLs outside the configured API origin
- No `window.postMessage` bridge to page world
- No remote executable scripts; extension CSP `script-src 'self'`
- Optional host permissions remain available for future production API hosts without shipping `*://*/*` by default

## Production packaging note

Set `PLASMO_PUBLIC_API_URL` to your API and ensure the packaged `host_permissions` include that origin (or prompt the user for optional host permission at runtime).
