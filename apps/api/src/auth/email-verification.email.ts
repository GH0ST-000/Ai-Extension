import { escapeHtml } from './password-reset.email';

/** Email verification email (HTML + plain text). All dynamic values are escaped. */
export const EMAIL_VERIFICATION_TTL_HOURS = 24;

export function buildEmailVerificationEmail(input: {
  appName: string;
  verifyUrl: string;
  name: string | null;
}): { subject: string; html: string; text: string } {
  // Never echo the account name: it is free text chosen by whoever registered, and this mail
  // can reach an address that registrant does not own (phishing text from our domain).
  // `input.name` is accepted for compatibility and intentionally unused.
  void input.name;
  const greeting = 'Hi,';
  const subject = `Confirm your ${input.appName} email address`;
  const text = [
    greeting,
    '',
    `Confirm that this is your email address for ${input.appName}.`,
    `The link works once and expires in ${EMAIL_VERIFICATION_TTL_HOURS} hours. You will be asked to sign in to your ${input.appName} account to finish:`,
    '',
    input.verifyUrl,
    '',
    'If you did not create an account, ignore this email: do not open the link. Nothing is confirmed unless you sign in.',
    '',
    `— ${input.appName}`,
  ].join('\n');
  const url = escapeHtml(input.verifyUrl);
  const app = escapeHtml(input.appName);
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;">
      <tr>
        <td style="padding:28px;">
          <p style="margin:0 0 16px;font-size:15px;">${escapeHtml(greeting)}</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Confirm that this is your email address for ${app}. The link works once and expires in ${EMAIL_VERIFICATION_TTL_HOURS} hours. You will be asked to sign in to your ${app} account to finish.</p>
          <p style="margin:24px 0;">
            <a href="${url}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px;">Confirm email</a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">If the button does not work, copy this link into your browser:</p>
          <p style="margin:0 0 24px;font-size:13px;word-break:break-all;"><a href="${url}" style="color:#2563eb;">${url}</a></p>
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5;">If you did not create an account, ignore this email: do not open the link. Nothing is confirmed unless you sign in.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  return { subject, html, text };
}
