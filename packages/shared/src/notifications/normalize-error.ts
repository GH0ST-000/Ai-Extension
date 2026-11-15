import { containsSensitiveMemoryContent } from '../project-memory/secrets';

/** Broad error categories a UI can react to (retry button, sign-in link, …). */
export type NotificationErrorCategory =
  | 'network'
  | 'aborted'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'rate_limited'
  | 'server'
  | 'unknown';

export interface NormalizedError {
  category: NotificationErrorCategory;
  /** Safe to show to the user. Never a stack trace, SQL, provider payload or credential. */
  message: string;
  /** HTTP status when known. */
  status?: number;
  /** Machine-readable API error code when known (e.g. PROJECT_MEMORY_CONFLICT). */
  code?: string;
}

const GENERIC: Record<NotificationErrorCategory, string> = {
  network: "Can't reach Project X. Check your connection and try again.",
  aborted: 'The request was cancelled.',
  unauthorized: 'Your session has expired. Sign in again to continue.',
  forbidden: "You don't have permission to do that.",
  not_found: 'That item no longer exists.',
  conflict: 'This was changed by someone else. Reload and try again.',
  validation: 'Check the input and try again.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  server: 'Something went wrong on our side. Try again in a moment.',
  unknown: 'Something went wrong. Try again.',
};

const MAX_MESSAGE_CHARS = 240;

/** Text that must never reach a notification (internals, payloads, credentials). */
const UNSAFE_MESSAGE_PATTERNS: readonly RegExp[] = [
  /\n\s*at\s/, // stack frame
  /\bat\s+\S+\s+\(?[^)\s]*:\d+:\d+\)?/, // "at fn (file:1:2)"
  /(?:^|[\s(])\/(?:Users|home|var|usr|app|opt|srv)\//i, // server file paths
  /node_modules|webpack|\.tsx?:\d+/i,
  /\b(?:prisma|postgres(?:ql)?|sqlstate|econnrefused|enotfound|etimedout|redis)\b/i,
  /\b(?:select|insert|update|delete)\b[\s\S]{0,80}\b(?:from|into|set|where)\b/i, // SQL
  /<\s*(?:html|body|head|!doctype)/i,
  /^\s*[[{]/, // raw JSON payload
  /\b(?:internal server error|unexpected token|cannot read propert|undefined is not)\b/i,
  /\b(?:bearer|authorization:)\s+\S+/i,
];

/** True when a backend message is short, single-purpose text that is safe to display. */
export function isSafeDisplayMessage(message: unknown): message is string {
  if (typeof message !== 'string') return false;
  const text = message.trim();
  if (!text || text.length > MAX_MESSAGE_CHARS * 2) return false;
  if (UNSAFE_MESSAGE_PATTERNS.some((p) => p.test(text))) return false;
  return !containsSensitiveMemoryContent(text);
}

function clip(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > MAX_MESSAGE_CHARS ? `${single.slice(0, MAX_MESSAGE_CHARS - 1)}…` : single;
}

function categoryForStatus(status: number): NotificationErrorCategory {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status >= 400) return 'validation';
  return 'unknown';
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/**
 * Turn anything thrown (API error objects, fetch failures, aborts, strings) into a category and
 * a message that is safe to show. Server-provided messages are used only for 4xx responses and
 * only when they pass {@link isSafeDisplayMessage}; 5xx details are never shown.
 */
export function normalizeError(error: unknown, fallback?: string): NormalizedError {
  const record =
    error && typeof error === 'object' ? (error as Record<string, unknown>) : ({} as never);
  const name = typeof record.name === 'string' ? record.name : '';
  const rawMessage =
    typeof error === 'string' ? error : typeof record.message === 'string' ? record.message : '';
  const code =
    typeof record.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(record.code)
      ? record.code
      : undefined;

  if (name === 'AbortError') {
    return { category: 'aborted', message: GENERIC.aborted };
  }
  const status = readNumber(record.statusCode) ?? readNumber(record.status);
  if (status === undefined) {
    const offline =
      typeof navigator !== 'undefined' && (navigator as { onLine?: boolean }).onLine === false;
    if (
      offline ||
      (name === 'TypeError' && /fetch|network|load failed/i.test(rawMessage)) ||
      /^(?:failed to fetch|network ?error|load failed)$/i.test(rawMessage.trim())
    ) {
      return { category: 'network', message: GENERIC.network };
    }
    return { category: 'unknown', message: fallback ?? GENERIC.unknown, ...(code ? { code } : {}) };
  }

  const category = categoryForStatus(status);
  const useServerText =
    status >= 400 && status < 500 && status !== 401 && isSafeDisplayMessage(rawMessage);
  return {
    category,
    message: useServerText
      ? clip(rawMessage)
      : category === 'unknown' && fallback
        ? fallback
        : GENERIC[category],
    status,
    ...(code ? { code } : {}),
  };
}

/** Convenience: just the safe message. */
export function safeErrorMessage(error: unknown, fallback?: string): string {
  return normalizeError(error, fallback).message;
}
