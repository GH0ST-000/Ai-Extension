/**
 * Escape every regular-expression metacharacter (including the backslash) so `value` matches
 * literally inside `new RegExp(...)`. Use this instead of escaping individual characters.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
