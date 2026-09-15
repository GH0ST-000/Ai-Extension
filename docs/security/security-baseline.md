# Project X — Security Baseline Invariants

Release-blocking invariants for Day 30 private beta. These must match code and tests.

1. **No cross-workspace resource access by ID** — membership + workspace scope required.
2. **Workspace membership ≠ provider access** — GitHub/Jira tokens are per-user; never shared silently.
3. **No GitHub / Jira / AI / Paddle secrets in client bundles** (dashboard or extension).
4. **AI cannot select GitHub write destination** — destination from trusted PR context + server validation.
5. **AI cannot select APPROVE / REQUEST_CHANGES** — user selects; default COMMENT.
6. **No write without explicit user confirmation** — prepare/confirm with server-issued state.
7. **WRITE_OUTCOME_UNKNOWN is never blindly retried.**
8. **OpenAPI fetch cannot reach localhost / private / cloud metadata** — DNS resolve, pin connect to public IP, Host/SNI preserved; see [network-egress.md](./network-egress.md).
9. **AI / Markdown content cannot execute script** — no raw HTML from model/provider text.
10. **Host page cannot invoke privileged extension actions** — typed allowlisted messages only.
11. **Production CORS never allows arbitrary credentialed origins** — exact allowlist only.
12. **Client cannot choose arbitrary Paddle price** — server resolves price from plan + cycle.
13. **Client cannot override AI model / budget / retries.**
14. **AI cache cannot leak private results across workspaces.**
15. **Production refuses known auth/security bypass / default secret configs.**
16. **Webhook mutations require valid signature verification** — Paddle Billing uses `Paddle-Signature` (`ts=…;h1=…`, HMAC-SHA256 over `timestamp:rawBody`, ~5s replay window). Production rejects sandbox Paddle config and dedupes `event_id`.
17. **Patch path traversal is rejected before GitHub mutation.**
18. **Secrets do not appear in logs, Sentry, audit bodies, or Copy Diagnostics.**

## Auth architecture note

Project X uses short-lived Bearer JWTs plus rotating refresh tokens.

- **Dashboard:** access + refresh tokens are set as **HttpOnly `SameSite=Lax` cookies** (`px_at`, `px_rt`). The browser JS never stores the access token (legacy `localStorage` keys are purged). Profile cache may live in `sessionStorage`.
- **Extension:** may receive tokens in the JSON body for background/session storage only (not page `localStorage`). Prefer background proxy (#2) so content scripts never hold tokens.
- Logout increments `sessionVersion` (invalidates access JWTs) and revokes refresh token families. Refresh reuse of a revoked token revokes the entire family.
- CORS is credentialed (`credentials: true`) with exact origin allowlists.

## Provider access model

- Personal GitHub PAT / Jira API token: owned by the connecting user, encrypted at rest, used only for that user’s provider calls.
- Workspace membership grants product features, not another member’s provider credentials.
- No workspace-shared GitHub App installation in the current architecture.

## CSRF decision

Dashboard cookie auth uses `SameSite=Lax` + credentialed CORS with an exact origin allowlist.  
Mutations from other sites cannot read responses cross-origin; Lax blocks most cross-site POSTs that would include cookies.  
Extension calls continue to use the `Authorization` Bearer header (not cookies).  
Double-submit CSRF tokens remain a follow-up hardening option for highest-assurance environments.
