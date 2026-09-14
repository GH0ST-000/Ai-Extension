import type { Metadata } from 'next';
import Link from 'next/link';

import { BrandGlyph } from '../components/brand-mark';
import { SITE_NAME, SITE_TAGLINE } from '../lib/site';

export const metadata: Metadata = {
  title: 'Page not found',
  robots: {
    index: false,
    follow: true,
  },
};

export default function NotFoundPage() {
  return (
    <main className="atmosphere relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 py-16">
      <div className="pointer-events-none absolute inset-0 grid-fade opacity-40" aria-hidden />
      <div className="relative mx-auto max-w-lg text-center rise-in">
        <BrandGlyph size={48} className="mx-auto mb-6 rounded-[1.1rem] shadow-soft" />
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">404</p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink md:text-4xl">
          This page is not in the map.
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground md:text-base">
          {SITE_NAME} — {SITE_TAGLINE} Head back to the landing page or open the studio.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/"
            className="inline-flex rounded-2xl bg-ink px-5 py-2.5 text-sm font-semibold text-inverse transition hover:opacity-90"
          >
            Back home
          </Link>
          <Link
            href="/app"
            className="inline-flex rounded-2xl border border-line bg-panel/80 px-5 py-2.5 text-sm font-semibold text-ink transition hover:bg-panel"
          >
            Open studio
          </Link>
        </div>
      </div>
    </main>
  );
}
