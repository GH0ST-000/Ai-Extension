# Growth profile, marketing consent and signup attribution

Three small, optional pieces of first-party data that help us understand who signs up and why.
None of them changes what a user can do or see.

## 1. Profile questions (optional)

Stored on `user_settings`. Values are stable ids; labels live in
`apps/dashboard/src/lib/growth-profile.ts` and can be reworded without a migration.

| Field              | Values (id → label)                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `professionalRole` | `software_developer` Software Developer · `tech_lead` Tech Lead · `engineering_manager` Engineering Manager · `qa_engineer` QA Engineer · `product_owner` Product Owner · `other` Other                    |
| `usageIntent`      | `personal_projects` Personal projects · `team` Working with a team · `exploring_ai_tools` Exploring AI development tools                                                                                  |
| `primaryGoal`      | `find_bugs_earlier` Find bugs and risks earlier · `faster_reviews` Review pull requests faster · `enforce_standards` Enforce team coding standards · `improve_code_quality` Improve code quality · `just_exploring` Just exploring |

- The professional role is **not** a workspace role. Workspace permissions (`owner`/`admin`/…)
  are untouched and no feature is gated on these answers.
- Not collected: phone, company, company size, job title.

### Onboarding screen: `/app/welcome`

- Shown **once, right after registration** in the dashboard
  (`/login?mode=register` → `/app/welcome?next=<destination>`).
- One screen, three single-choice chip groups (radio semantics, keyboard focusable, wraps on
  mobile). Any subset can be answered; clicking a selected chip clears it.
- **Continue** with at least one answer → `PATCH /settings/profile` (sets `profileCompletedAt`).
  **Continue** with nothing selected, or **Skip for now** → `POST /settings/profile/skip`
  (sets `profileSkippedAt`).
- Never blocks: a save failure shows a warning toast and still continues; a load failure or an
  already completed/skipped profile redirects straight on. `next` goes through `safeInternalPath`
  (external URLs fall back to `/app`).
- Existing and returning users are never sent there (login keeps its normal redirect). The first PR
  Review checklist on `/app` is unchanged.
- Extension sign-ups: right after a successful **registration** in the popup, the signed-in view
  shows an optional card _"Make Project X work better for you"_ with **Answer in Studio** (opens
  `/app/welcome?next=/app` in a new tab) and **Not now**. The questions are not duplicated in the
  extension. The card is session-only state: it never appears after a sign-in, so existing
  extension users are not interrupted.
  - Session: the extension's register request already uses `credentials: 'include'` and writes the
    API's `px_at` / `px_rt` cookies, which is how the dashboard normally shares the extension
    session. The link carries **no token**. If the dashboard has no session (e.g. the browser
    blocks those cookies), the dashboard's normal auth gate sends the user to `/login`; after
    signing in they land on `/app` (the gate does not keep `next`), and can still answer in
    **Settings → About you**. No new token-transfer mechanism was added.

## 2. Marketing email consent

- Checkbox on dashboard **and** extension registration, **unchecked by default**, separate from the
  Terms notice, never required. Wording: _"Email me occasional product updates and tips. Optional —
  unsubscribe anytime."_
- Only a JSON `true` counts (`StrictBoolean`; `"true"`, `1` → 400). Absent/false records nothing.
- Current state: `user_settings.marketing_email_consent` (default `false`) +
  `marketing_consent_updated_at`.
- Evidence: an append-only `marketing_consent_events` row per **change**
  (`granted`, `source` = `dashboard_signup` | `extension_signup` | `settings`,
  `policy_version` = `MARKETING_CONSENT_VERSION` (`marketing-email-2026-11`), `created_at`).
  No IP or user agent is stored. Re-sending the current state writes nothing.
- Withdraw/grant anytime in **Settings → About you** (`PUT /settings/marketing-consent`).
  Withdrawal keeps the earlier evidence rows.
- Nothing is sent: there is no marketing email integration and no subscription to any list.
  Transactional email (password reset) does not depend on this flag.
- If the wording changes, bump `MARKETING_CONSENT_VERSION` in `packages/types/src/growth-profile.ts`.

## 3. First-touch attribution

Stored once per account in `user_acquisitions` (one row per user, created inside the registration
transaction, never updated afterwards).

| Column                                                  | Source                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `signup_client`                                         | `extension` if the request carries `X-Project-X-Client: extension` or a `chrome-extension://` Origin, else `dashboard` |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` | `utm_*` URL parameters of the landing visit                  |
| `referral`                                              | `ref` URL parameter                                          |
| `referrer_host`                                         | hostname of an external `document.referrer` (never path/query) |

**Flow (no storage, no third parties):** the landing page's _Get Started_ links copy the allowlisted
parameters into `/login?mode=register&…`. The sign-up form reads them from its own URL and sends
`attribution` with `POST /auth/register`. The server sanitizes again and writes the row.

**Trade-off chosen:** no cookie/localStorage is used, so attribution survives only a direct path
(landing → Get Started → register). A visitor who wanders off and comes back later is recorded as
direct. The alternative (persisting a first-touch value in browser storage before any consent) was
rejected as the less privacy-safe option.

**Validation (client and server; the server is authoritative):**

- Only the six keys above; every other parameter (`email`, `token`, `next`, `gclid`, `utm_term`, …)
  is ignored.
- Values: 1–100 chars of `A–Z a–z 0–9 space . _ -` only (no `@ / : = ? & %`, so no emails, URLs or
  query strings).
- Credential-looking values are rejected (`looksSecretLike`): well-known token prefixes
  (`ghp_`, `github_pat_`, `glpat-`, `xox…`, `sk-`/`sk_`, `AKIA`, JWT `eyJ…`; only for values
  ≥ 20 chars), digit runs of ≥ 12 (card / phone numbers, ids), and random-looking strings
  (≥ 20 letters/digits that switch between lower-case, upper-case and digits on ≥ 30 % of
  characters — base64/hex tokens). Long ordinary words such as `internationalization` or
  `Spring_Launch_2026_EMEA_Partners` are kept.
- Referrer host: lower-cased hostname labels only, own-site referrers ignored.
- Invalid values are **dropped**, never rejected: attribution can't make sign-up fail. A
  non-object `attribution` is a 400 (malformed client).

## API

All under `JwtAuthGuard`; they act on the signed-in user only (no user id in path or body).

| Method & path                     | Body                                                  | Returns              |
| --------------------------------- | ----------------------------------------------------- | -------------------- |
| `GET /api/settings/profile`       | —                                                     | `UserGrowthProfile`  |
| `PATCH /api/settings/profile`     | any of `professionalRole`/`usageIntent`/`primaryGoal`; omitted = unchanged, `null` = clear | `UserGrowthProfile` |
| `POST /api/settings/profile/skip` | —                                                     | `UserGrowthProfile`  |
| `PUT /api/settings/marketing-consent` | `{ "granted": boolean }`                          | `UserGrowthProfile`  |

`POST /api/auth/register` additionally accepts optional `marketingConsent: boolean` and
`attribution: { utmSource?, utmMedium?, utmCampaign?, utmContent?, referral?, referrerHost? }`.
Existing clients that send neither keep working unchanged.

## Migration

`apps/api/prisma/migrations/20261119090000_growth_profile_consent_attribution` — additive only:
7 nullable/defaulted columns on `user_settings`, two new tables with FKs (`ON DELETE CASCADE`) and
indexes. Existing users get `marketing_email_consent = false`, no profile, no acquisition row
(reported as unknown). No backfill. Apply with the normal `prisma migrate deploy`.

## Privacy notes

- Nothing here is sent to any third party; no analytics SDK, pixel or marketing API is called.
- Request bodies of these endpoints are not logged.
- Only `/terms` exists today; no Privacy Policy is linked or claimed until one is published.
- Deleting a user cascades to their consent events and acquisition row.

## Manual QA

1. Open `/?utm_source=newsletter&utm_campaign=launch&token=x` → _Get Started_ link contains the two
   `utm_*` params, not `token`.
2. Register with the box **unchecked** → lands on `/app/welcome`. DB: consent `false`, no event,
   `user_acquisitions` row with `utm_source=newsletter`.
3. Answer one question → **Continue** → `/app` with the First PR Review checklist.
   Visiting `/app/welcome` again redirects straight to `/app`.
4. Register another account with the box **checked**, pick **Skip for now** → consent `true`, one
   `dashboard_signup` event.
5. Settings → About you: change answers, clear one, Save; toggle product emails off and on →
   two `settings` events.
6. Extension popup → Register: checkbox unchecked, Terms link opens dashboard `/terms`;
   register → `signup_client=extension`, and with the box ticked an `extension_signup` event.
   The popup then shows the optional "Answer in Studio" card; it opens `/app/welcome`, and
   **Not now** hides it. Signing in with an existing account never shows the card.
7. Sign out/in, password reset → unchanged behaviour, no welcome screen.
