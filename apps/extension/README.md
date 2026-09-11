# @project-x/extension

Chrome extension for Project X — Plasmo + React + TypeScript.

## Auth (required)

Ask AI requires a signed-in account. Use the extension popup to **register** or **sign in** (same credentials as the dashboard). The JWT is stored in `chrome.storage.local` and sent as `Authorization: Bearer …` on every AI request.

Tune response length, style, and page context from the dashboard **Settings** page (`/app/settings`).

## Day 5 — Smart action ranking

Action order adapts to the selection using **local heuristics only** (no AI call before the user picks an action):

1. Classify selection → `code` | `error` | `prose` | `short-text` | `structured-data` | `unknown`
2. Rank the existing catalog actions (nothing removed)
3. Render the menu (and keyboard shortcuts) in that order

GitHub / `pre`/`code` hints promote **Explain Code** when appropriate. Implementation: `lib/selection/smart-actions/`.

Keyboard shortcuts (`E I S T C R F A P`) always map to **AIAction** identities via `SHORTCUT_TO_ACTION` — never to the visible menu index after ranking.

## Day 7 — GitHub intelligence

On GitHub PRs and file views, Project X extracts richer context (PR title/body, base/head when available, nearby diff hunk / file path) and adds **Code Review** (`REVIEW_CODE`, shortcut `R`).

On PR diffs, Smart Actions promote **Review Entire PR → Code Review → Suggest Fix**. Streaming still uses the existing NestJS / Vercel AI SDK path — no parallel GitHub backend.

## Day 8 — Suggest Fix + patch preview

After **Code Review**, the result panel offers **Suggest Fix** (`SUGGEST_FIX`, shortcut `F`). The model returns a minimal corrected snippet; the UI shows a **patch preview** and **Copy Fix** (clipboard only — no GitHub write / OAuth).

You can also run Suggest Fix directly from the menu. Prior review text is passed as `customPrompt` when launched from the review panel.

## Day 9 — Review Entire PR

On a GitHub PR (best on the **Files** tab), **Review Entire PR** (`REVIEW_ENTIRE_PR`, shortcut `A`) collects a **bounded** multi-file slice from the DOM (`changedFiles` on `PageContextGitHub`), streams a **Summary + Risk Findings**, and lets you **Suggest Fix** per finding.

Limits: only files currently loaded in the page, capped file count / excerpt size — incomplete PRs set `changedFilesTruncated`.

## Day 10 — PR Review Report + handoff

After Review Entire PR finishes, the result panel becomes a **compact review report** (still ~400px — not a dashboard):

- Repo / PR header, risk level, and compact stats
- Filter findings: All · High · Med · Low · Open · Reviewed · Ignored
- Session-only **Mark Reviewed / Ignore / Reopen** (cleared on dismiss or a new PR review)
- **Summary** toggle + **Copy Summary**
- **Export Markdown** (full review artifact)
- **Copy Comment** — clipboard draft for manual paste (not posted to GitHub)
- **Suggest Fix** per finding

No GitHub write access yet. Types live in `@project-x/types` (`PRReviewReport` / `PRReviewFinding`); the report is assembled client-side from Day 9 markdown + page context.

### GitHub connection (PAT)

Users paste a Personal Access Token in dashboard **Settings → GitHub**. The API validates it with GitHub, stores AES-GCM ciphertext in `github_connections`, and never returns the raw token. This unblocks Day 12 write actions without putting secrets in the extension.

Create a token: https://github.com/settings/personal-access-tokens/new (Pull requests: Read and write).

### Day 12 — Post PR comment

With a connected GitHub PAT, the PR report offers **Post to GitHub**:

1. Preview the comment draft
2. Confirm
3. API posts via your stored token (`POST /api/github/pull-requests/comments`)
4. Idempotency key prevents duplicate posts on double-click (Redis, 24h)

Token never leaves the API. **Copy Comment** still works for manual paste.

### Day 13 — Submit PR review

Curate findings into a session-only **Review Draft**, edit comments / overall body, choose **COMMENT** (default) / **APPROVE** / **REQUEST_CHANGES**, preview an immutable snapshot, then confirm. The API submits a grouped GitHub Pull Request Review (`POST /api/github/pull-requests/:owner/:repo/:number/reviews`).

- Inline comments only when trusted diff coordinates exist (Day 10 findings currently fall back to PR-level notes aggregated into the body)
- Redis idempotency + lock; uncertain writes are not auto-retried
- Draft stays bound to the original PR — never retargets on SPA navigation
- Day 12 **Post to GitHub** comment flow still works alongside reviews

### Day 14 — Apply Fix

After **Suggest Fix** on a PR finding that has a trusted file path, **Apply Fix** prepares against the live PR head (no write), shows the exact old→new diff + editable commit message, then **Apply Fix & Commit** updates only the PR head branch via the GitHub Contents API (single-file modify). Stale head/file SHA blocks the write. **Copy Fix** still works without GitHub write access.

## Day 11 — Error Intelligence

When a software error is confidently detected (local multi-signal scoring — not an AI classify call), Smart Actions promote:

1. **Find Root Cause** (`FIND_ROOT_CAUSE`, shortcut `O`)
2. **Suggest Fix** (`SUGGEST_FIX`, shortcut `F`)
3. **Understand Error** (`UNDERSTAND_ERROR`, shortcut `U`)

The extension builds an `ErrorIntelligenceContext` (classification, stack frames, nearby code, GitHub metadata when available), redacts obvious secrets, and streams through the existing NestJS endpoint. Replace is hidden for these diagnostic actions. Prose like “the campaign failed” must not trigger error actions.

## Day 6 — In-place Replace

When the selection is inside an editable field (`textarea`, supported text-like `input`s, or `contenteditable`), the result panel shows **Replace**.

Flow: capture editable snapshot → run AI → **Replace** writes the result back into the original field (native value setter + input/change events). Password / disabled / readonly fields are never modified. DOM logic lives in `lib/editing/` — not in React components and not on the API.

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
lib/context/                     Page context extractors (generic + GitHub + Jira Cloud)
lib/editing/                     Editable detect + safe in-place replace (Day 6)
lib/selection/
  smart-actions/                 Content classifier + action ranking (Day 5)
  ci/                            CI status + CI Fix Session (Days 15–16)
  jira/                          Jira issue session + panel (Day 17, read-only)
  openapi/                       OpenAPI panel + PR API-change analyze (Day 18)
  store.ts                       Zustand assistant view state
  hooks/                         Selection + dismiss + document href SPA watch
  components/                    FAB, menu, loading, result, error, custom prompt
  utils/                         DOM selection helpers
```

Assistant views use a discriminated union: `menu` → `custom-prompt` | `loading` → `streaming` → `success` | `error`.

### Day 18 — OpenAPI / API contract (read-only)

- Detects Swagger UI / Redoc / raw OpenAPI documents; panel actions: explain endpoint/request/response, generate example, contract risks, compare with Jira.
- On GitHub PRs, when Files-tab context includes OpenAPI/Swagger paths (`openapi.json`, `*swagger*.yaml`, …), shows **Analyze API Changes**:
  1. Fetches base + head file text via `POST /github/pull-requests/.../file-versions` (stored PAT; Contents API; bound to PR `baseSha`/`headSha`)
  2. Runs deterministic `POST /openapi/diff`
  3. Starts `ANALYZE_API_CHANGES` with that structural summary as `selectedText`
- Never executes the documented API (no Try It), never captures auth credentials, never mutates GitHub for this flow.
- Shared URL helpers in `@project-x/shared` are browser-safe (no `node:dns` / `node:net`); DNS SSRF checks stay on the API fetch path only.

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
