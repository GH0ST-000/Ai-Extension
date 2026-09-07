'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

import { APP_NAME } from '@project-x/shared';

import { ApiError, login, register } from '../../lib/api';
import { BrandMark } from '../../components/brand-mark';

type Mode = 'login' | 'register';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      if (mode === 'register') {
        await register({
          email,
          password,
          name: name.trim() || undefined,
        });
      } else {
        await login({ email, password });
      }
      router.replace('/app');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in.');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="atmosphere relative flex min-h-screen items-center justify-center overflow-hidden px-6 py-12">
      <div className="pointer-events-none absolute inset-0 grid-fade opacity-40" aria-hidden />
      <div
        className="pointer-events-none absolute left-[10%] top-[15%] h-72 w-72 rounded-full bg-accent/25 blur-3xl float-soft"
        aria-hidden
      />

      <div className="relative w-full max-w-md rise-in">
        <div className="mb-8 flex justify-center">
          <BrandMark size="lg" />
        </div>

        <div className="panel-glass rounded-3xl p-7 shadow-panel md:p-8">
          <p className="text-center text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
            {mode === 'login' ? 'Welcome back' : 'Create account'}
          </p>
          <h1 className="mt-3 text-center font-display text-3xl font-semibold tracking-tight text-ink">
            {mode === 'login' ? `Sign in to ${APP_NAME}` : `Join ${APP_NAME}`}
          </h1>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            {mode === 'login'
              ? 'Use the same account in the Chrome extension.'
              : 'Registration unlocks AI settings and the extension.'}
          </p>

          <form className="mt-8 space-y-4" onSubmit={onSubmit}>
            {mode === 'register' ? (
              <div className="space-y-2">
                <label htmlFor="name" className="text-sm font-semibold text-ink">
                  Name
                </label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Optional"
                  className="w-full rounded-xl border border-line bg-white/80 px-3.5 py-2.5 text-sm text-ink outline-none ring-accent/30 placeholder:text-muted-foreground focus:ring-2"
                />
              </div>
            ) : null}

            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-semibold text-ink">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
                className="w-full rounded-xl border border-line bg-white/80 px-3.5 py-2.5 text-sm text-ink outline-none ring-accent/30 placeholder:text-muted-foreground focus:ring-2"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-semibold text-ink">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 8 characters"
                className="w-full rounded-xl border border-line bg-white/80 px-3.5 py-2.5 text-sm text-ink outline-none ring-accent/30 placeholder:text-muted-foreground focus:ring-2"
              />
            </div>

            {error ? (
              <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            ) : null}

            <button
              className="w-full rounded-xl bg-ink px-4 py-3 text-sm font-semibold text-white transition hover:bg-ink/90 disabled:opacity-60"
              disabled={pending}
              type="submit"
            >
              {pending ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {mode === 'login' ? (
              <>
                No account?{' '}
                <button
                  type="button"
                  className="font-semibold text-accent underline-offset-4 hover:underline"
                  onClick={() => {
                    setMode('register');
                    setError(null);
                  }}
                >
                  Register
                </button>
              </>
            ) : (
              <>
                Already registered?{' '}
                <button
                  type="button"
                  className="font-semibold text-accent underline-offset-4 hover:underline"
                  onClick={() => {
                    setMode('login');
                    setError(null);
                  }}
                >
                  Sign in
                </button>
              </>
            )}
          </p>

          <p className="mt-4 text-center text-sm text-muted-foreground">
            <Link href="/" className="underline-offset-4 hover:underline">
              Back to home
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
