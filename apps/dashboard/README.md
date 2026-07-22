# @project-x/dashboard

Next.js dashboard for Project X.

## Stack

- Next.js (App Router)
- React + TypeScript
- Tailwind CSS
- Shared UI from `@project-x/ui` (shadcn-style primitives)

## Local setup

```bash
# from repo root
pnpm --filter @project-x/dashboard dev
```

App runs at `http://localhost:3000`.

## Routes (Day 1)

| Path | Purpose |
|------|---------|
| `/` | Landing / entry |
| `/login` | Login placeholder (no auth) |
| `/app` | Dashboard layout shell |
| `/app/settings` | Settings placeholder |
