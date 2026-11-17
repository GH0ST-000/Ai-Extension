import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OnboardingView } from '@project-x/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storedUser = vi.fn();
// The theme toggle needs ThemeProvider; it is not under test here.
vi.mock('./theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('../lib/auth-storage', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getStoredUser: () => storedUser() };
});
const fetchOnboarding = vi.fn();
const dismissOnboarding = vi.fn();
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchOnboarding: () => fetchOnboarding(),
    markWelcomeSeen: vi.fn(async () => fetchOnboarding()),
    dismissOnboarding: () => dismissOnboarding(),
  };
});

import { getExtensionInstallUrl } from '../lib/extension-install';
import { LandingHeader } from './landing-header';
import { LandingHeroCtas } from './landing-hero-ctas';
import { FIRST_REVIEW_STEPS, OnboardingChecklist } from './onboarding-checklist';

function view(over: Partial<OnboardingView['steps']> = {}, status = 'in_progress'): OnboardingView {
  return {
    status,
    nextStep: 'connect_github',
    steps: {
      accountReady: true,
      workspaceReady: true,
      githubConnected: false,
      firstActionCompleted: false,
      ...over,
    },
    preferences: { welcomeSeen: true },
    recommendedAction: null,
  } as unknown as OnboardingView;
}

beforeEach(() => {
  storedUser.mockReset().mockReturnValue(null);
  fetchOnboarding.mockReset();
  dismissOnboarding.mockReset();
  vi.unstubAllEnvs();
});
afterEach(() => cleanup());

describe('landing registration CTAs', () => {
  it('signed out: Get Started opens registration; Sign in opens sign-in', () => {
    render(<LandingHeroCtas />);
    expect(screen.getByRole('link', { name: 'Get Started' }).getAttribute('href')).toBe(
      '/login?mode=register',
    );
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
    cleanup();
    render(<LandingHeader />);
    const header = within(screen.getByRole('banner'));
    expect(header.getByRole('link', { name: 'Get Started' }).getAttribute('href')).toBe(
      '/login?mode=register',
    );
    expect(header.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
  });

  it('signed in: no registration prompt, straight to the studio', async () => {
    storedUser.mockReturnValue({ id: 'u1', email: 'dev@example.com' });
    render(<LandingHeroCtas />);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Open Studio' })).toBeTruthy());
    expect(screen.queryByRole('link', { name: 'Get Started' })).toBeNull();
  });
});

describe('landing attribution', () => {
  it('Get Started carries allowlisted campaign parameters (and nothing else) to sign-up', async () => {
    window.history.replaceState(
      null,
      '',
      '/?utm_source=newsletter&utm_campaign=launch&token=secret',
    );
    try {
      render(<LandingHeroCtas />);
      await waitFor(() =>
        expect(screen.getByRole('link', { name: 'Get Started' }).getAttribute('href')).toBe(
          '/login?mode=register&utm_source=newsletter&utm_campaign=launch',
        ),
      );
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });
});

describe('extension install URL', () => {
  it('accepts only a configured https URL', () => {
    expect(getExtensionInstallUrl(undefined)).toBeNull();
    expect(getExtensionInstallUrl('  ')).toBeNull();
    expect(getExtensionInstallUrl('http://example.com/ext')).toBeNull();
    expect(getExtensionInstallUrl('javascript:alert(1)')).toBeNull();
    expect(getExtensionInstallUrl('not a url')).toBeNull();
    expect(getExtensionInstallUrl('https://example.com/ext')).toBe('https://example.com/ext');
  });
});

describe('first-review guidance (Get started card)', () => {
  it('shows the three-step first review journey and a truthful install fallback', async () => {
    fetchOnboarding.mockResolvedValue(view());
    render(<OnboardingChecklist />);
    const steps = within(await screen.findByRole('list', { name: 'First review steps' }));
    expect(steps.getAllByRole('listitem')).toHaveLength(3);
    for (const step of FIRST_REVIEW_STEPS) expect(steps.getByText(step.title)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Run your first AI PR review' })).toBeTruthy();
    // No invented store link when none is configured.
    expect(screen.getByTestId('extension-install-fallback')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Install the extension' })).toBeNull();
  });

  it('uses the configured install URL when one exists', async () => {
    vi.stubEnv('NEXT_PUBLIC_EXTENSION_INSTALL_URL', 'https://example.com/project-x');
    fetchOnboarding.mockResolvedValue(view());
    render(<OnboardingChecklist />);
    const link = await screen.findByRole('link', { name: 'Install the extension' });
    expect(link.getAttribute('href')).toBe('https://example.com/project-x');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('basic review needs no GitHub; connected users are told reviews use the full diff', async () => {
    fetchOnboarding.mockResolvedValue(view({ githubConnected: false }));
    render(<OnboardingChecklist />);
    const note = await screen.findByTestId('review-coverage-note');
    expect(note.textContent).toMatch(/No GitHub connection needed to start/);
    expect(within(note).getByRole('link', { name: 'connect GitHub' }).getAttribute('href')).toBe(
      '/app/settings',
    );
    cleanup();
    fetchOnboarding.mockResolvedValue(view({ githubConnected: true }));
    render(<OnboardingChecklist />);
    expect((await screen.findByTestId('review-coverage-note')).textContent).toMatch(
      /GitHub is connected — reviews use the full pull request diff/,
    );
  });

  it('stays visible after a generic first action (Ask AI) until a PR review exists', async () => {
    // Existing onboarding status is "completed" after any first action — not enough here.
    fetchOnboarding.mockResolvedValue({
      ...view({ firstActionCompleted: true }, 'completed'),
      firstPrReviewCompleted: false,
    });
    render(<OnboardingChecklist />);
    expect(
      await screen.findByRole('heading', { name: 'Run your first AI PR review' }),
    ).toBeTruthy();
  });

  it('hidden once the server reports a successful PR review, or after dismissal', async () => {
    for (const next of [
      { ...view({ firstActionCompleted: true }, 'completed'), firstPrReviewCompleted: true },
      { ...view({}, 'in_progress'), firstPrReviewCompleted: true },
      { ...view({}, 'dismissed'), firstPrReviewCompleted: false },
    ]) {
      fetchOnboarding.mockResolvedValue(next);
      const { container } = render(<OnboardingChecklist />);
      await waitFor(() => expect(fetchOnboarding).toHaveBeenCalled());
      expect(container.querySelector('[aria-label="Getting started"]')).toBeNull();
      cleanup();
      fetchOnboarding.mockClear();
    }
  });

  it('Dismiss still hides the card through the existing API', async () => {
    fetchOnboarding.mockResolvedValue(view());
    dismissOnboarding.mockResolvedValue(view({}, 'dismissed'));
    render(<OnboardingChecklist />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Run your first AI PR review' })).toBeNull(),
    );
    expect(dismissOnboarding).toHaveBeenCalledTimes(1);
  });
});
