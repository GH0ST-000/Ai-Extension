# Password reset and transactional email

Project X sends one kind of email today: the password reset link. Email is delivered through
[Resend](https://resend.com) over its HTTPS API (no SDK). Marketing email is out of scope.

## Configuration

| Variable | Where | Purpose |
|---|---|---|
| `RESEND_API_KEY` | API only | Resend API key with **sending access only**. Never expose it to the dashboard or extension. |
| `MAIL_FROM` | API only | Verified sender, e.g. `Project X <no-reply@mail.example.com>`. |
| `APP_BASE_URL` | API (existing) | Public dashboard URL used to build the reset link. Already required to be non-localhost in production. |

- Set **both** `RESEND_API_KEY` and `MAIL_FROM` or **neither**. In production a half configuration
  (only one of them, or an invalid `MAIL_FROM`) stops the API at startup.
- With neither set, email is disabled: reset requests still return the normal response, no email
  is sent, the request is logged as `mail.not_configured`, and the token issued for it is revoked
  immediately. **Links are never written to logs** — not even in development.

### Setting up Resend safely
1. In Resend, add a sending domain you control (a subdomain such as `mail.example.com` keeps
   reputation separate from your main domain) and add the SPF, DKIM and (recommended) DMARC DNS
   records Resend shows. Wait until the domain is **Verified**.
2. Create an API key with permission **Sending access** restricted to that domain.
3. Store the key in your secret manager / deployment environment. Do not commit it, paste it in
   chat, or put it in `.env.example`.
4. Set `MAIL_FROM` to an address on the verified domain.

For local testing without a domain, Resend's onboarding sender (`onboarding@resend.dev`) only
delivers to the email address of your own Resend account.

## How it works

**Request** — `POST /api/auth/password-reset/request` `{ "email": "…" }`
- Always `202 { ok: true, message }` with the same message, whether or not the account exists,
  the request was throttled, or the provider failed. The work runs after the response.
- Per account: at most one new email per minute and five per hour; issuing a new link revokes
  older ones. Per IP: 5 requests / 15 minutes (`429` when exceeded, same for every email). The
  limiter fails closed if Redis is unavailable (`503`).
- Unknown emails: nothing is stored or sent.

**Confirm** — `POST /api/auth/password-reset/confirm` `{ "token": "…", "newPassword": "…" }`
- Same password rules as registration (8–128 characters).
- In one transaction: the token is consumed (single use, conditional update), the password hash
  is replaced (bcrypt, cost 12), `sessionVersion` is incremented (every access token stops
  working), every refresh token is revoked, and any other outstanding reset links are revoked.
- `200 { ok: true }`. The user is **not** signed in; they sign in with the new password.
- Invalid, expired (30 minutes) or used tokens: `400 PASSWORD_RESET_INVALID`, one message for all.
- Per IP: 10 confirmations / 15 minutes.

**Tokens** — 32 random bytes (base64url). Only the SHA-256 hash is stored in
`password_reset_tokens`. The link is `APP_BASE_URL/reset-password#token=…`: the token is in the
URL fragment, which browsers never send to servers, proxies or in `Referer` headers. The reset
page reads it, removes it from the address bar immediately and keeps it only in memory. Both
recovery pages are served with `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
`noindex`.

## Provider failure
If Resend is down, rejects the request or times out (10 s), the user still sees the normal
message, the token for that request is revoked, and the API logs `mail.failed` with a reason and
HTTP status only (no recipient, link or provider message). The user can simply request again.
Watch for `mail.failed` / `mail.not_configured` in logs.

## Migration
`apps/api/prisma/migrations/20261118090000_password_reset_tokens` — additive: creates
`password_reset_tokens` only. Production order:
1. Deploy the migration: `pnpm --filter @project-x/api exec prisma migrate deploy`.
2. Set `RESEND_API_KEY` and `MAIL_FROM` in the API environment.
3. Deploy the API, then the dashboard (the dashboard pages call the new endpoints).

Expired and used rows are harmless; a periodic cleanup
(`DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '7 days'`) can be added
later — `expires_at` is indexed.

## Manual test
1. Configure Resend (above) or use your own Resend account address with `onboarding@resend.dev`.
2. Apply the migration locally: `pnpm --filter @project-x/api exec prisma migrate deploy`.
3. Sign in at `/login`, then open another browser and sign in there too.
4. Sign out, click **Forgot password?**, enter the account email → the generic confirmation.
5. Open the email, click **Reset password** → `/reset-password`; the address bar no longer shows
   the token. Enter a new password twice → success.
6. Both browsers are signed out on their next request. The old password fails; the new one works.
7. Click the same email link again → "invalid or has expired".

## Deliverability notes
- Keep the sending domain verified (SPF/DKIM) and add DMARC.
- Password reset emails are transactional: no tracking pixels or marketing content.
- Monitor bounces and complaints in Resend.
