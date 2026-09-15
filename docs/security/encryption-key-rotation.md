# Secret & encryption key rotation

Provider tokens (GitHub PAT, Jira API token) are stored as AES-256-GCM ciphertext:

`v1:<iv>:<tag>:<ciphertext>`

This runbook covers **JWT signing**, **token encryption**, and **webhook HMAC secrets**, plus session invalidation via `sessionVersion`.

## Secrets inventory

| Secret | Env var | Impact if rotated |
| --- | --- | --- |
| JWT signing | `JWT_SECRET` | All access JWTs invalid immediately |
| Provider token encryption | `TOKEN_ENCRYPTION_KEY` | Existing ciphertext undecryptable unless dual-key migration |
| Paddle webhooks | `PADDLE_WEBHOOK_SECRET` | Old signatures rejected after deploy |
| GitHub App webhooks | `GITHUB_APP_WEBHOOK_SECRET` | Same |
| Internal ops | `INTERNAL_OBSERVABILITY_TOKEN`, `METRICS_SCRAPE_TOKEN`, `HEALTH_DETAILS_TOKEN` | Scrapers/exporters must update |
| SCIM (future) | `SCIM_BEARER_TOKEN` | SCIM clients must update |

Keep `TOKEN_ENCRYPTION_KEY` **distinct** from `JWT_SECRET` in production.

## Generate new material

```bash
# 32+ bytes, base64url (example — use your secrets manager in prod)
openssl rand -base64 32
```

Store in your secrets manager; never commit to git or client bundles.

## JWT_SECRET rotation

1. Schedule a maintenance window (or accept forced re-login).
2. Set new `JWT_SECRET` in secrets manager / deploy env.
3. **Bump `sessionVersion` for all users** (or run logout-all per user) so old JWTs fail JWT strategy check (`sv` mismatch).
4. Deploy API; users refresh or sign in again.
5. Revoke all refresh token rows if you need immediate global logout:

   ```sql
   -- Emergency only — forces full re-auth
   UPDATE users SET session_version = session_version + 1;
   UPDATE refresh_tokens SET revoked_at = NOW() WHERE revoked_at IS NULL;
   ```

6. Verify: login, refresh, logout, extension Bearer flow.

## TOKEN_ENCRYPTION_KEY rotation

**Private beta (no dual-key migration):**

1. Notify users to reconnect GitHub/Jira (re-paste PAT/API token) after rotation.
2. Deploy new `TOKEN_ENCRYPTION_KEY`.
3. Clear or ignore rows that fail decrypt (connection shows disconnected).
4. Optional: delete stale encrypted credentials before deploy to avoid error noise.

**Future (dual-read):** deploy code that decrypts with current + previous key, re-encrypt on read, then retire old key.

## Webhook secret rotation (Paddle / GitHub App)

1. Generate new secret in provider console **and** in env.
2. Configure provider to send with new secret (or overlap window if provider supports two secrets).
3. Deploy API with new env value.
4. Monitor webhook 401/403 and billing/installation sync.

## sessionVersion bump guidance

Use when:

- JWT secret rotated
- Suspected refresh token theft (`auth.refresh.reuse_detected` in [siem-export.md](./siem-export.md))
- Account compromise response ([incident-response.md](./incident-response.md))

Per user (API): call logout-all / admin tooling when built.  
Global emergency: SQL above.

## Ops script outline

See [`scripts/security/rotate-secrets-runbook.sh`](../../scripts/security/rotate-secrets-runbook.sh) — **dry-run checklist only**; it does not mutate production by default.

## Verification checklist

- [ ] API starts with `NODE_ENV=production` and no `assertProductionSecurity` errors
- [ ] Sample user login + GitHub read after encryption key change (reconnected token)
- [ ] Paddle test webhook accepted
- [ ] GitHub App webhook delivery success (if enabled)
- [ ] Metrics scrape and security-events export still authenticate

Key versioning beyond the `v1` prefix is reserved for a later migration if needed.
