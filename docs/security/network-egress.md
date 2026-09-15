# Network egress and SSRF hardening

Project X assumes **defense in depth**: application-level SSRF controls plus infrastructure egress restrictions.

## Application controls (API)

- **OpenAPI document fetch** (`OpenApiFetchService`) is the only user-influenced server-side URL fetch. It is not a generic HTTP proxy.
- URLs pass static validation in `@project-x/shared` (`validateOpenApiFetchUrl`): HTTPS-only, no credentials, blocked hostnames, no private/reserved IP literals.
- Before each hop, the API **resolves DNS**, rejects private/link-local/metadata addresses, **connects to the resolved IP**, and sends the original hostname in the `Host` header and TLS SNI (`dnsPinnedFetch`). This closes the DNS rebinding window between check and connect.
- Redirects are manual, capped, and re-validated per hop.

Other outbound HTTP calls (GitHub, Jira, OpenAI, Paddle) target fixed provider base URLs, not arbitrary user input.

## Infrastructure expectation (not enforced in-app)

Deploy the API in a network segment where **egress is allowlisted** at the firewall / security group / service mesh layer. Recommended minimum allowlist:

| Destination | Purpose |
| --- | --- |
| Managed Postgres (your provider) | Primary database |
| Managed Redis (your provider) | Rate limits, locks, ephemeral state |
| `api.openai.com` (or your AI provider) | Model inference |
| `api.github.com`, `github.com` | GitHub API and OAuth/App flows |
| `*.atlassian.net` (your site only, if possible) | Jira Cloud |
| `api.paddle.com`, `sandbox-api.paddle.com` | Billing |
| Public HTTPS hosts users may supply for OpenAPI URLs | OpenAPI acquisition (still SSRF-hardened in app) |

Block RFC1918, link-local, metadata (`169.254.169.254`), and internal service CIDRs from the API task role even when application checks pass.

Document and review the allowlist on every new integration or region change.

## TLS to data stores (production)

For **remote** Postgres and Redis (non-localhost):

- **Postgres:** set `DATABASE_SSL=true` or include `sslmode=require` (or `verify-full`) in `DATABASE_URL`.
- **Redis:** set `REDIS_TLS=true` for managed Redis endpoints.

Production startup **fail-closed** checks (`collectProductionSecurityIssues`) reject remote database/Redis hosts without TLS configuration. Local development may omit TLS for Docker Compose services.
