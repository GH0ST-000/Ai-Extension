# Email delivery — staging verification

Production refuses to start without a usable mail configuration (`collectProductionMailIssues`
in `packages/config`). That check is **configuration only**: it does not send mail and cannot
prove deliverability. Run the procedure below in staging before every paid-beta launch and after
any change to the sending domain, DNS or Resend account. None of these live checks have been run
by the automated test suites (they use a mocked mail transport).

## Required configuration

| Variable         | Production rule                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `RESEND_API_KEY` | Required. A Resend key (`re_…`); template values (`re_your_…`, `changeme`, `<…>`) are rejected. Never printed.          |
| `MAIL_FROM`      | Required. `address` or `Name <address>` on your verified sending domain; reserved/template domains are rejected.         |
| `APP_BASE_URL`   | Required. Public `https://` dashboard origin, no credentials/query/fragment; links are built as `<base>/verify-email#…`. |

Development and test start without mail credentials; mail is then "not configured" and
registration still succeeds (the verification link is simply not delivered).

## Procedure (staging)

1. **Sending domain.** In Resend, add and verify the sending domain (SPF, DKIM, and a DMARC
   record on the parent domain). Wait until Resend reports it as verified.
2. **Credentials.** Create a sending-only API key and set `RESEND_API_KEY`, `MAIL_FROM`
   (`Project X <no-reply@<verified domain>>`) and `APP_BASE_URL` (the staging dashboard origin).
   Start the API with `NODE_ENV=production`; it must start without `MAIL_*` / `APP_BASE_URL_*`
   startup errors.
3. **Register** a new test user with a mailbox you control (dashboard and extension sign-up).
4. **Receive** the "Confirm your email" message. Check: sender, that it is not in spam, that the
   link points to `<APP_BASE_URL>/verify-email#token=…` (token in the fragment, no query string).
5. **Follow the link** in a browser where you are *not* signed in; then repeat the flow signed in.
6. **Confirm**: the page reports success; `GET /api/auth/email-verification` returns
   `verified: true`; the dashboard banner disappears; free AI actions are no longer refused with
   `EMAIL_VERIFICATION_REQUIRED`.
7. **Invitation**: invite the verified address to a workspace and accept it. Also confirm that an
   *unverified* invitee sees the verification notice (403 `EMAIL_NOT_VERIFIED`) and that
   acceptance succeeds after verifying.
8. **Edge cases**:
   - Resend: request a new link; it must arrive; the previous link must now be refused.
   - Cooldown: a second resend within 60 s returns `throttled` and sends nothing.
   - Reuse: opening a used link reports "invalid or already used".
   - Expiry: set a token's `expires_at` in the past in the staging DB (or wait 24 h); the page
     reports "expired" and offers a new link.
   - Invalid link: alter one character of the fragment; the page reports "invalid".
   - Failure path: temporarily use a revoked key; registration must still succeed, the API must
     log `email_verification.delivery_failed` (reason only, no token/address) and resend must
     report `mail_failed`.

Record the date, staging commit and results for each step. Do not reuse production mailboxes or
production data for these tests.
