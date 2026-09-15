# Incident response runbook

Operational playbook for security incidents affecting Project X (API, dashboard, extension). This is not a compliance program; it defines **who does what** before SOC 2 or a retainer firm is in place.

## Roles

| Role | Responsibility |
| --- | --- |
| **Incident commander (IC)** | Owns timeline, severity, comms cadence, and postmortem. Usually on-call engineer or eng lead. |
| **Security lead** | Triage impact, containment decisions, key rotation, evidence preservation. |
| **Engineering** | Deploy mitigations, query logs/DB, implement fixes. |
| **Comms / leadership** | Customer notice, status page, legal/regulatory if required. |

Document primary and backup contacts in your internal ops wiki (not in this repo).

## Severity

| Level | Examples | Target response |
| --- | --- | --- |
| **SEV-1** | Confirmed cross-tenant data leak; production DB/secret exfil; active account takeover at scale | IC within 15 min; contain within 1 h |
| **SEV-2** | Single-tenant data exposure; compromised admin/service token; webhook bypass attempt succeeding | IC within 30 min; contain same business day |
| **SEV-3** | Failed intrusion (blocked auth, rate limits); dependency CVE with exploitable path in our stack | Triage within 4 h; patch per [dependency-audit.md](./dependency-audit.md) |
| **SEV-4** | Suspicious activity with no confirmed impact; phishing targeting employees | Log and monitor |

## Detection sources

- Structured API logs (Pino) — ship to your log platform; never log secrets or tokens ([security-baseline.md](./security-baseline.md)).
- **Security audit export** — `GET /api/internal/observability/security-events` (JSONL); see [siem-export.md](./siem-export.md).
- Sentry / client telemetry anomalies.
- Customer report, GitHub/Paddle security advisories, Dependabot/CodeQL.

## Notify (internal)

1. IC opens a private incident channel (Slack/Teams) and a tracking doc (timeline, hypotheses, actions).
2. Page **security lead** + **on-call engineering** for SEV-1/2.
3. For SEV-1 involving customer data: notify **leadership** and **legal** before external comms.
4. Do **not** post credentials, tokens, or raw customer code in the channel — use redacted summaries.

## Contain

Work in order; skip steps already done if the threat is isolated.

1. **Stop the bleeding**
   - Revoke compromised user sessions: increment `sessionVersion` / force logout-all for affected users (see [encryption-key-rotation.md](./encryption-key-rotation.md)).
   - Disable compromised API keys (OpenAI, Paddle, GitHub App) at the provider console.
   - Block abusive IPs at edge/WAF if available (not built into app today).
2. **Rotate secrets** — follow [encryption-key-rotation.md](./encryption-key-rotation.md) and `scripts/security/rotate-secrets-runbook.sh` (outline).
3. **Deploy hotfix** — patch IDOR, SSRF, auth bypass, or webhook verification gaps; verify with tests.
4. **Preserve evidence** — export security-event JSONL, snapshot relevant DB rows (audit tables), retain log windows before rotation.

## Eradicate & recover

- Root-cause the flaw (code, config, or process).
- Redeploy from known-good artifacts; confirm production security checks pass at startup (`assertProductionSecurity`).
- Re-enable features gradually; watch error rates and security-event volume.

## Customer communication

- SEV-1/2 with customer impact: draft notice with IC + leadership — what happened, what data classes, what users should do (password reset, reconnect GitHub/Jira).
- No public detail on unfixed vulnerabilities.

## Postmortem (within 5 business days for SEV-1/2)

Blameless write-up including:

- Timeline (UTC)
- Impact (tenants, data classes, duration)
- Root cause and contributing factors
- What worked / what didn’t in this runbook
- Action items with owners and dates (code, monitoring, process)

Link postmortems from your internal wiki; do not store customer PII in the repo.

## Related docs

- [threat-model.md](./threat-model.md)
- [encryption-key-rotation.md](./encryption-key-rotation.md)
- [siem-export.md](./siem-export.md)
- [pen-test-ready.md](./pen-test-ready.md)
