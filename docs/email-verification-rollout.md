# Rolling out email verification to existing accounts

Migration `20261120120000_email_verification` adds `users.email_verified_at` as a nullable
column. Accounts that existed before it are **not** marked verified: nothing proves that the
person who typed an address controls it, and a blanket backfill would hand every pre-existing
account (including ones registered with someone else's address) the "verified" status that
invitations and free AI rely on.

## What existing users experience

- Signing in, GitHub/Jira connections, reviews in **paid** workspaces: unchanged.
- **Free AI actions** and **accepting invitations** require a verified email. The dashboard
  shows a banner with *Resend link* on every page; the extension shows "Confirm your email to
  use free AI" with *Resend verification email* and *Retry*.
- In a free workspace, members are blocked until the workspace **owner** verifies
  (`reason: workspace_owner`).
- To confirm, the user opens the link and signs in to the account it was sent for (the link
  alone confirms nothing).

No email is sent automatically by the deployment.

## Procedure

1. **Before deploying** make sure mail is configured (`RESEND_API_KEY`, `MAIL_FROM`, https
   `APP_BASE_URL` — production startup fails without them) and that a test account receives a
   verification email on staging.
2. Count who is affected (read-only):
   ```sql
   SELECT count(*) FILTER (WHERE email_verified_at IS NULL) AS unverified, count(*) AS total
   FROM users;
   ```
3. Tell existing users in advance (product announcement) that they will be asked to confirm
   their email on next use of free AI.
4. Deploy. Users verify themselves through the banner (rate limited: 60 s cooldown, 5 per hour
   per account).
5. Watch `ai.free_quota.verification_required` in the security audit export for stuck users.

## Deliberately not done

- **No backfill** and **no grace period**: a period in which unverified accounts keep free AI
  is exactly the bypass the feature closes, and it would have to be keyed on account age — which
  an attacker who registered accounts in advance also satisfies.
- **No bulk email from the migration**: sending is a product decision, and the deployment must
  not send mail on its own. If you want a one-off campaign, send the normal verification email
  through the existing resend path per account, at a controlled rate.
