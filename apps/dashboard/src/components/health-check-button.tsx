'use client';

import { useEffect, useId, useRef, useState } from 'react';

import { ApiError, fetchApiHealth, getApiBaseUrl, type TerminusHealthResponse } from '../lib/api';

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; data: TerminusHealthResponse; checkedAt: Date }
  | { kind: 'error'; message: string };

function statusTone(status: string): {
  label: string;
  dot: string;
  chip: string;
  glow: string;
} {
  if (status === 'ok' || status === 'up') {
    return {
      label: status === 'ok' ? 'Healthy' : 'Up',
      dot: 'bg-accent',
      chip: 'border-accent/30 bg-accent-soft text-ink',
      glow: 'bg-accent/20',
    };
  }

  return {
    label: status === 'down' ? 'Down' : 'Issue',
    dot: 'bg-spark',
    chip: 'border-spark/40 bg-spark/10 text-ink',
    glow: 'bg-spark/20',
  };
}

function serviceCopy(name: string): string {
  if (name === 'database') {
    return 'PostgreSQL connectivity via Prisma';
  }
  if (name === 'redis') {
    return 'Cache and queue broker';
  }
  return 'Service indicator';
}

export function HealthCheckButton() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    async function load() {
      setState({ kind: 'loading' });
      try {
        const data = await fetchApiHealth();
        if (!cancelled) {
          setState({ kind: 'success', data, checkedAt: new Date() });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            kind: 'error',
            message:
              error instanceof ApiError
                ? error.message
                : 'Could not reach the API. Is it running on :3001?',
          });
        }
      }
    }

    void load();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);

    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 40);

    return () => {
      cancelled = true;
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(focusTimer);
    };
  }, [open]);

  async function refresh() {
    setState({ kind: 'loading' });
    try {
      const data = await fetchApiHealth();
      setState({ kind: 'success', data, checkedAt: new Date() });
    } catch (error) {
      setState({
        kind: 'error',
        message:
          error instanceof ApiError
            ? error.message
            : 'Could not reach the API. Is it running on :3001?',
      });
    }
  }

  const details =
    state.kind === 'success' ? Object.entries(state.data.details ?? state.data.info ?? {}) : [];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-xl border border-line bg-white/80 px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-white"
      >
        Check API health
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4 sm:p-6"
          role="presentation"
        >
          <button
            type="button"
            aria-label="Close health dialog"
            className="fixed inset-0 bg-ink/45 backdrop-blur-[6px] health-backdrop-in"
            onClick={() => setOpen(false)}
          />

          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="relative z-10 my-auto w-full max-w-lg rounded-[1.75rem] border border-line bg-white shadow-[0_28px_80px_-24px_rgba(15,23,42,0.45)] health-panel-in"
          >
            <div
              className="pointer-events-none absolute inset-0 overflow-hidden rounded-[1.75rem]"
              aria-hidden
            >
              <div className="absolute -left-16 -top-20 h-56 w-56 rounded-full bg-accent/20 blur-3xl" />
              <div className="absolute -bottom-24 -right-10 h-52 w-52 rounded-full bg-spark/15 blur-3xl" />
            </div>

            <div className="relative px-7 pb-5 pt-8 sm:px-8 sm:pt-9">
              <div className="flex items-start justify-between gap-5">
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
                    System pulse
                  </p>
                  <h2
                    id={titleId}
                    className="mt-3 font-display text-[1.75rem] font-semibold leading-[1.2] tracking-tight text-ink sm:text-3xl"
                  >
                    API health
                  </h2>
                  <p className="mt-2 break-all text-sm leading-relaxed text-muted-foreground">
                    Live check against{' '}
                    <span className="font-medium text-ink/75">{getApiBaseUrl()}/api/health</span>
                  </p>
                </div>
                <button
                  ref={closeRef}
                  type="button"
                  onClick={() => setOpen(false)}
                  className="shrink-0 rounded-xl border border-line bg-mist/80 px-3.5 py-2.5 text-sm font-semibold text-ink transition hover:bg-mist"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="relative mx-7 border-t border-line/80 sm:mx-8" />

            <div className="relative space-y-4 px-7 py-6 sm:space-y-5 sm:px-8 sm:py-7">
              {state.kind === 'loading' || state.kind === 'idle' ? (
                <div className="flex flex-col items-center gap-4 py-12">
                  <span
                    className="h-11 w-11 rounded-full border-2 border-line border-t-accent health-spin"
                    aria-hidden
                  />
                  <p className="text-sm font-medium text-muted-foreground">
                    Probing database and Redis…
                  </p>
                </div>
              ) : null}

              {state.kind === 'error' ? (
                <div className="rounded-2xl border border-spark/35 bg-spark/10 px-5 py-6 sm:px-6">
                  <p className="font-display text-xl font-semibold leading-snug tracking-tight text-ink">
                    Unreachable
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {state.message}
                  </p>
                </div>
              ) : null}

              {state.kind === 'success' ? (
                <>
                  <div className="relative overflow-hidden rounded-2xl border border-line bg-mist/80 px-5 py-5 sm:px-6 sm:py-6">
                    <div
                      className={`pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full blur-2xl ${statusTone(state.data.status).glow}`}
                      aria-hidden
                    />
                    <div className="relative flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                          Overall
                        </p>
                        <p className="mt-2 font-display text-[1.75rem] font-semibold leading-[1.2] tracking-tight text-ink sm:text-3xl">
                          {statusTone(state.data.status).label}
                        </p>
                        <p className="mt-3 text-xs leading-normal text-muted-foreground">
                          Checked{' '}
                          {state.checkedAt.toLocaleTimeString(undefined, {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </p>
                      </div>
                      <span
                        className={`mt-0.5 inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${statusTone(state.data.status).chip}`}
                      >
                        <span
                          className={`h-2 w-2 rounded-full ${statusTone(state.data.status).dot} health-pulse`}
                        />
                        {state.data.status}
                      </span>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 sm:gap-4">
                    {details.map(([name, detail], index) => {
                      const tone = statusTone(detail.status);
                      return (
                        <div
                          key={name}
                          className="flex min-h-[7.5rem] flex-col rounded-2xl border border-line/90 bg-white px-5 py-5 health-card-in"
                          style={{ animationDelay: `${80 + index * 70}ms` }}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-sm font-semibold capitalize leading-none text-ink">
                              {name}
                            </p>
                            <span
                              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${tone.chip}`}
                            >
                              <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                              {tone.label}
                            </span>
                          </div>
                          <p className="mt-auto pt-4 text-xs leading-relaxed text-muted-foreground">
                            {serviceCopy(name)}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : null}
            </div>

            <div className="relative flex flex-wrap items-center justify-between gap-3 rounded-b-[1.75rem] border-t border-line/80 bg-mist/50 px-7 py-5 sm:px-8">
              <p className="text-xs leading-normal text-muted-foreground">
                Esc to close · stays in the studio
              </p>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={state.kind === 'loading'}
                className="rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-ink/90 disabled:opacity-50"
              >
                {state.kind === 'loading' ? 'Checking…' : 'Refresh'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
