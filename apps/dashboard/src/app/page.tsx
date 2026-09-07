import Link from 'next/link';

import { APP_NAME } from '@project-x/shared';

import { BrandMark } from '../components/brand-mark';

export default function HomePage() {
  return (
    <main className="atmosphere relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 grid-fade opacity-50" aria-hidden />
      <div
        className="pointer-events-none absolute left-[-10%] top-[-10%] h-[42rem] w-[42rem] rounded-full bg-accent/20 blur-3xl float-soft"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute bottom-[-20%] right-[-8%] h-[36rem] w-[36rem] rounded-full bg-spark/15 blur-3xl"
        aria-hidden
      />

      <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-8 md:px-10">
        <header className="flex items-center justify-between rise-in">
          <BrandMark />
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="rounded-xl px-3 py-2 text-sm font-semibold text-muted-foreground transition hover:text-ink"
            >
              Sign in
            </Link>
            <Link
              href="/login"
              className="rounded-xl bg-ink px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-ink/90"
            >
              Sign in
            </Link>
          </div>
        </header>

        <section className="flex flex-1 flex-col justify-center py-16 md:py-20">
          <div className="rise-in-delay-1 max-w-3xl">
            <p className="mb-5 font-display text-5xl font-semibold tracking-tight text-ink md:text-7xl">
              {APP_NAME}
            </p>
            <h1 className="max-w-2xl font-display text-3xl font-semibold leading-[1.08] tracking-tight text-ink text-balance md:text-5xl">
              AI that reads the page with you.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground md:text-xl">
              Highlight anything in Chrome. Get streamed answers with GitHub and web context —
              without leaving the tab.
            </p>

            <div className="mt-9 flex flex-wrap gap-3">
              <Link
                href="/login"
                className="rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-accent-foreground shadow-soft transition hover:brightness-110"
              >
                Sign in
              </Link>
              <Link
                href="/login"
                className="rounded-2xl border border-line bg-white/75 px-5 py-3 text-sm font-semibold text-ink transition hover:bg-white"
              >
                Create account
              </Link>
            </div>
          </div>

          <div className="rise-in-delay-2 mt-16 grid max-w-4xl gap-3 sm:grid-cols-3">
            {[
              ['Select', 'Any passage or code'],
              ['Context', 'Generic web + GitHub'],
              ['Stream', 'Same floating panel'],
            ].map(([title, copy]) => (
              <div
                key={title}
                className="rounded-2xl border border-line/80 bg-white/65 px-4 py-4 shadow-panel"
              >
                <p className="font-display text-lg font-semibold tracking-tight text-ink">
                  {title}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{copy}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
