# Extension host permissions (Day 29)

## Why broad host permissions exist

Selected-text AI and Smart Actions must run on arbitrary developer pages
(GitHub, Jira, Swagger UI, internal docs, local `http://localhost` apps).

Therefore the Plasmo manifest currently declares:

- `host_permissions`: `https://*/*`, `http://*/*`
- content script `matches`: `<all_urls>` (selection toolbar)

This is intentional for the product surface, not accidental over-privilege.

## Compensating controls

- JWT lives in `chrome.storage.local` (not page JS)
- Background message allowlist (`PING` only); sender id checked
- No `window.postMessage` bridge to page world
- No remote executable scripts; extension CSP `script-src 'self'`
- API calls use Bearer tokens; production CORS uses exact origin allowlists
- Content extraction remains bounded (Day 4 policy)

## Future least-privilege option

Optional permissions / `activeTab` for non-integration pages can be explored post-beta
without removing GitHub/Jira/OpenAPI coverage.
