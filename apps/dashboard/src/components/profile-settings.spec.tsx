import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  getGrowthProfile: vi.fn(),
  updateGrowthProfile: vi.fn(),
  setMarketingConsent: vi.fn(),
};
vi.mock('../lib/growth-profile', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getGrowthProfile: () => api.getGrowthProfile(),
    updateGrowthProfile: (...a: unknown[]) => api.updateGrowthProfile(...a),
    setMarketingConsent: (...a: unknown[]) => api.setMarketingConsent(...a),
  };
});
vi.mock('../lib/notify', () => ({ notify: { success: vi.fn(), apiError: vi.fn() } }));

import { ProfileSettings } from './profile-settings';

const profile = {
  professionalRole: 'tech_lead',
  usageIntent: null,
  primaryGoal: 'enforce_standards',
  profileCompletedAt: '2026-11-01T00:00:00.000Z',
  profileSkippedAt: null,
  marketingEmailConsent: false,
  marketingConsentUpdatedAt: null,
};

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.getGrowthProfile.mockResolvedValue(profile);
  api.updateGrowthProfile.mockImplementation(async (input: object) => ({ ...profile, ...input }));
  api.setMarketingConsent.mockImplementation(async (granted: boolean) => ({
    ...profile,
    marketingEmailConsent: granted,
  }));
});
afterEach(() => cleanup());

describe('Settings → About you', () => {
  it('shows saved answers and saves edits (including clearing)', async () => {
    render(<ProfileSettings />);
    const lead = await screen.findByRole('radio', { name: 'Tech Lead' });
    expect(lead.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(lead); // clear
    fireEvent.click(screen.getByRole('radio', { name: 'Working with a team' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(api.updateGrowthProfile).toHaveBeenCalledWith({
      professionalRole: null,
      usageIntent: 'team',
      primaryGoal: 'enforce_standards',
    });
  });

  it('marketing emails: off by default here, can be turned on and withdrawn', async () => {
    render(<ProfileSettings />);
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(/Account emails such as password resets are always sent/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(box);
    });
    expect(api.setMarketingConsent).toHaveBeenLastCalledWith(true);
    expect(((await screen.findByRole('checkbox')) as HTMLInputElement).checked).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox'));
    });
    expect(api.setMarketingConsent).toHaveBeenLastCalledWith(false);
  });

  it('a load failure shows an error instead of an empty form', async () => {
    api.getGrowthProfile.mockRejectedValue(new Error('down'));
    render(<ProfileSettings />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load your profile/);
  });
});
