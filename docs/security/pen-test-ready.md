# Penetration test & bug bounty readiness

Checklist to prepare for an external pen test or a **private** bug bounty program. Adjust scope with your vendor before testing starts.

## Scope (typical in-scope)

| Asset | Host / surface |
| --- | --- |
| Project X API | Production or dedicated **staging** mirror with production-like config |
| Dashboard | `APP_BASE_URL` / `NEXT_PUBLIC_APP_URL` |
| Browser extension | Packed build from release branch (MV3) |
| Public webhooks | Paddle Billing, GitHub App (signature-verified endpoints only) |

## Out of scope (unless explicitly agreed)

- Third-party services (GitHub.com, Atlassian, OpenAI, Paddle) except our integration endpoints.
- Denial-of-service / load testing against shared production without rate-limit-safe staging.
- Social engineering of employees or customers.
- Physical access, office networks, employee devices.
- Finding known accepted risks documented in [threat-model.md](./threat-model.md) non-goals without a new exploit path.
- Chrome Web Store listing (not launched).

## Test accounts & data

- Provide **dedicated workspace(s)** with synthetic repos/issues — no real customer PATs.
- Document test user emails and roles (OWNER, ADMIN, MEMBER).
- GitHub/Jira: use sandbox tokens or mock integrations where possible.

## Rules of engagement

- Use `X-Pentest: <vendor-id>` header or agreed User-Agent for traceability (optional).
- Stop and notify on **confirmed** cross-tenant data access — do not exfiltrate beyond proof.
- Report critical findings to security contact within **24 hours**; full report per vendor SLA.

## Contacts (fill in internally)

| Role | Name | Email / Pager |
| --- | --- | --- |
| Security lead | _TBD_ | |
| Incident commander | _TBD_ | |
| Legal (customer data) | _TBD_ | |

## Evidence we expect from testers

- CVSS or severity rationale mapped to our [incident-response.md](./incident-response.md) levels.
- Repro steps with request IDs (`X-Request-Id`) and timestamps (UTC).
- No secrets in reports — redact tokens.

## Pre-test engineering checklist

- [ ] Production secrets not defaults; `assertProductionSecurity` passes on staging.
- [ ] `INTERNAL_OBSERVABILITY_TOKEN`, webhook secrets, and encryption keys in secrets manager.
- [ ] [siem-export.md](./siem-export.md) wired or logs shipped for test window.
- [ ] [incident-response.md](./incident-response.md) roles assigned for test dates.
- [ ] Dependency audit current ([dependency-audit.md](./dependency-audit.md)).
- [ ] Rate limits enabled on auth/AI/write paths.

## Post-test

- Triage findings → tickets with owners.
- SEV-1/2 fixes before retest; postmortem if customer data touched.

## Bug bounty (optional later)

- Start **private** invite-only on HackerOne/Bugcrowd or VDP email.
- Publish scope aligned with this document; exclude duplicate/low-impact auth enumeration if accepted risk.
- Define safe harbor for good-faith research on in-scope assets only.
