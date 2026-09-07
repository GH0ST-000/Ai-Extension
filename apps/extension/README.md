# @project-x/extension

Chrome extension for Project X — Plasmo + React + TypeScript.

## Auth (required)

Ask AI requires a signed-in account. Use the extension popup to **register** or **sign in** (same credentials as the dashboard). The JWT is stored in `chrome.storage.local` and sent as `Authorization: Bearer …` on every AI request.

Tune response length, style, and page context from the dashboard **Settings** page (`/app/settings`).

## Day 4 — Context-aware AI

Before each AI request, the extension extracts a limited **page context** object:

- **Generic pages:** URL, title, meta description, surrounding text, nearby code when selection is in a code block
- **GitHub:** owner, repository, branch, file path, PR title/number when available, surrounding code

Context is sent with the streaming request. The full page HTML is never scraped.

## Day 3 — AI streaming

When text is selected on a page:

1. A floating **Ask AI** button appears near the selection
2. Clicking it opens the action menu in the same floating container
3. Choosing an action loads, streams, then shows the result in that container
4. Copy / Retry / Back / Close (and Custom Prompt) work without leaving the page

### Actions

- Explain
- Improve Writing
- Summarize
- Translate
- Explain Code
- Custom Prompt

All actions call `POST {PLASMO_PUBLIC_API_URL}/api/ai/actions/stream`. The API key never ships in the extension.

### Dismissal

- Outside click → closes everything (cancels in-flight requests)
- `Esc` → closes menu / result, then trigger
- Selection cleared → closes everything
- Close / Back / Retry → cancel the active `AbortController` when needed

## Architecture

```text
contents/selection-toolbar.tsx   Plasmo CSUI entry (shadow DOM + Tailwind)
lib/services/ai-client.ts        Typed streaming fetch client
lib/context/                     Page context extractors (generic + GitHub)
lib/selection/
  store.ts                       Zustand assistant view state
  hooks/                         Selection + dismiss behaviors
  components/                    FAB, menu, loading, result, error, custom prompt
  utils/                         DOM selection helpers
```

Assistant views use a discriminated union: `menu` → `custom-prompt` | `loading` → `streaming` → `success` | `error`.

## Stack

- React + TypeScript
- Tailwind CSS (semantic tokens via CSS variables)
- Framer Motion
- Floating UI
- Zustand
- Shared `@project-x/types` AI action contract

## Theming

Light/dark follow `prefers-color-scheme`. Tokens live in `style.css` (`--px-*`) and map to Tailwind utilities (`bg-elevated`, `text-primary`, `border-border`, …).

## Local development

You have two modes:

### A) Hot reload (needs Plasmo running)

```bash
# API must be running on :3001 with OPENAI_API_KEY set
pnpm --filter @project-x/extension dev
```

Load unpacked: `apps/extension/build/chrome-mv3-dev`

Keep this terminal open. If you stop it, Chrome will show:

- `WebSocket connection to ws://localhost:1815/ failed`
- `Extension context invalidated`

Those are Plasmo HMR warnings, not product bugs.

### B) Stable preview (no HMR websocket errors)

```bash
pnpm --filter @project-x/extension preview
```

Load unpacked: `apps/extension/build/chrome-mv3-prod`

Then in Chrome:

1. `chrome://extensions` → Reload Project X
2. Errors → **Clear all**
3. Close and reopen any already-open tabs (stale content scripts cause “context invalidated”)

## Production build

```bash
pnpm --filter @project-x/extension build
```

Same output as `preview` without the clean step: `apps/extension/build/chrome-mv3-prod`.
