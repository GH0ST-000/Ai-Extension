# @project-x/extension

Chrome extension for Project X — Plasmo + React + TypeScript.

## Day 2 — Interaction layer

When text is selected on a page:

1. A floating **Ask AI** button appears near the selection
2. Clicking it opens a premium action menu
3. Each action currently **logs** its name (no AI / backend yet)

### Actions

- Explain
- Improve Writing
- Summarize
- Translate
- Explain Code
- Custom Prompt

### Dismissal

- Outside click → closes everything
- `Esc` → closes menu, then trigger
- Selection cleared → closes everything

## Architecture

```text
contents/selection-toolbar.tsx   Plasmo CSUI entry (shadow DOM + Tailwind)
lib/selection/
  store.ts                       Zustand UI state
  actions.ts                     Action dispatch stub (console)
  hooks/                         Selection + dismiss behaviors
  components/                    FAB, menu, icons
  utils/                         DOM selection helpers
```

## Stack

- React + TypeScript
- Tailwind CSS (semantic tokens via CSS variables)
- Framer Motion
- Floating UI
- Zustand

## Theming

Light/dark follow `prefers-color-scheme`. Tokens live in `style.css` (`--px-*`) and map to Tailwind utilities (`bg-elevated`, `text-primary`, `border-border`, …). No hardcoded dark-only surfaces in components.

## Local development

```bash
pnpm --filter @project-x/extension dev
```

Chrome:

1. `chrome://extensions`
2. Developer mode → **Load unpacked**
3. Select `apps/extension/build/chrome-mv3-dev`
4. Open any webpage, select text

## Production build

```bash
pnpm --filter @project-x/extension build
```
