# Staging environment

A staging deployment is a **production-hardened** server whose billing is the **Paddle
sandbox**. It is not a development server on a public address.

```
NODE_ENV=production
APP_STAGE=staging
```

`NODE_ENV=development` (or `test`) must never be reachable from the internet: it enables the
published development JWT secret, permissive CORS, non-`Secure` cookies, open operational
endpoints and a built-in billing webhook secret. Use the two lines above instead.

## What `APP_STAGE=staging` changes

Exactly one thing: the billing provider.

| | production (`APP_STAGE` unset) | staging |
|---|---|---|
| `PADDLE_ENVIRONMENT` | must be `production` | must be `sandbox` (`production` is refused) |
| Paddle client | real client, live API | real client, **sandbox** API |
| `PADDLE_API_KEY` | live key | sandbox key (a `pdl_live_…` key is refused) |
| Webhook verification | Paddle `ts;h1` signature | the same (no legacy signature, no built-in secret) |
| `plan_id` in webhook payloads | ignored | ignored |

Everything else is identical to production and enforced at startup: strong `JWT_SECRET` and a
distinct `TOKEN_ENCRYPTION_KEY`, an explicit `AI_CORS_ORIGINS` allowlist, `Secure` cookies,
the three operational tokens, TLS to a remote database and Redis, a real `RESEND_API_KEY` /
`MAIL_FROM`, a public https `APP_BASE_URL`, and the GitHub App all-or-nothing rule.

`APP_STAGE` is ignored unless `NODE_ENV=production` — a label cannot harden a development
server.

## Required environment (staging)

```
NODE_ENV=production
APP_STAGE=staging
APP_BASE_URL=https://staging.<your-domain>
AI_CORS_ORIGINS=https://staging.<your-domain>,chrome-extension://<staging extension id>
JWT_SECRET=<unique, ≥32 chars — not the production value>
TOKEN_ENCRYPTION_KEY=<unique, ≥32 chars — not the production value>
DATABASE_URL=postgresql://…staging database…?sslmode=require&sslaccept=strict
REDIS_HOST=… REDIS_PASSWORD=… REDIS_TLS=true
TRUST_PROXY_HOPS=<number of proxies in front of the API>
METRICS_SCRAPE_TOKEN=… INTERNAL_OBSERVABILITY_TOKEN=… HEALTH_DETAILS_TOKEN=…
RESEND_API_KEY=… MAIL_FROM="Project X Staging <no-reply@mail.<your-domain>>"
PADDLE_ENVIRONMENT=sandbox
PADDLE_API_KEY=<sandbox API key>
PADDLE_WEBHOOK_SECRET=<secret of the SANDBOX notification destination>
PADDLE_CLIENT_TOKEN=<sandbox client-side token>
PADDLE_PRICE_PRO_MONTHLY=… PADDLE_PRICE_TEAM_MONTHLY=…   (sandbox price ids)
```

Separation from production: use a different database, Redis, secrets, mail sender, GitHub App
and extension id. Never point staging at production data stores — the server cannot detect
that for you.

## Things to verify on staging before a paid beta

These cannot be proven by the automated suites (they use test doubles for every provider):

1. A sandbox checkout completes and the `subscription.created` webhook upgrades the workspace
   (the subscription carries `custom_data.checkoutId`; see `docs/billing`).
2. A subscription created **outside** the app (Paddle dashboard, or a Paddle.js checkout with
   hand-written custom data) for a workspace id does **not** change that workspace.
3. Deleting a paid workspace cancels the sandbox subscription; with the Paddle API key
   temporarily invalid the workspace stays `deletion_pending` and completes after the key is
   restored.
4. Verification and password-reset emails arrive and their links work end to end.
5. GitHub App install → verify → review → disconnect (the App stays installed on GitHub).
6. Per-IP rate limits see real client addresses (`TRUST_PROXY_HOPS`).
