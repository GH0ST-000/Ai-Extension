'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import type { PrimaryGoal, ProfessionalRole, UsageIntent } from '@project-x/types';
import { safeInternalPath } from '@project-x/shared';

import { ProfileQuestion } from '../../../components/profile-question';
import {
  PRIMARY_GOAL_LABELS,
  PROFESSIONAL_ROLE_LABELS,
  USAGE_INTENT_LABELS,
  getGrowthProfile,
  skipGrowthProfile,
  updateGrowthProfile,
} from '../../../lib/growth-profile';
import { notify } from '../../../lib/notify';

/**
 * Optional "three quick questions" after registration. Never blocks: Continue and Skip both go
 * on to the intended destination, even if saving fails. Users who already answered or skipped
 * are sent straight on.
 */
function WelcomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeInternalPath(searchParams?.get('next') ?? null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<ProfessionalRole | null>(null);
  const [intent, setIntent] = useState<UsageIntent | null>(null);
  const [goal, setGoal] = useState<PrimaryGoal | null>(null);

  useEffect(() => {
    let cancelled = false;
    getGrowthProfile()
      .then((profile) => {
        if (cancelled) return;
        if (profile.profileCompletedAt || profile.profileSkippedAt) {
          router.replace(next);
          return;
        }
        setReady(true);
      })
      .catch(() => {
        // Never trap the user here.
        if (!cancelled) router.replace(next);
      });
    return () => {
      cancelled = true;
    };
  }, [next, router]);

  async function finish(action: 'continue' | 'skip') {
    setBusy(true);
    const answered = role !== null || intent !== null || goal !== null;
    try {
      if (action === 'continue' && answered) {
        await updateGrowthProfile({
          ...(role ? { professionalRole: role } : {}),
          ...(intent ? { usageIntent: intent } : {}),
          ...(goal ? { primaryGoal: goal } : {}),
        });
      } else {
        await skipGrowthProfile();
      }
    } catch {
      notify.warning('Your answers were not saved', 'You can add them later in Settings.');
    } finally {
      router.replace(next);
    }
  }

  if (!ready) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading…
      </p>
    );
  }

  return (
    <section
      aria-labelledby="welcome-heading"
      className="rise-in mx-auto max-w-2xl rounded-3xl border border-line bg-panel/75 p-6 shadow-panel md:p-8"
    >
      <h1
        id="welcome-heading"
        className="font-display text-2xl font-semibold tracking-tight text-ink"
      >
        Make Project X work better for you
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Three quick questions to help us understand how you plan to use Project X. All optional.
      </p>
      <div className="mt-6 space-y-5">
        <ProfileQuestion
          id="welcome-role"
          label="Your role"
          options={PROFESSIONAL_ROLE_LABELS}
          value={role}
          onChange={setRole}
        />
        <ProfileQuestion
          id="welcome-intent"
          label="How will you use Project X?"
          options={USAGE_INTENT_LABELS}
          value={intent}
          onChange={setIntent}
        />
        <ProfileQuestion
          id="welcome-goal"
          label="Your main goal"
          options={PRIMARY_GOAL_LABELS}
          value={goal}
          onChange={setGoal}
        />
      </div>
      <div className="mt-7 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void finish('continue')}
          className="rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:opacity-60"
        >
          Continue
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void finish('skip')}
          className="rounded-xl border border-line px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-mist disabled:opacity-60"
        >
          Skip for now
        </button>
        <p className="text-xs text-muted-foreground">You can change these anytime in Settings.</p>
      </div>
    </section>
  );
}

export default function WelcomePage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
      <WelcomeContent />
    </Suspense>
  );
}
