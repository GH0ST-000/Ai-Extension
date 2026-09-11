# @project-x/api

NestJS API for Project X.

## Stack

- NestJS + TypeScript
- Prisma + PostgreSQL
- Redis + BullMQ
- Config validation (Zod via `@project-x/config`)
- Request validation (`ValidationPipe`)
- Structured logging (`nestjs-pino`)
- Health checks (`/api/health`, `/api/health/live`)
- AI actions via Vercel AI SDK (`ai` + `@ai-sdk/openai`)

## Local setup

```bash
# from repo root
cp .env.example .env
# set OPENAI_API_KEY to a real key for AI streaming
pnpm docker:up
pnpm --filter @project-x/api prisma:generate
pnpm --filter @project-x/api exec prisma migrate deploy
pnpm --filter @project-x/api dev
```

API listens on `http://localhost:3001` by default (`/api` global prefix).

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | No | Deep health (Postgres + Redis) |
| GET | `/api/health/live` | No | Liveness probe |
| POST | `/api/auth/register` | No | Create account (returns JWT) |
| POST | `/api/auth/login` | No | Sign in (returns JWT) |
| GET | `/api/auth/me` | JWT | Current user |
| GET | `/api/settings` | JWT | AI preferences |
| PATCH | `/api/settings` | JWT | Update AI preferences |
| GET | `/api/settings/github` | JWT | GitHub connection status (never returns PAT) |
| PUT | `/api/settings/github` | JWT | Validate + store encrypted GitHub PAT |
| DELETE | `/api/settings/github` | JWT | Disconnect GitHub |
| GET | `/api/settings/jira` | JWT | Jira Cloud connection status (never returns API token) |
| PUT | `/api/settings/jira` | JWT | Validate + store encrypted Jira email/API token + site host (read-only) |
| DELETE | `/api/settings/jira` | JWT | Disconnect Jira |
| GET | `/api/jira/issues/:issueKey` | JWT | Fetch + normalize issue (`?host=` must match connected `*.atlassian.net` site) |
| POST | `/api/github/pull-requests/comments` | JWT | Post a PR comment (idempotent; uses stored PAT) |
| POST | `/api/github/pull-requests/:owner/:repo/:number/patches/prepare` | JWT | Prepare a PR head file fix (no write; Redis-stored preview) |
| POST | `/api/github/pull-requests/:owner/:repo/:number/patches/apply` | JWT | Apply prepared fix as one Contents API commit (idempotent) |
| GET | `/api/github/pull-requests/:owner/:repo/:number/checks` | JWT | Normalized CI/check summary for trusted current PR head |
| GET | `/api/github/pull-requests/:owner/:repo/:number/checks/:checkId` | JWT | Bounded failure evidence (annotations / summary / Actions logs) |
| POST | `/api/github/pull-requests/:owner/:repo/:number/checks/:checkId/analyze` | JWT | User-triggered AI CI failure analysis (`ANALYZE_CI_FAILURE`) |
| POST | `/api/github/repos/:owner/:repo/file-versions` | JWT | Read-only: fetch one path at `baseSha` + `headSha` (Contents API; Day 18 OpenAPI diffs) |
| POST | `/api/github/pull-requests/:owner/:repo/:number/file-versions` | JWT | Read-only: resolve PR base/head SHAs, then fetch one path at both |
| POST | `/api/openapi/parse-url` | JWT | Fetch + normalize a public OpenAPI/Swagger document (SSRF-hardened; https only) |
| POST | `/api/openapi/parse-content` | JWT | Normalize OpenAPI content already in hand |
| POST | `/api/openapi/example` | JWT | Deterministic request example template (never executes; no auth capture) |
| POST | `/api/openapi/risks` | JWT | Deterministic contract risk scan |
| POST | `/api/openapi/diff` | JWT | Deterministic structural OpenAPI diff (`baseContent`/`headContent` + refs) |
| POST | `/api/ai/actions/stream` | JWT | Stream an AI action as plain text |
| POST | `/api/ai/actions` | JWT | Non-streaming AI action (debug/tests) |

Day 16 CI Fix Loop is session-scoped in the extension (not a new mutation API). It orchestrates Day 15 analysis → target selection → Day 8 `SUGGEST_FIX` (optional `CI_FIX_CONTEXT` in `customPrompt`) → Day 14 prepare/apply → CI refresh/verification. No automatic commits, CI reruns, or recursive fixes.

Day 17 Jira Intelligence is **read-only**. Connect via dashboard Settings (Atlassian account email + API token + `*.atlassian.net` site host). The API never posts comments, transitions issues, creates/edits issues, or downloads attachment binaries. Cross-tool compare reuses existing GitHub PR context; GitHub mutations still require Days 13/14 flows.

Day 18 OpenAPI / API docs is **read-only**. Parse/diff/example/risks never execute HTTP calls against the documented API (“no Try It”). Document URL fetch is SSRF-hardened (https-only, block private/metadata hosts; DNS allow-list checks live only in `OpenApiFetchService`). GitHub PR ↔ contract wiring uses Contents API file-at-SHA reads bound to `baseSha`/`headSha` — no GitHub mutations. AI action `ANALYZE_API_CHANGES` explains a deterministic `/openapi/diff` summary; structural breaking/non-breaking labels win.

### Auth

```json
POST /api/auth/register
{ "email": "you@company.com", "password": "at-least-8", "name": "Optional" }

POST /api/auth/login
{ "email": "you@company.com", "password": "at-least-8" }
```

Both return `{ "accessToken": "...", "user": { "id", "email", "name" } }`.
Send `Authorization: Bearer <accessToken>` on protected routes.

### Settings

```json
{
  "maxOutputTokens": 600,
  "responseStyle": "CONCISE",
  "includePageContext": true
}
```

`responseStyle`: `CONCISE` | `BALANCED` | `DETAILED`. `maxOutputTokens` range: 150–2000.

### Streaming request

```json
{
  "action": "EXPLAIN",
  "text": "Selected text from the page",
  "customPrompt": null,
  "targetLanguage": null,
  "context": {
    "type": "github",
    "url": "https://github.com/acme/app/blob/main/src/index.ts",
    "title": "index.ts",
    "surroundingText": "nearby prose",
    "code": {
      "language": "ts",
      "fileName": "index.ts",
      "surroundingCode": "export const x = 1"
    },
    "github": {
      "owner": "acme",
      "repository": "app",
      "branch": "main",
      "filePath": "src/index.ts"
    }
  }
}
```

`context` is optional. Supported `context.type` values: `generic`, `github`. When the user disables page context in settings, the API ignores `context`.

The API never scrapes websites. It only consumes the normalized context object from the extension and injects it into prompts inside `<<CTX>>` delimiters.

Supported `action` values: `EXPLAIN`, `IMPROVE_WRITING`, `SUMMARIZE`, `TRANSLATE`, `EXPLAIN_CODE`, `REVIEW_CODE`, `SUGGEST_FIX`, `REVIEW_ENTIRE_PR`, `UNDERSTAND_ERROR`, `FIND_ROOT_CAUSE`, `ANALYZE_CI_FAILURE`, `CUSTOM`.

`CUSTOM` requires a non-empty `customPrompt`. `SUGGEST_FIX` may include optional `customPrompt` with prior review findings. `REVIEW_ENTIRE_PR` uses `context.github.changedFiles` when present. Day 11 error actions may include optional `errorIntelligence` (classification, stack frames, nearby code) — already redacted client-side. Day 15 `ANALYZE_CI_FAILURE` is normally invoked via the GitHub CI analyze endpoint with server-built evidence (not from the extension menu).

### GitHub PAT permissions (Days 11–15)

Fine-grained or classic PAT must allow reading the target repositories. Day 15 CI intelligence additionally needs **Checks: Read**. Optional **Actions: Read** enables bounded Actions job log excerpts when annotations are insufficient. Without Actions read, status/annotations still work; third-party checks show metadata + Open Check only (no arbitrary URL fetching).

Response: `Content-Type: text/plain; charset=utf-8` progressive text stream.

### AI environment

```env
AI_PROVIDER=openai
AI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-replace-me
AI_MAX_OUTPUT_TOKENS=600
AI_REQUEST_TIMEOUT_MS=30000
AI_MAX_INPUT_CHARACTERS=12000
AI_CORS_ORIGINS=
JWT_SECRET=project-x-dev-jwt-secret-change-me
JWT_EXPIRES_IN=7d
```

Only `openai` is supported for `AI_PROVIDER` today. Missing/invalid AI config fails at startup.

### CORS

In non-production, any origin is allowed so content scripts work (page Origin differs from the extension). Extra origins can still be listed in `AI_CORS_ORIGINS` for production lockdown.

## Architecture

```text
AuthController → AuthService → Prisma + JWT
SettingsController → SettingsService → Prisma
AiController (JWT) → AiService → SettingsService + PromptRegistry + AiModelFactory → Vercel AI SDK
```

Prompts are per-action builders. Provider setup lives only in `AiModelFactory`. Per-user settings adjust max tokens, response style, and whether context is included.
