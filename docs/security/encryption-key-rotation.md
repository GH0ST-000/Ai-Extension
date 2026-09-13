# Token encryption key rotation (minimal)

Provider tokens (GitHub PAT, Jira API token) are stored as AES-256-GCM ciphertext:

`v1:<iv>:<tag>:<ciphertext>`

## Rotate procedure

1. Generate a new 32+ byte secret for `TOKEN_ENCRYPTION_KEY`.
2. Deploy a maintenance window where new writes use the new key **after** a dual-read migration (not automated in Day 29).
3. For Day 29 private beta: rotate by reconnecting provider tokens after key change (users re-paste PAT/API token).
4. Never store the encryption key in the database or client bundles.
5. Keep `TOKEN_ENCRYPTION_KEY` distinct from `JWT_SECRET`.

Key versioning beyond the `v1` prefix is reserved for a later migration if needed.
