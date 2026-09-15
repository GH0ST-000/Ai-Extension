#!/usr/bin/env bash
# Project X — secret rotation ops outline (safe by default).
#
# This script does NOT rotate secrets automatically. It prints a checklist and
# optional SQL snippets for operators. Review docs/security/encryption-key-rotation.md
#
# Usage:
#   ./scripts/security/rotate-secrets-runbook.sh jwt
#   ./scripts/security/rotate-secrets-runbook.sh token-encryption
#   ./scripts/security/rotate-secrets-runbook.sh webhooks
#   ./scripts/security/rotate-secrets-runbook.sh session-invalidate-all
#
set -euo pipefail

ACTION="${1:-help}"

gen_secret_hint() {
  if command -v openssl >/dev/null 2>&1; then
    echo "  Example new value: $(openssl rand -base64 32)"
  else
    echo "  Generate 32+ random bytes via your secrets manager."
  fi
}

case "$ACTION" in
  jwt)
    cat <<'EOF'
JWT_SECRET rotation checklist
-----------------------------
1. Generate new JWT_SECRET (≥32 chars, not a dev default).
2. Update secret in deploy env / secrets manager (not in git).
3. Plan global session invalidation (sessionVersion bump + refresh revoke).
4. Deploy API with new JWT_SECRET.
5. Verify login, refresh, logout (dashboard cookies + extension Bearer).

Optional emergency SQL (run against Postgres with care):
  UPDATE users SET session_version = session_version + 1;
  UPDATE refresh_tokens SET revoked_at = NOW() WHERE revoked_at IS NULL;
EOF
    gen_secret_hint
    ;;
  token-encryption)
    cat <<'EOF'
TOKEN_ENCRYPTION_KEY rotation checklist
---------------------------------------
1. Announce maintenance: users must reconnect GitHub/Jira tokens.
2. Generate new TOKEN_ENCRYPTION_KEY (≥32 chars, distinct from JWT_SECRET).
3. Update deploy env; deploy API.
4. Users reconnect provider credentials in settings.
5. Remove or ignore rows that fail decrypt (disconnected state).

Dual-key migration is NOT implemented — do not rotate without reconnect plan.
EOF
    gen_secret_hint
    ;;
  webhooks)
    cat <<'EOF'
Webhook secret rotation (PADDLE_WEBHOOK_SECRET, GITHUB_APP_WEBHOOK_SECRET)
---------------------------------------------------------------------------
1. Create new secret in Paddle / GitHub App settings.
2. Update matching env vars on API.
3. Deploy; confirm webhook deliveries succeed (no signature failures).
4. Remove old secret at provider when traffic is clean.
EOF
    ;;
  session-invalidate-all)
    cat <<'EOF'
Global session invalidation (incident response)
------------------------------------------------
Use after JWT compromise or refresh token reuse at scale.

SQL (Postgres):
  UPDATE users SET session_version = session_version + 1;
  UPDATE refresh_tokens SET revoked_at = NOW() WHERE revoked_at IS NULL;

Then verify auth metrics and security-events export (auth.login.success baseline).
EOF
    ;;
  help|*)
    echo "Usage: $0 {jwt|token-encryption|webhooks|session-invalidate-all}"
    exit 0
    ;;
esac
