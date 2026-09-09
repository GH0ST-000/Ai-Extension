# Project X

Production-ready SaaS monorepo foundation (Sprint 1 / Day 1).

## Stack

| Layer | Tech |
|-------|------|
| Monorepo | pnpm workspaces + Turborepo |
| API | NestJS, Prisma, PostgreSQL, Redis, BullMQ |
| Dashboard | Next.js, Tailwind CSS, shadcn-style UI |
| Extension | Plasmo, React, TypeScript |
| Quality | ESLint, Prettier, Husky, lint-staged, Conventional Commits |
| Infra (local) | Docker Compose (Postgres + Redis) |
| CI | GitHub Actions |

## Repository layout

```text
apps/
  api/          NestJS API
  dashboard/    Next.js dashboard
  extension/    Chrome extension (Plasmo)
packages/
  ui/           Shared UI primitives
  shared/       Shared utilities/constants
  types/        Shared TypeScript contracts
  config/       Shared env schemas (Zod)
  eslint-config Shared ESLint flat configs
  tsconfig/     Shared TypeScript presets
```

## Prerequisites

- Node.js 20+
- pnpm 9.15.0 (`corepack enable`)
- Docker Desktop (for Postgres + Redis)

## Quick start

```bash
# 1. Install dependencies
pnpm install

# 2. Environment
cp .env.example .env

# 3. Start infrastructure
pnpm docker:up

# 4. Generate Prisma client + run migrations
pnpm --filter @project-x/api prisma:generate
pnpm --filter @project-x/api exec prisma migrate deploy

# 5. Run everything (or use filtered commands below)
pnpm dev
```

### Run apps individually

```bash
pnpm --filter @project-x/api dev          # http://localhost:3001
pnpm --filter @project-x/dashboard dev    # http://localhost:3000
pnpm --filter @project-x/extension dev    # load apps/extension/build/chrome-mv3-dev
```

### Chrome extension

1. `pnpm --filter @project-x/extension dev`
2. Open `chrome://extensions`
3. Enable Developer mode → **Load unpacked**
4. Select `apps/extension/build/chrome-mv3-dev`

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all apps in watch mode |
| `pnpm build` | Build all packages and apps |
| `pnpm lint` | Lint the monorepo |
| `pnpm typecheck` | TypeScript checks |
| `pnpm test` | Run unit tests (API + extension) |
| `pnpm format` | Prettier write |
| `pnpm docker:up` | Start Postgres + Redis |
| `pnpm docker:down` | Stop Docker services |

## Health checks

- Deep: `GET http://localhost:3001/api/health`
- Live: `GET http://localhost:3001/api/health/live`

## AI streaming + auth

- Extension selects text → Ask AI → action → streams from `POST /api/ai/actions/stream` (**JWT required**)
- Normalized `context` (generic or GitHub) is sent with each request — never full HTML
- Register/login via dashboard (`/login`) or extension popup; tune AI settings at `/app/settings`
- Requires `OPENAI_API_KEY`, `JWT_SECRET`, and related AI env vars in root `.env`
- Extension uses `PLASMO_PUBLIC_API_URL` (no secrets); dashboard uses `NEXT_PUBLIC_API_URL`

## Architecture notes

- **Apps own runtime**; **packages own shared contracts/utilities**.
- Env validation fails fast via Zod (`@project-x/config`) at API boot.
- AI: Controller → Service (loads user settings) → PromptRegistry + ModelFactory → Vercel AI SDK.
- UI package holds shadcn-style primitives so dashboard/extension stay consistent later.
- React is pinned to **18.3** across the monorepo so Plasmo and Next.js share one React type graph.

## Conventional Commits

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint + Husky.

Examples: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `ci:`.

## Current scope

Auth, user AI settings, and extension ↔ API AI streaming are in place. History, billing, and third-party integrations remain out of scope.
