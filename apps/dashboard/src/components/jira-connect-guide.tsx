'use client';

import { useId, useState } from 'react';

const ATLASSIAN_API_TOKENS = 'https://id.atlassian.com/manage-profile/security/api-tokens';
const JIRA_FREE = 'https://www.atlassian.com/software/jira/free';

const STEPS = [
  {
    title: 'Get a Jira Cloud site',
    detail:
      'Use your company site, or create a free one at atlassian.com. You need a *.atlassian.net host.',
  },
  {
    title: 'Open API tokens',
    detail: 'id.atlassian.com → Security → API tokens (not your password).',
  },
  {
    title: 'Create a token',
    detail: 'Name it “Project X”, create, and copy it once.',
  },
  {
    title: 'Note your site host',
    detail: 'From any issue URL: https://your-site.atlassian.net/… → your-site.atlassian.net',
  },
  {
    title: 'Connect in Settings',
    detail: 'Paste email + site host + API token, then Connect Jira. Read-only — no issue writes.',
  },
] as const;

export function JiraConnectGuide() {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-2 rounded-xl border border-line bg-mist/80 px-3 py-2 text-sm font-semibold text-ink transition hover:bg-mist"
      >
        <span
          className={[
            'inline-flex h-5 w-5 items-center justify-center rounded-md border border-line bg-panel text-[11px] transition',
            open
              ? 'rotate-90 border-accent/40 bg-accent-soft text-accent'
              : 'text-muted-foreground',
          ].join(' ')}
          aria-hidden
        >
          ▸
        </span>
        {open ? 'Hide Jira guide' : 'How to connect Jira'}
      </button>

      {open ? (
        <div
          id={panelId}
          className="relative mt-3 overflow-hidden rounded-2xl border border-line bg-mist/40 rise-in"
        >
          <div className="pointer-events-none absolute inset-0" aria-hidden>
            <div className="absolute -right-8 -top-10 h-32 w-32 rounded-full bg-accent/15 blur-2xl" />
            <div className="absolute -bottom-12 left-8 h-28 w-28 rounded-full bg-spark/10 blur-2xl" />
          </div>

          <div className="relative border-b border-line/70 px-4 py-3 sm:px-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
              5 steps · Jira Cloud · read-only
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Needs{' '}
              <span className="font-semibold text-ink">email + API token + *.atlassian.net</span>.
              Project X never edits issues or posts comments.
            </p>
          </div>

          <ol className="relative divide-y divide-line/60">
            {STEPS.map((item, index) => (
              <li key={item.title} className="flex gap-3 px-4 py-3.5 sm:gap-4 sm:px-5">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-bold text-inverse">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">{item.title}</p>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                    {item.detail}
                  </p>
                </div>
              </li>
            ))}
          </ol>

          <div className="relative flex flex-wrap items-center gap-3 border-t border-line/70 bg-panel/50 px-4 py-3.5 sm:px-5">
            <a
              href={ATLASSIAN_API_TOKENS}
              target="_blank"
              rel="noreferrer"
              className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-soft transition hover:brightness-110"
            >
              Open API tokens
            </a>
            <a
              href={JIRA_FREE}
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border border-line bg-panel px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-mist"
            >
              Free Jira Cloud
            </a>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Token is validated, encrypted on the API, and never returned to the browser.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
