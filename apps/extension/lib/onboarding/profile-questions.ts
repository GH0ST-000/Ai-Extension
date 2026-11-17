/**
 * Optional profile questions after extension sign-up. The questions themselves live on the
 * dashboard (/app/welcome); the popup only offers a link, once, right after registration.
 * Signing in (existing users) never shows it.
 */
export type AuthMode = 'login' | 'register';

export function offerProfileQuestionsAfterAuth(mode: AuthMode): boolean {
  return mode === 'register';
}

export const PROFILE_QUESTIONS_PROMPT = {
  title: 'Make Project X work better for you',
  body: 'Three quick, optional questions in Studio. You can also answer later in Settings.',
  cta: 'Answer in Studio',
  dismiss: 'Not now',
} as const;
