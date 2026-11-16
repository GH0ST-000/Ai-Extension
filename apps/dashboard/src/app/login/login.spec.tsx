import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = { params: new URLSearchParams(), replace: vi.fn() };
// The theme toggle needs ThemeProvider; it is not under test here.
vi.mock('../../components/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  useSearchParams: () => nav.params,
}));
const fetchMe = vi.fn();
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchMe: (...a: unknown[]) => fetchMe(...a),
    login: vi.fn(),
    register: vi.fn(),
  };
});

import { authModeFromParam, authModeHref, REGISTER_HREF } from './auth-mode';
import LoginPage from './page';

beforeEach(() => {
  nav.params = new URLSearchParams();
  nav.replace.mockReset();
  fetchMe.mockReset().mockRejectedValue(new Error('no session'));
});
afterEach(() => cleanup());

describe('auth mode helpers', () => {
  it('only mode=register opens registration', () => {
    expect(authModeFromParam('register')).toBe('register');
    expect(authModeFromParam(null)).toBe('login');
    expect(authModeFromParam('login')).toBe('login');
    expect(authModeFromParam('REGISTER')).toBe('login');
    expect(authModeFromParam('<script>')).toBe('login');
  });

  it('builds mode URLs and keeps other parameters (next)', () => {
    expect(REGISTER_HREF).toBe('/login?mode=register');
    expect(authModeHref('register', null)).toBe('/login?mode=register');
    expect(authModeHref('login', new URLSearchParams('mode=register'))).toBe('/login');
    expect(authModeHref('register', new URLSearchParams('next=%2Fapp%2Fmemory'))).toBe(
      '/login?next=%2Fapp%2Fmemory&mode=register',
    );
    expect(authModeHref('login', new URLSearchParams('next=%2Fapp&mode=register'))).toBe(
      '/login?next=%2Fapp',
    );
  });
});

async function renderLogin() {
  render(<LoginPage />);
  // The existing-session check runs first; wait for the form.
  await waitFor(() => expect(screen.queryByText('Checking session…')).toBeNull(), {
    timeout: 4_000,
  });
}

describe('/login', () => {
  it('/login shows the normal sign-in form', async () => {
    await renderLogin();
    expect(screen.getByRole('heading', { name: /Sign in to/ })).toBeTruthy();
    expect(screen.queryByLabelText(/Name/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('/login?mode=register opens registration directly', async () => {
    nav.params = new URLSearchParams('mode=register');
    await renderLogin();
    expect(screen.getByRole('heading', { name: /Join/ })).toBeTruthy();
    expect(screen.getByLabelText(/Name/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeTruthy();
    expect(screen.getByText('Terms and Conditions')).toBeTruthy();
  });

  it('switching forms still works and keeps the URL (and next) in sync', async () => {
    nav.params = new URLSearchParams('next=%2Fapp%2Fmemory');
    await renderLogin();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    });
    expect(screen.getByRole('heading', { name: /Join/ })).toBeTruthy();
    expect(nav.replace).toHaveBeenLastCalledWith('/login?next=%2Fapp%2Fmemory&mode=register', {
      scroll: false,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    expect(screen.getByRole('heading', { name: /Sign in to/ })).toBeTruthy();
    expect(nav.replace).toHaveBeenLastCalledWith('/login?next=%2Fapp%2Fmemory', { scroll: false });
  });

  it('an existing session still skips the form (mode does not change that)', async () => {
    nav.params = new URLSearchParams('mode=register');
    fetchMe.mockResolvedValue({ id: 'u1', email: 'a@b.c', name: null });
    render(<LoginPage />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/app'));
  });

  it('sign-in shows "Forgot password?"; registration does not', async () => {
    await renderLogin();
    expect(screen.getByRole('link', { name: 'Forgot password?' }).getAttribute('href')).toBe(
      '/forgot-password',
    );
    cleanup();
    nav.params = new URLSearchParams('mode=register');
    await renderLogin();
    expect(screen.queryByRole('link', { name: 'Forgot password?' })).toBeNull();
  });
});
