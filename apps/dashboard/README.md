# @project-x/dashboard

Next.js dashboard for Project X (“Signal Studio” shell).

## Stack

- Next.js (App Router)
- React + TypeScript
- Tailwind CSS
- Shared UI from `@project-x/ui` (shadcn-style primitives)
- Auth against NestJS API (`NEXT_PUBLIC_API_URL`)

## Local setup

```bash
# from repo root — API must be running on :3001
cp apps/dashboard/.env.example apps/dashboard/.env
pnpm --filter @project-x/dashboard dev
```

App runs at `http://localhost:3000`.

## Routes

| Path | Purpose |
|------|---------|
| `/` | Landing |
| `/login` | Register / sign in (JWT stored in `localStorage`) |
| `/app` | Protected overview |
| `/app/settings` | AI preferences (max tokens, response style, page context) |

`/app/*` requires a valid session. Use the same account in the Chrome extension popup.
