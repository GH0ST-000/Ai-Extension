# SIEM / security event export

Project X does not ship a managed SIEM. This document describes how to **export security-relevant events** for ingestion by Datadog, Splunk, Elastic, Chronicle, etc.

## Event sources

| Source | Format | Notes |
| --- | --- | --- |
| **In-process security audit buffer** | JSON Lines (NDJSON) | Auth and session events; pull via internal API (below). |
| **HTTP access logs** | JSON (Pino) | Request id, route template, status; secrets redacted. Ship stdout from API pods. |
| **Workflow audit** | Postgres `workflow_audit_events` | AI/workflow executions; query by workspace for investigations (not on the pull API today). |
| **Metrics** | Prometheus text | `GET /api/metrics` with `METRICS_SCRAPE_TOKEN`. |

## Pull API (JSONL)

**Endpoint:** `GET /api/internal/observability/security-events`

**Auth (fail-closed in production):**

- `Authorization: Bearer <INTERNAL_OBSERVABILITY_TOKEN>`, or
- Header `X-Internal-Token: <INTERNAL_OBSERVABILITY_TOKEN>`

If `INTERNAL_OBSERVABILITY_TOKEN` is unset in production, the API refuses startup (see production security checks). If unset in development, the endpoint is open for local testing only.

**Query parameters:**

| Param | Default | Description |
| --- | --- | --- |
| `since` | — | ISO-8601 timestamp; return events at or after this time. |
| `limit` | `1000` | Max events (capped at 5000). |

**Response:** `Content-Type: application/x-ndjson` — one `SecurityAuditEvent` JSON object per line.

**Example:**

```bash
curl -sS \
  -H "Authorization: Bearer $INTERNAL_OBSERVABILITY_TOKEN" \
  "https://api.example.com/api/internal/observability/security-events?since=2026-09-14T00:00:00.000Z&limit=500" \
  -o security-events.ndjson
```

Schedule this from a cron job, sidecar, or log forwarder in your cluster. The in-memory buffer retains the most recent **5,000** events per API instance — for long retention, **persist pulled NDJSON** in your SIEM or object storage.

## Field hygiene

Events follow `SecurityAuditEvent` in `@project-x/types`:

- **Included:** event type, outcome, timestamp, service/release/environment, hashed user id (`actorUserIdHash`), hashed email domain on auth failures, optional `requestId` / `workspaceId`.
- **Excluded:** passwords, tokens, PATs, prompts, raw email, full IP (optional truncated operational ip only when already present on auth context).

Do not add secrets to `detail`.

## Recommended SIEM rules (starter)

- Spike in `auth.login.failure` from one `emailDomainHash` or many domains (credential stuffing).
- Any `auth.refresh.reuse_detected` (possible refresh token theft).
- Correlation: SEV auth failures + new GitHub write errors for same `actorUserIdHash`.

## Related

- [incident-response.md](./incident-response.md)
- [security-baseline.md](./security-baseline.md)
