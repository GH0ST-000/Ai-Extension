import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ApiConfig } from '../config/configuration';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;

export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Short template name for logs (never the content). */
  template: string;
};

export type MailSendResult =
  | { delivered: true; providerId: string | null }
  | { delivered: false; reason: 'not_configured' | 'provider_rejected' | 'timeout' | 'network' };

/**
 * Transactional email via Resend's HTTPS API (no SDK). Never throws: callers decide what a
 * failure means. Logs carry the template, outcome and HTTP status only — never the recipient,
 * subject, body, links, tokens or the API key. When RESEND_API_KEY / MAIL_FROM are not set the
 * result is `not_configured`; nothing is "delivered" and nothing is written to logs instead.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService<ApiConfig, true>) {}

  isEnabled(): boolean {
    return this.config.get('mail', { infer: true }).enabled;
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    const mail = this.config.get('mail', { infer: true });
    if (!mail.enabled) {
      this.logger.warn({ msg: 'mail.not_configured', template: message.template });
      return { delivered: false, reason: 'not_configured' };
    }
    let response: Response;
    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${mail.resendApiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Project-X',
        },
        body: JSON.stringify({
          from: mail.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (error) {
      const timeout = error instanceof Error && error.name === 'TimeoutError';
      this.logger.error({
        msg: 'mail.failed',
        template: message.template,
        reason: timeout ? 'timeout' : 'network',
      });
      return { delivered: false, reason: timeout ? 'timeout' : 'network' };
    }
    if (!response.ok) {
      // Provider error bodies are not logged or returned (may echo addresses or content).
      this.logger.error({
        msg: 'mail.failed',
        template: message.template,
        reason: 'provider_rejected',
        status: response.status,
      });
      return { delivered: false, reason: 'provider_rejected' };
    }
    let providerId: string | null = null;
    try {
      const body = (await response.json()) as { id?: unknown };
      providerId = typeof body.id === 'string' ? body.id.slice(0, 100) : null;
    } catch {
      providerId = null;
    }
    this.logger.log({ msg: 'mail.sent', template: message.template, providerId });
    return { delivered: true, providerId };
  }
}
