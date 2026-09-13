# Project X — Security Baseline Invariants

Release-blocking invariants for Day 30 private beta. These must match code and tests.

1. **No cross-workspace resource access by ID** — membership + workspace scope required.
2. **Workspace membership ≠ provider access** — GitHub/Jira tokens are per-user; never shared silently.
3. **No GitHub / Jira / AI / Paddle secrets in client bundles** (dashboard or extension).
4. **AI cannot select GitHub write destination** — destination from trusted PR context + server validation.
5. **AI cannot select APPROVE / REQUEST_CHANGES** — user selects; default COMMENT.
6. **No write without explicit user confirmation** — prepare/confirm with server-issued state.
7. **WRITE_OUTCOME_UNKNOWN is never blindly retried.**
8. **OpenAPI fetch cannot reach localhost / private / cloud metadata.**
9. **AI / Markdown content cannot execute script** — no raw HTML from model/provider text.
10. **Host page cannot invoke privileged extension actions** — typed allowlisted messages only.
11. **Production CORS never allows arbitrary credentialed origins** — exact allowlist only.
12. **Client cannot choose arbitrary Paddle price** — server resolves price from plan + cycle.
13. **Client cannot override AI model / budget / retries.**
14. **AI cache cannot leak private results across workspaces.**
15. **Production refuses known auth/security bypass / default secret configs.**
16. **Webhook mutations require valid signature verification.**
17. **Patch path traversal is rejected before GitHub mutation.**
18. **Secrets do not appear in logs, Sentry, audit bodies, or Copy Diagnostics.**

## Auth architecture note

Project X uses Bearer JWTs (dashboard `localStorage`, extension `chrome.storage.local`).  
There is no cookie session → classical CSRF is lower risk than cookie apps; Origin allowlisting still applies for browser clients.  
Logout increments server `sessionVersion` so previously issued JWTs fail validation.  
Remaining limitation: XSS in the dashboard/extension UI can still read stored JWTs — mitigated by CSP, short JWT lifetime, and no provider secrets in the browser.

## Provider access model

- Personal GitHub PAT / Jira API token: owned by the connecting user, encrypted at rest, used only for that user’s provider calls.
- Workspace membership grants product features, not another member’s provider credentials.
- No workspace-shared GitHub App installation in the current architecture.

## CSRF decision

Bearer Authorization header is required for authenticated mutations. Cookies are not used for auth.  
CSRF tokens are therefore not required for the current architecture. Sensitive browser calls still use exact CORS origin allowlists.
