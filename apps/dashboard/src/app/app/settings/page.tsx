'use client';

import { type FormEvent, useEffect, useState } from 'react';
import type { ResponseStyle, UserSettings } from '@project-x/types';
import { RESPONSE_STYLES } from '@project-x/types';

import { ApiError, getSettings, updateSettings } from '../../../lib/api';
import { clearSession, getStoredUser } from '../../../lib/auth-storage';
import { useRouter } from 'next/navigation';

const STYLE_LABELS: Record<ResponseStyle, string> = {
  CONCISE: 'Concise',
  BALANCED: 'Balanced',
  DETAILED: 'Detailed',
};

export default function SettingsPage() {
  const router = useRouter();
  const user = getStoredUser();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [draft, setDraft] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const next = await getSettings();
        if (cancelled) {
          return;
        }
        setSettings(next);
        setDraft(next);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Unable to load settings.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) {
      return;
    }

    setSaving(true);
    setMessage(null);
    setError(null);

    try {
      const saved = await updateSettings({
        maxOutputTokens: draft.maxOutputTokens,
        responseStyle: draft.responseStyle,
        includePageContext: draft.includePageContext,
      });
      setSettings(saved);
      setDraft(saved);
      setMessage('Settings saved. They apply to the next AI request.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to save settings.');
    } finally {
      setSaving(false);
    }
  }

  function signOut() {
    clearSession();
    router.replace('/login');
  }

  const dirty =
    draft &&
    settings &&
    (draft.maxOutputTokens !== settings.maxOutputTokens ||
      draft.responseStyle !== settings.responseStyle ||
      draft.includePageContext !== settings.includePageContext);

  return (
    <div className="space-y-8">
      <header className="rise-in">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
          Preferences
        </p>
        <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight text-ink">
          Settings
        </h1>
        <p className="mt-3 max-w-xl text-base text-muted-foreground">
          Control response length, tone, and whether page context is sent with AI requests.
        </p>
      </header>

      <section className="rise-in-delay-1 space-y-3">
        <h2 className="px-1 font-display text-lg font-semibold tracking-tight">Assistant</h2>

        {loading ? (
          <div className="rounded-3xl border border-line bg-white/75 px-5 py-8 text-sm text-muted-foreground shadow-panel">
            Loading settings…
          </div>
        ) : draft ? (
          <form
            onSubmit={onSubmit}
            className="overflow-hidden rounded-3xl border border-line bg-white/75 shadow-panel"
          >
            <div className="flex flex-col gap-3 border-b border-line/80 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-ink">Max output tokens</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Caps how long answers can be (150–2000). Lower is cheaper.
                </p>
              </div>
              <input
                type="number"
                min={150}
                max={2000}
                step={50}
                value={draft.maxOutputTokens}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    maxOutputTokens: Number(event.target.value),
                  })
                }
                className="w-28 rounded-xl border border-line bg-mist px-3 py-2 text-sm font-semibold text-ink outline-none ring-accent/30 focus:ring-2"
              />
            </div>

            <div className="flex flex-col gap-3 border-b border-line/80 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-ink">Response style</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  How verbose the assistant should be in the floating panel.
                </p>
              </div>
              <select
                value={draft.responseStyle}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    responseStyle: event.target.value as ResponseStyle,
                  })
                }
                className="rounded-xl border border-line bg-mist px-3 py-2 text-sm font-semibold text-ink outline-none ring-accent/30 focus:ring-2"
              >
                {RESPONSE_STYLES.map((style) => (
                  <option key={style} value={style}>
                    {STYLE_LABELS[style]}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-ink">Include page context</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Surrounding text, URL, and GitHub metadata with each request.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={draft.includePageContext}
                onClick={() =>
                  setDraft({
                    ...draft,
                    includePageContext: !draft.includePageContext,
                  })
                }
                className={[
                  'self-start rounded-xl border px-3 py-2 text-sm font-semibold sm:self-auto',
                  draft.includePageContext
                    ? 'border-accent bg-accent-soft text-ink'
                    : 'border-line bg-mist text-muted-foreground',
                ].join(' ')}
              >
                {draft.includePageContext ? 'On' : 'Off'}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-line/80 bg-mist/50 px-5 py-4">
              <button
                type="submit"
                disabled={saving || !dirty}
                className="rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-ink/90 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              {message ? <p className="text-sm text-accent">{message}</p> : null}
              {error ? <p className="text-sm text-red-600">{error}</p> : null}
            </div>
          </form>
        ) : (
          <div className="rounded-3xl border border-line bg-white/75 px-5 py-8 text-sm text-red-600 shadow-panel">
            {error ?? 'Settings unavailable.'}
          </div>
        )}
      </section>

      <section className="rise-in-delay-2 space-y-3">
        <h2 className="px-1 font-display text-lg font-semibold tracking-tight">Account</h2>
        <div className="rounded-3xl border border-line bg-white/75 p-6 shadow-panel">
          <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="font-display text-xl font-semibold tracking-tight text-ink">
                {user?.name?.trim() || user?.email || 'Signed in'}
              </p>
              {user?.email ? (
                <p className="mt-1 text-sm text-muted-foreground">{user.email}</p>
              ) : null}
              <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                Sign in with the same email in the extension popup to run Ask AI.
              </p>
            </div>
            <button
              type="button"
              onClick={signOut}
              className="inline-flex rounded-xl border border-line bg-white px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-mist"
            >
              Sign out
            </button>
          </div>
        </div>
      </section>

      <section className="rise-in-delay-3 grid gap-4 md:grid-cols-2">
        <div className="rounded-3xl bg-accent-soft p-6">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
            Privacy
          </p>
          <p className="mt-3 font-display text-2xl font-semibold tracking-tight text-ink">
            Secrets stay on the API.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            OpenAI keys never ship in the extension. Selected text is not written to product logs.
          </p>
        </div>
        <div className="rounded-3xl border border-line bg-white/70 p-6 shadow-panel">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Cost control
          </p>
          <p className="mt-3 font-display text-2xl font-semibold tracking-tight text-ink">
            Tokens follow you.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Concise style and lower max tokens reduce spend on every streamed answer.
          </p>
        </div>
      </section>
    </div>
  );
}
