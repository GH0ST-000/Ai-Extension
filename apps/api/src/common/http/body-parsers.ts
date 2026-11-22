import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Request body parsing for the whole API (the app is created with `bodyParser: false` and
 * `rawBody: true`).
 *
 * JSON only. Form-encoded bodies are intentionally NOT parsed: no client sends them, and a
 * global `urlencoded` parser let a cross-site HTML form fill authentication DTOs (login CSRF).
 * Webhooks keep the exact raw bytes for signature verification: with `rawBody: true` Nest
 * stores them on `req.rawBody`.
 */
export function applyBodyParsers(app: NestExpressApplication, jsonBodyLimitBytes: number): void {
  app.useBodyParser('json', { limit: jsonBodyLimitBytes });
}
