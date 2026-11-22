# Free AI requires a verified email

**Rule.** In a workspace whose effective plan is **free**, an AI model execution is allowed only
when the acting user **and** every active owner of the workspace have a verified email address.
Paid workspaces (Pro, Team — including `past_due` dunning) are unchanged.

**Where.** `UsageService.reserve` (`apps/api/src/usage/usage.service.ts`). Every model execution
reserves a usage unit first: standard actions, selection review (`REVIEW_CODE`), Entire PR
review, CI failure analysis (via `generateActionWithMetadata`) and workflow planning
(`workflow_run`). The check runs before any quota write and therefore before any model call.
There are no background AI jobs; multi-repo analysis is deterministic (no model) and not gated.
Replays of a stored result are scoped to the same user and request and never call the model.

**Response.** `403` with `{ code: "EMAIL_VERIFICATION_REQUIRED", details: { reason } }`, where
`reason` is `account` (verify your own email) or `workspace_owner` (the owner must verify). The
response never names the owner. Verification status is read fresh on every request, so
confirming the email unlocks usage immediately.

**Why the owner rule.** Without it, one verified account could register any number of throwaway
(unverified) accounts, be invited into each one's free workspace, and spend every pool.

**Clients.** The extension shows "Confirm your email to use free AI" with *Resend verification
email* and *Retry* (the request is kept, so retrying after verifying needs no re-entry). The
dashboard banner explains the requirement and offers *Resend link*.

**Abuse monitoring.** Each refusal and each exhausted free pool is logged
(`ai.free_quota.verification_required`, `ai.free_quota.exhausted`) and written to the durable
security audit table with the hashed actor id and workspace id. Registrations are limited per
client IP to 10/minute and 20/24 h (a window that expires — not a ban); resends to 60 s cooldown
and 5/hour per account.

**Not solved.** Email verification does not stop one person from controlling many mailboxes.
Each verified account still gets up to two free workspaces (Decision B). Stronger cross-account
identity (payment-method checks, phone verification, device signals) is a product and privacy
decision that has not been made.
