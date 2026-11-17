import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = { params: new URLSearchParams('next=%2Fapp%2Fmemory'), replace: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => nav.params,
}));
const api = {
  getGrowthProfile: vi.fn(),
  updateGrowthProfile: vi.fn(),
  skipGrowthProfile: vi.fn(),
};
vi.mock('../../../lib/growth-profile', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getGrowthProfile: () => api.getGrowthProfile(),
    updateGrowthProfile: (...a: unknown[]) => api.updateGrowthProfile(...a),
    skipGrowthProfile: () => api.skipGrowthProfile(),
  };
});
const warning = vi.fn();
vi.mock('../../../lib/notify', () => ({ notify: { warning: (...a: unknown[]) => warning(...a) } }));

import WelcomePage from './page';

const empty = {
  professionalRole: null,
  usageIntent: null,
  primaryGoal: null,
  profileCompletedAt: null,
  profileSkippedAt: null,
  marketingEmailConsent: false,
  marketingConsentUpdatedAt: null,
};

beforeEach(() => {
  nav.params = new URLSearchParams('next=%2Fapp%2Fmemory');
  nav.replace.mockReset();
  Object.values(api).forEach((fn) => fn.mockReset());
  warning.mockReset();
  api.getGrowthProfile.mockResolvedValue(empty);
  api.updateGrowthProfile.mockResolvedValue(empty);
  api.skipGrowthProfile.mockResolvedValue(empty);
});
afterEach(() => cleanup());

describe('/app/welcome (optional questions)', () => {
  it('shows three optional questions on one screen', async () => {
    render(<WelcomePage />);
    expect(
      await screen.findByRole('heading', { name: 'Make Project X work better for you' }),
    ).toBeTruthy();
    expect(screen.getAllByRole('radiogroup')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'Tech Lead' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Working with a team' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Review pull requests faster' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeTruthy();
  });

  it('Continue with one answer saves only that answer, then goes to the destination', async () => {
    render(<WelcomePage />);
    fireEvent.click(await screen.findByRole('radio', { name: 'QA Engineer' }));
    expect(screen.getByRole('radio', { name: 'QA Engineer' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    });
    expect(api.updateGrowthProfile).toHaveBeenCalledWith({ professionalRole: 'qa_engineer' });
    expect(nav.replace).toHaveBeenCalledWith('/app/memory');
  });

  it('a selected answer can be cleared; Continue with nothing selected counts as skip', async () => {
    render(<WelcomePage />);
    const chip = await screen.findByRole('radio', { name: 'Just exploring' });
    fireEvent.click(chip);
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    });
    expect(api.updateGrowthProfile).not.toHaveBeenCalled();
    expect(api.skipGrowthProfile).toHaveBeenCalledTimes(1);
  });

  it('Skip for now records the skip and continues', async () => {
    render(<WelcomePage />);
    const skip = await screen.findByRole('button', { name: 'Skip for now' });
    await act(async () => {
      fireEvent.click(skip);
    });
    expect(api.skipGrowthProfile).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith('/app/memory');
  });

  it('a save failure never blocks the dashboard', async () => {
    api.updateGrowthProfile.mockRejectedValue(new Error('offline'));
    render(<WelcomePage />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Tech Lead' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    });
    expect(warning).toHaveBeenCalled();
    expect(nav.replace).toHaveBeenCalledWith('/app/memory');
  });

  it('returning users (answered or skipped) and load failures go straight on', async () => {
    for (const profile of [
      { ...empty, profileCompletedAt: '2026-11-01T00:00:00.000Z' },
      { ...empty, profileSkippedAt: '2026-11-01T00:00:00.000Z' },
    ]) {
      api.getGrowthProfile.mockResolvedValue(profile);
      render(<WelcomePage />);
      await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/app/memory'));
      expect(
        screen.queryByRole('heading', { name: 'Make Project X work better for you' }),
      ).toBeNull();
      cleanup();
      nav.replace.mockReset();
    }
    api.getGrowthProfile.mockRejectedValue(new Error('down'));
    render(<WelcomePage />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/app/memory'));
  });

  it('an unsafe next parameter falls back to /app', async () => {
    nav.params = new URLSearchParams('next=https%3A%2F%2Fevil.example');
    render(<WelcomePage />);
    const skip = await screen.findByRole('button', { name: 'Skip for now' });
    await act(async () => {
      fireEvent.click(skip);
    });
    expect(nav.replace).toHaveBeenCalledWith('/app');
  });
});
