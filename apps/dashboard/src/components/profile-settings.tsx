'use client';

import { useEffect, useState } from 'react';
import type {
  PrimaryGoal,
  ProfessionalRole,
  UsageIntent,
  UserGrowthProfile,
} from '@project-x/types';

import {
  MARKETING_CONSENT_LABEL,
  PRIMARY_GOAL_LABELS,
  PROFESSIONAL_ROLE_LABELS,
  USAGE_INTENT_LABELS,
  getGrowthProfile,
  setMarketingConsent,
  updateGrowthProfile,
} from '../lib/growth-profile';
import { notify } from '../lib/notify';
import { ProfileQuestion } from './profile-question';

/** Settings: edit the optional profile answers and the marketing email preference. */
export function ProfileSettings() {
  const [profile, setProfile] = useState<UserGrowthProfile | null>(null);
  const [role, setRole] = useState<ProfessionalRole | null>(null);
  const [intent, setIntent] = useState<UsageIntent | null>(null);
  const [goal, setGoal] = useState<PrimaryGoal | null>(null);
  const [saving, setSaving] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    getGrowthProfile()
      .then((loaded) => {
        setProfile(loaded);
        setRole(loaded.professionalRole);
        setIntent(loaded.usageIntent);
        setGoal(loaded.primaryGoal);
      })
      .catch(() => setError(true));
  }, []);

  async function saveProfile() {
    setSaving(true);
    try {
      const saved = await updateGrowthProfile({
        professionalRole: role,
        usageIntent: intent,
        primaryGoal: goal,
      });
      setProfile(saved);
      notify.success('Profile saved');
    } catch (err) {
      notify.apiError('Could not save your profile', err);
    } finally {
      setSaving(false);
    }
  }

  async function toggleConsent(granted: boolean) {
    setConsentBusy(true);
    try {
      setProfile(await setMarketingConsent(granted));
      notify.success(granted ? 'Product emails turned on' : 'Product emails turned off');
    } catch (err) {
      notify.apiError('Could not update your email preference', err);
    } finally {
      setConsentBusy(false);
    }
  }

  return (
    <section className="rise-in-delay-1 space-y-3" aria-labelledby="profile-settings-heading">
      <h2
        id="profile-settings-heading"
        className="px-1 font-display text-lg font-semibold tracking-tight"
      >
        About you
      </h2>
      <div className="space-y-5 rounded-3xl border border-line bg-panel/75 p-5 shadow-panel">
        {error ? (
          <p role="alert" className="text-sm text-ink">
            Could not load your profile. Reload to try again.
          </p>
        ) : !profile ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading…
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Optional. Helps us understand how Project X is used — it does not change what you can
              do or see.
            </p>
            <ProfileQuestion
              id="settings-role"
              label="Your role"
              options={PROFESSIONAL_ROLE_LABELS}
              value={role}
              onChange={setRole}
            />
            <ProfileQuestion
              id="settings-intent"
              label="How you use Project X"
              options={USAGE_INTENT_LABELS}
              value={intent}
              onChange={setIntent}
            />
            <ProfileQuestion
              id="settings-goal"
              label="Your main goal"
              options={PRIMARY_GOAL_LABELS}
              value={goal}
              onChange={setGoal}
            />
            <button
              type="button"
              disabled={saving}
              onClick={() => void saveProfile()}
              className="rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>

            <div className="border-t border-line pt-4">
              <label className="flex items-start gap-2.5 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={profile.marketingEmailConsent}
                  disabled={consentBusy}
                  onChange={(event) => void toggleConsent(event.target.checked)}
                  className="mt-1"
                />
                <span>
                  {MARKETING_CONSENT_LABEL}
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Account emails such as password resets are always sent.
                  </span>
                </span>
              </label>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
