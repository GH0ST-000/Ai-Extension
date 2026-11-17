# Product analytics & activation funnel

Minimal, first-party, server-side. **No new tables, no event writes, no third-party SDKs.**
Every number is computed on demand from records the product already writes for its own
purposes, so analytics can't drift from reality, can't block a product action, and adds no
write load.

## Architecture

```
users ─┬─ user_settings (profile answers)          ┐
       ├─ user_acquisitions (first touch)          │  ProductAnalyticsService
       ├─ pr_review_reports (review outcomes)      ├─ read-only SQL, one transaction,
       ├─ project_memories (active rules)          │  statement_timeout 15 s
       ├─ github_connections / app installations   │        │
workspace_subscriptions (Paddle state)             ┘        ▼
                                  GET /api/internal/analytics/activation  (operator token)
```

- Code: `apps/api/src/analytics/` (`product-analytics.service.ts`,
  `internal-analytics.controller.ts`, `analytics.module.ts`).
- Kept separate from:
  - **Security audit events**: `SecurityAuditService`, not used here.
  - **Project Memory audit history**: `project_memory_audit_events`, not read.
  - **Operational logs and metrics**: Pino, `/metrics`.

## Event taxonomy → authoritative source

| Event                               | Source (derived, not stored)                                                         | Accuracy                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `signup_completed`                  | `users.created_at`                                                                   | Exact                                                                                        |
| `onboarding_completed`              | `user_settings.profile_completed_at` / `profile_skipped_at`                          | Exact from Step 3 on                                                                         |
| `github_connected`                  | `github_connections` (PAT) or active `github_app_installations` of a workspace the user is an active member of | **Current state**, best-effort: disconnects erase it, no timestamp history                   |
| `first_pr_review_completed`         | earliest `pr_review_reports.completed_at` with status `completed`/`partial`, initiated by the user | Exact since review history persistence (PR Review History, #51)                              |
| `pr_review_completed`               | `pr_review_reports` status `completed`/`partial`                                     | Exact (same caveat); `failed` never counts                                                   |
| `pr_review_repeated`                | 2nd **distinct logical review** of the user                                          | Exact (same caveat)                                                                          |
| `project_memory_first_rule_created` | `project_memories` with `status = 'active'`, creator = `created_by_user_id` (else `user_id`) | Current state: archived-only users are not counted                                           |
| Project Memory applied              | `pr_review_reports.memory_status = 'applied'` on a successful review                 | Exact: the server sets `applied` only when ≥ 1 rule reached the review prompt. Doesn't prove the AI followed the rule |
| `subscription_started` / `canceled` | **not implemented as events**: `workspace_subscriptions` holds current state only    | See Billing                                                                                  |

Nothing is client-reported. `user_settings.first_value_at` (set by the client-driven onboarding
checklist) is intentionally **not** used.

### Deduplication

- `pr_review_reports` has `UNIQUE (workspace_id, operation_id)`: one report per review execution,
  so retries never duplicate a report.
- A **logical review** is `workspace + owner + repository + PR number + head commit` (the
  operation id when the head SHA is missing). Re-running the same commit doesn't count as a
  second review; reviewing a new push or another PR does.
- Activation is attributed to the **initiator** (`pr_review_reports.user_id`). A teammate's review
  in a shared workspace doesn't activate anyone else.

## Metric definitions

The cohort is users with `created_at` in `[from, to)`.

| Metric                     | Formula                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| signups                    | cohort size                                                                                                                                |
| activated                  | cohort users with ≥ 1 successful review (any time up to now)                                                                               |
| activationRate             | activated / signups                                                                                                                        |
| sevenDayActivationRate     | users with `first_success − signup ≤ 7 days` ÷ users who signed up **≥ 7 days ago** (younger users are excluded from both sides)            |
| medianHoursToFirstReview   | median of `first_success − signup` over activated users; `null` when fewer than 5                                                          |
| repeatReviewers            | users with ≥ 2 distinct logical successful reviews                                                                                          |
| repeatRate                 | repeatReviewers / activated                                                                                                                |
| attemptedWithoutSuccess    | users with ≥ 1 report but no successful one (abandonment after a failed attempt)                                                           |
| funnel                     | signup → profile answered/skipped → GitHub connected (now) → review attempted → first success → repeated → active rule created            |
| segments                   | signups / activated / rate by acquisition source (`utm_source`, else referrer host, else `direct`; `unknown (before tracking)` without an acquisition row), signup client, role, intent, goal |
| activity (window)          | reports created in `[from, to)`: successful, failed, workspaces with success, reviews / users / workspaces with Project Memory applied      |
| projectMemory (now)        | users with ≥ 1 active rule; workspaces with ≥ 1 active **shared** rule                                                                      |

Rates are rounded to 4 decimals; `null` means "no denominator", never 0.

## Billing (current state only)

Counted only for `workspace_subscriptions` rows with a Paddle `provider_subscription_id`:

- `activePaid` (and by plan), `trialing`, `pastDue`, `paused`;
- `scheduledToCancel` (active with `cancel_at_period_end`);
- `cancelledOrExpired`, `workspacesEverSubscribed`, and `totalWorkspaces`.

These are exact **for today**. There's no transition history (the row is overwritten), so
conversion-over-time, time-to-convert and churn dates can't be computed reliably. Use the
Paddle dashboard for revenue and history. No payment details are read. Trials aren't offered;
`trialing` will normally be 0.

## Access control

`GET /api/internal/analytics/activation?from=<ISO>&to=<ISO>`

- Operator-only. It uses the existing `INTERNAL_OBSERVABILITY_TOKEN` (`X-Internal-Token` header or
  `Authorization: Bearer`), compared in constant time.
- **Closed in every environment while the token is unset.** This is stricter than the existing
  internal observability endpoints, which are open in development.
- User sessions (JWT) never grant access. No admin role was added, and workspace owners can't
  read platform-wide numbers.
- Rate-limited (`internal_analytics`, 20 per minute per IP). The window defaults to the last 90
  days and is capped at 366 days. Bad dates return 400.

Retrieve without printing the token:

```bash
curl -s -H "X-Internal-Token: $INTERNAL_OBSERVABILITY_TOKEN" \
  "https://<api-host>/api/internal/analytics/activation?from=2026-11-01&to=2026-12-01" | jq
```

## Privacy

- The response is aggregates only. It contains no user ids, emails, workspace ids, repository
  names, PR titles, findings, rule text or IP addresses.
- Segments smaller than 5 users are folded into `other (groups < 5 users)`.
- No third-party trackers, cookies or fingerprinting, and no payloads are logged.
- **Retention and deletion:** nothing new is stored, so the existing rules apply.
  - Deleting a user removes their settings, acquisition and consent rows.
  - Their PR reports keep `user_id = NULL`, so they drop out of every per-user metric.
  - Workspace deletion cascades as before.

## Historical data limitations

- **Acquisition and profile:** only users created after the Step 3 migration have them. Older
  users appear as `unknown (before tracking)` and `unanswered`. See `dataCoverage.*`.
- **Reviews:** only reviews persisted since PR Review History exist. Earlier reviews are invisible,
  so older users may look un-activated.
- **GitHub connected:** current state only.
- **Project Memory:** current active rules only. A user whose rules were all archived isn't
  counted. The audit log can't help for rules created before auditing began.
- **Billing:** current state only (see above).
- **Users deleted** since signup disappear from cohorts.

## Migrations

None for Step 4. Step 3's `20261119090000_growth_profile_consent_attribution` is required for
the acquisition, profile and consent columns.

## Manual QA

1. Without `INTERNAL_OBSERVABILITY_TOKEN` set: `curl …/api/internal/analytics/activation` → 401.
2. With the token set in `.env` (restart the API): call with the header → 200 JSON. Without it,
   with a wrong token, or with a user's `Authorization: Bearer <JWT>` → 401.
3. `?from=2018-01-01&to=2020-01-01` → 400 (window too long).
4. Register a new user, run a PR review that completes, then call the endpoint for today's window:
   `signups` and `activated` increase by 1 and the `first_pr_review_completed` funnel step moves.
5. Run a review that fails: `failedReviews` increases and `activated` doesn't.
6. Re-run the same PR without new commits: `repeatReviewers` is unchanged. Push a commit and
   review again: it becomes 1.
7. Create an active Project Memory rule and review with memory on:
   `reviewsWithProjectMemoryApplied` increases.
8. Confirm the JSON has no email, repository name or rule text.

## Deliberately deferred

- Stored event log, outbox or queue, for when event history is needed (e.g. subscription
  transitions). Add one then, with dedup keys, rather than now.
- Subscription history table fed by Paddle webhooks (conversion and churn over time).
- Weekly retention cohorts, dashboard UI, CSV export, and third-party analytics tools.
- Indexes for analytics: not needed at current volume. Add `users(created_at)` if cohort scans
  get slow.
