# Project X — Threat Model (Day 29)

Practical threat model for private-beta readiness. Not a compliance artifact.

## Assets

| Asset | Why it matters |
| --- | --- |
| User accounts / JWTs | Account takeover → workspace + provider abuse |
| Workspace data | Memory, systems, workflows, audit, billing |
| Private repository code (via GitHub PAT) | Confidentiality of customer code |
| GitHub / Jira tokens | Provider impersonation and write abuse |
| AI provider keys | Spend and data exfiltration to models |
| Billing / Paddle state | Fraudulent plan changes, portal abuse |
| Project Memory / workflow artifacts | Cross-tenant leakage of engineering context |
| Generated patches / comments / reviews | Unauthorized GitHub mutation |
| Cost / budget / usage counters | Quota bypass and runaway spend |

## Actors

- Legitimate user / workspace member
- Malicious workspace member (insider / compromised account)
- External unauthenticated attacker
- Malicious website hosting the extension content script
- Malicious repository / Jira / OpenAPI / CI content (prompt injection)
- Compromised AI provider response
- Webhook forger (Paddle)
- Credential thief (stolen JWT / PAT / logs)

## Trust boundaries

```
Host page (untrusted)
  → Extension content script (isolated world, untrusted DOM)
  → Extension background / popup (privileged extension context)
  → Dashboard browser (Bearer JWT in localStorage today)
  → Backend API (auth + authorization)
  → Postgres / Redis (private)
  → GitHub / Jira / Paddle / AI providers / public OpenAPI URLs
```

## Primary threats → controls

| Threat | Control |
| --- | --- |
| IDOR / cross-workspace leakage | Workspace membership checks; resource queries scoped by workspace; 404/403 without metadata |
| Role escalation | Explicit role transitions; only OWNER transfers ownership; ADMIN cannot demote OWNER |
| Provider token theft / misuse | AES-GCM at rest; never returned to clients; per-user tokens (membership ≠ provider access) |
| Prompt injection | Delimited untrusted blocks; capability allowlist; server-owned destinations/events/model/budget |
| Write escalation | Prepare → confirm; fingerprint binding; revalidation; no AI-selected destination/event |
| WRITE_OUTCOME_UNKNOWN replay | No automatic retry on uncertain mutations |
| SSRF (OpenAPI) | HTTPS-only; private IP / metadata block; DNS resolve + pinned connect (Host/SNI); bounded redirects/size/time; infra egress allowlist (see network-egress.md) |
| Data store transit | Remote Postgres/Redis require TLS in production (`DATABASE_SSL` / URL sslmode, `REDIS_TLS`) |
| XSS | No raw AI HTML; text/Markdown without script; CSP |
| CORS / CSRF | Exact origin allowlist; Bearer auth (no cookie session CSRF surface); document remaining risks |
| Webhook spoofing | Raw-body HMAC; timing-safe compare; event idempotency; fail-closed without secret in production |
| Cache poisoning / cross-tenant | Server-computed keys; auth before cache return; workspace in key |
| Path traversal (patch) | Canonical repo-relative path validation |
| Secret leakage | Redaction; no secrets in client bundles; CI secret scan |
| Abuse | Rate limits on auth/AI/writes/billing/telemetry/invites |
| Supply chain | Frozen lockfile; Dependabot; CodeQL; pinned Actions; least workflow permissions |
| Production misconfig | Startup fail-closed on default secrets, wildcard CORS, missing encryption key |
| Security incident handling | [incident-response.md](./incident-response.md) runbook (roles, severity, contain, postmortem) |
| Secret compromise | [encryption-key-rotation.md](./encryption-key-rotation.md); `sessionVersion` bump; `scripts/security/rotate-secrets-runbook.sh` |
| Detection / SIEM | Pino logs + [siem-export.md](./siem-export.md) (`GET /api/internal/observability/security-events`, fail-closed token) |
| Enterprise IdP | [sso-scim.md](./sso-scim.md) architecture scaffold only (env placeholders; no live SAML/SCIM) |
| External assessment | [pen-test-ready.md](./pen-test-ready.md) scope and readiness checklist |

## Explicit non-goals (Day 29)

SOC 2 attestation, managed WAF/SIEM platform, full DLP, Chrome Web Store launch. **Scaffolds** for SSO/SCIM, SIEM export, pen-test prep, and incident response exist — see table above — but are not full enterprise programs.
