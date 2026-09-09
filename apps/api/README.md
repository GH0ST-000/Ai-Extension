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
| POST | `/api/ai/actions/stream` | JWT | Stream an AI action as plain text |
| POST | `/api/ai/actions` | JWT | Non-streaming AI action (debug/tests) |

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

Supported `action` values: `EXPLAIN`, `IMPROVE_WRITING`, `SUMMARIZE`, `TRANSLATE`, `EXPLAIN_CODE`, `REVIEW_CODE`, `SUGGEST_FIX`, `REVIEW_ENTIRE_PR`, `CUSTOM`.

`CUSTOM` requires a non-empty `customPrompt`. `SUGGEST_FIX` may include optional `customPrompt` with prior review findings. `REVIEW_ENTIRE_PR` uses `context.github.changedFiles` when present.

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
