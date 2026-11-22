/**
 * Adversarial review N2: the account name is free text chosen by whoever registered, and
 * verification / reset mail can reach an address that registrant does not own. It must never
 * appear in either email.
 * Adversarial review N1: CI analysis passes EMAIL_VERIFICATION_REQUIRED through unchanged.
 */
import { describe, expect, it } from 'vitest';

import { isEntitlementRefusal } from '../github/github-ci.service';
import { workspaceException } from '../workspaces/workspace.errors';
import { buildEmailVerificationEmail } from './email-verification.email';
import { buildPasswordResetEmail } from './password-reset.email';

const PHISH = 'Your account is locked, visit evil.example now';

describe('transactional emails never echo the account name (N2)', () => {
  it('verification email', () => {
    const mail = buildEmailVerificationEmail({
      appName: 'Project X',
      verifyUrl: 'https://app.projectx-fixture.dev/verify-email#token=abc',
      name: PHISH,
    });
    for (const part of [mail.subject, mail.text, mail.html]) expect(part).not.toContain('locked');
    expect(mail.text.startsWith('Hi,')).toBe(true);
  });

  it('password reset email', () => {
    const mail = buildPasswordResetEmail({
      appName: 'Project X',
      resetUrl: 'https://app.projectx-fixture.dev/reset-password#token=abc',
      name: PHISH,
    } as never);
    for (const part of [mail.subject, mail.text, mail.html]) expect(part).not.toContain('locked');
  });
});

describe('CI analysis pass-through (N1)', () => {
  it('EMAIL_VERIFICATION_REQUIRED reaches the client unchanged', () => {
    expect(
      isEntitlementRefusal(
        workspaceException('EMAIL_VERIFICATION_REQUIRED', 'Confirm your email.'),
      ),
    ).toBe(true);
  });
});
