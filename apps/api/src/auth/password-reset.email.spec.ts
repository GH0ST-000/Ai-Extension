import { describe, expect, it } from 'vitest';

import { buildPasswordResetEmail, escapeHtml } from './password-reset.email';

describe('password reset email', () => {
  it('escapes user-controlled values in HTML and keeps a plain-text alternative', () => {
    const email = buildPasswordResetEmail({
      appName: 'Project X',
      resetUrl: 'https://app.example.test/reset-password#token=abc"><script>',
      name: '<img src=x onerror=alert(1)>',
    });
    expect(email.subject).toBe('Reset your Project X password');
    expect(email.html).not.toContain('<img src=x');
    // Adversarial review N2: the account name is never echoed (escaped or not).
    expect(email.html).not.toContain('onerror');
    expect(email.text).not.toContain('onerror');
    expect(email.html).not.toContain('"><script>');
    expect(email.html).toContain(
      'href="https://app.example.test/reset-password#token=abc&quot;&gt;&lt;script&gt;"',
    );
    expect(email.text).toContain('https://app.example.test/reset-password#token=abc"><script>');
    expect(email.text).toContain('30 minutes');
    expect(email.text).toContain('ignore this email');
  });

  it('works without a name', () => {
    const email = buildPasswordResetEmail({
      appName: 'Project X',
      resetUrl: 'https://a.test/r#token=x',
      name: null,
    });
    expect(email.text.startsWith('Hi,')).toBe(true);
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
