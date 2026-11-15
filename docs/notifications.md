# Notifications

One notification foundation for every Project X frontend. **State, timing and contracts are
shared; rendering belongs to each app**, because the Dashboard (Next.js page) and the Chrome
Extension (closed Shadow DOM on third-party pages) have different mounting, styling and
lifecycle constraints.

```
packages/shared/src/notifications/      framework-free foundation (no React, no DOM required)
  types.ts            contracts: NotificationKind, NotificationRecord, NotificationStore, Notifier
  store.ts            createNotificationStore(): ids, timers, de-duplication, update, pause, exit delay
  notifier.ts         createNotifier(store): success/error/warning/info/loading/update/dismiss/promise
                      notificationAriaRole / notificationAriaLive
  normalize-error.ts  normalizeError / safeErrorMessage / isSafeDisplayMessage
apps/dashboard/src/lib/notify.ts                     the dashboard's store + `notify` (singleton)
apps/dashboard/src/components/notifications/toaster.tsx   the dashboard renderer (mounted once)
```

Everything is exported from `@project-x/shared`.

## Public API

```ts
import { notify } from '@/lib/notify'; // dashboard (relative import in this repo)

notify.success('Rule saved', 'Applies to future AI reviews of acme/app.');
notify.error('Could not save rule', { description: '…', duration: null });
notify.warning('Workspace no longer available');
notify.info('Heads up');
const id = notify.loading('Learning project context…');
notify.update(id, { kind: 'success', title: 'Learned 3 facts' }); // in place
notify.dismiss(id); // or notify.dismiss() for all

// loading → success / error; success only after the operation resolved; rethrows on failure
await notify.promise(saveRule(), {
  loading: 'Saving rule…',
  success: (rule) => ({ title: 'Rule saved', description: rule.key }),
  error: (err) => ({ title: 'Could not save rule', description: safeErrorMessage(err) }),
  // or error: null → just remove the loading toast (error shown inline instead)
});

notify.apiError('Could not archive rule', err); // dashboard helper: always a safe message
```

Options (`NotificationOptions`): `id` (show with an existing id = update in place),
`description`, `duration` (ms, `null` = sticky), `dedupeKey` (`null` disables
de-duplication), `dismissible`.

### Behaviour

| Concern | Rule |
|---|---|
| Ids | Unique (`ntf_…`) unless the caller passes one. |
| Auto-dismiss | success 4 s, info 5 s, warning 6 s, error 8 s, loading never. Per call: `duration`. |
| Manual dismiss | Close button / Escape (not for loading), `notify.dismiss(id)`. |
| Duplicates | Same kind + title + description while visible → the existing one is refreshed and `count` increases (shown as ×N). Concurrent `promise()` runs never merge. |
| Update | `update(id, patch)` or `show(…, { id })`; changing kind applies that kind's duration. |
| Limit | 4 visible in the dashboard (5 default); the oldest non-loading closes first. |
| Pause | Hover or focus pauses all timers; remaining time is kept. |
| Exit animation | Dismissed items stay `open: false` for `exitDurationMs`, then are removed. |
| Text | Titles ≤ 120 chars, descriptions ≤ 300, whitespace collapsed. |

### Safe error messages

`normalizeError(err, fallback?)` → `{ category, message, status?, code? }`.

- Network failures (`TypeError: Failed to fetch`, offline) → "Can't reach Project X…"
- 401 → sign in again (server text ignored). 5xx → generic message, never server text.
- Other 4xx → the server's message **only if** `isSafeDisplayMessage` accepts it: short, no stack
  frames, file paths, SQL, Prisma/driver errors, HTML/JSON payloads, auth headers or credentials
  (shared secret detector). Otherwise a generic message for the category.
- Codes are passed through only when they look like API codes (`PROJECT_MEMORY_CONFLICT`).

### Accessibility

Renderers announce through **persistent** live regions (created before any notification, so
screen readers pick up changes reliably): `notificationAriaLive(kind)` → `assertive` for errors,
`polite` otherwise. Outcome changes (loading → success) are announced once. Keyboard: F8 focuses
the newest notification, Escape dismisses the focused one, close buttons are labelled.

## Dashboard

- `lib/notify.ts` creates the store once at module level, so notifications survive client-side
  navigation; `<Toaster />` is mounted once in `app/layout.tsx` (a test enforces this). A second
  `<Toaster>` renders nothing and warns in development.
- Top-right on desktop, full width at the top on small screens. The stack is
  `pointer-events-none` (only the toasts take clicks) so it never blocks page controls.
- Styling uses the existing theme tokens (`bg-panel`, `border-line`, `text-ink`,
  `text-muted-foreground`, `shadow-panel`) and restrained status colours; animations in
  `globals.css` (`.toast`), reduced to a fade with `prefers-reduced-motion`.
- Feature code calls `notify` / `notify.apiError`; it never renders its own toasts.
  Project Memory uses `app/app/memory/memory-notifications.ts` (`runMemoryMutation`) as an example
  of a feature-level wrapper: success only after server confirmation, loading for long
  operations, inline handling for form validation and edit conflicts.

## Extension adoption plan (not implemented yet)

The extension already depends on `@project-x/shared`, so the store, notifier and error
normalization can be imported as-is. What differs is the renderer:

1. **Store per JS context.** Create one store + notifier per context: the GitHub content script
   (`contents/selection-toolbar.tsx`) and the popup (`popup.tsx`) are separate JS worlds; the
   background service worker has no DOM and should send messages to a UI context instead of
   rendering.
2. **Render inside the existing closed shadow root**, as a sibling of the selection toolbar inside
   `ContentScriptErrorBoundary`, never into the host page DOM and never the dashboard's
   `<Toaster>`. Styles come from the extension's own `style.css` (injected by Plasmo's
   `getStyle`) using the extension's Tailwind tokens; framer-motion is available for animation.
3. **Live regions inside the shadow root** work for screen readers; keep them persistent like
   the dashboard renderer.
4. **Z-index and placement:** the toolbar floats near the selection; a toast stack should sit at
   the viewport corner with a z-index above the toolbar and be `pointer-events-none` except for
   the toasts, so GitHub controls stay usable.
5. **Lifecycle:** the content script lives as long as the tab; call `store.reset()` when the
   toolbar is torn down (sign-out, workspace switch) so timers do not outlive the UI.
6. **Migrate incrementally:** existing extension feedback (inline result panels, error panels,
   `mapToUserFacingError`) stays; new transient confirmations (e.g. "Review comment posted") are
   the first candidates. Use `normalizeError` for any API error text shown in a notification.

## Tests

- `packages/shared/src/notifications/notifications.spec.ts` — store, notifier, promise lifecycle,
  de-duplication, pause, exit, limits, error normalization, ARIA roles (fake clock).
- `apps/dashboard/src/components/notifications/toaster.spec.tsx` — renderer: single mount,
  announcements, loading → success / error, dismissal, Escape, F8, hover pause, duplicates,
  remount across navigation, safe `apiError`, exactly one `<Toaster>` in the app.
- `apps/dashboard/src/app/app/memory/memory-notifications.spec.tsx` — Project Memory outcomes.

Dashboard tests run with `pnpm --filter @project-x/dashboard test` (vitest + jsdom).
