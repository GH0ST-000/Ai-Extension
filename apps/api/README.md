# @project-x/api

NestJS API for Project X. Day 1 ships infrastructure only — no business domains.

## Stack

- NestJS + TypeScript
- Prisma + PostgreSQL
- Redis + BullMQ
- Config validation (Zod via `@project-x/config`)
- Request validation (`ValidationPipe`)
- Structured logging (`nestjs-pino`)
- Health checks (`/api/health`, `/api/health/live`)

## Local setup

```bash
# from repo root
cp .env.example .env
pnpm docker:up
pnpm --filter @project-x/api prisma:generate
pnpm --filter @project-x/api exec prisma migrate deploy
pnpm --filter @project-x/api dev
```

API listens on `http://localhost:3001` by default.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Deep health (Postgres + Redis) |
| GET | `/api/health/live` | Liveness probe |
