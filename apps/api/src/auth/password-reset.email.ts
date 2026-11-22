/** Password reset email (HTML + plain text). All dynamic values are escaped. */

export const PASSWORD_RESET_TTL_MINUTES = 30;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildPasswordResetEmail(input: {
  appName: string;
  resetUrl: string;
  name: string | null;
}): { subject: string; html: string; text: string } {
  // Never echo the account name: it is free text chosen by whoever registered, and this mail
  // can reach an address that registrant does not own (phishing text from our domain).
  // `input.name` is accepted for compatibility and intentionally unused.
  void input.name;
  const greeting = 'Hi,';
  const subject = `Reset your ${input.appName} password`;
  const text = [
    greeting,
    '',
    `We received a request to reset the password for your ${input.appName} account.`,
    `Use this link within ${PASSWORD_RESET_TTL_MINUTES} minutes:`,
    '',
    input.resetUrl,
    '',
    'The link works once. If you did not ask for this, you can ignore this email — your',
    'password will not change.',
    '',
    `— ${input.appName}`,
  ].join('\n');

  const url = escapeHtml(input.resetUrl);
  const app = escapeHtml(input.appName);
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;">
      <tr>
        <td style="padding:28px;">
          <p style="margin:0 0 16px;font-size:15px;">${escapeHtml(greeting)}</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">We received a request to reset the password for your ${app} account. This link works once and expires in ${PASSWORD_RESET_TTL_MINUTES} minutes.</p>
          <p style="margin:24px 0;">
            <a href="${url}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px;">Reset password</a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">If the button does not work, copy this link into your browser:</p>
          <p style="margin:0 0 24px;font-size:13px;word-break:break-all;"><a href="${url}" style="color:#2563eb;">${url}</a></p>
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5;">If you did not ask for this, you can ignore this email — your password will not change.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  return { subject, html, text };
}
