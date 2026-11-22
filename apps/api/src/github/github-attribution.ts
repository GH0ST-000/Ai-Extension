/**
 * Decision C — attribution of writes posted with the workspace GitHub App identity. GitHub
 * shows them as the App bot, so each body states who requested it:
 *
 *   <sub>Requested by @login via Project X · everything below was written by @login</sub>
 *
 *   …the author's text…
 *
 * F-19 — the design does not depend on recognizing forgeries. Project X writes exactly ONE
 * line, the first, and that line itself says that everything after it is the requester's own
 * text. A second "Requested by @someone-else" further down is therefore, by the comment's own
 * first line, something @login typed — however it is worded, encoded or styled. No rewording
 * can move text above the header, and nothing after the header can hide or swallow it.
 * The look-alike quoting below is kept as a second, best-effort layer (it makes the common
 * forgeries visibly quoted); it is NOT what the attribution's integrity rests on.
 *
 * - The login is the user's CURRENT verified GitHub login (GitHub's /user answer for their own
 *   token at write time), never a client-supplied value.
 * - The attribution is a HEADER: nothing the author writes after it (an unclosed `<!--`,
 *   `<details>`, …) can hide or swallow it.
 * - Best effort: look-alike attributions in the author's text are quoted and marked, detected on normalized
 *   text (entities decoded, NFKC, invisible characters / tags / Markdown emphasis removed,
 *   homoglyphs folded, up to 4 consecutive lines joined) so split, encoded or obfuscated
 *   copies cannot pose as the real one. The real header always comes first regardless.
 * - It never claims the bot comment was authored by the user. Deterministic (idempotent).
 */
export const ATTRIBUTION_SUFFIX = 'via Project X';

/** GitHub login rules: alphanumeric or single hyphens, ≤ 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/**
 * Phrases that read like an attribution of the post to a GitHub user. Applied to normalized
 * text; up to a few punctuation characters may sit between the phrase and the `@`
 * (`Requested by: @x`, `Requested by — @x`).
 */
const LOOKALIKE =
  /(?:requested\s*by|on\s*behalf\s*of|posted\s*by|submitted\s*by|authored\s*by|approved\s*by)[^a-z0-9@\n]{0,6}@/i;

export function isValidGithubLogin(login: string | null | undefined): login is string {
  return typeof login === 'string' && GITHUB_LOGIN.test(login);
}

/**
 * The one line Project X writes. It names the requester and scopes the trust: the rest of the
 * post is the requester's text, not Project X's and not anyone else's.
 */
export function attributionHeader(login: string): string {
  return `<sub>Requested by @${login} ${ATTRIBUTION_SUFFIX} · everything below was written by @${login}</sub>`;
}

/** Latin look-alikes (Cyrillic / Greek) of the letters in "requested by" (review N4). */
const HOMOGLYPHS: Record<string, string> = {
  а: 'a',
  е: 'e',
  ё: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  ѕ: 's',
  ԛ: 'q',
  ԁ: 'd',
  ь: 'b',
  в: 'b',
  т: 't',
  к: 'k',
  и: 'u',
  ц: 'u',
  г: 'r',
  ү: 'y',
  ο: 'o',
  ε: 'e',
  υ: 'u',
  ρ: 'p',
  τ: 't',
  β: 'b',
  γ: 'y',
  ν: 'v',
  κ: 'k',
};

const NAMED_ENTITIES: Record<string, string> = {
  commat: '@',
  nbsp: ' ',
  tab: ' ',
  newline: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  hairsp: ' ',
  colon: ':',
  period: '.',
  hyphen: '-',
  dash: '-',
  ndash: '-',
  mdash: '-',
  shy: '',
  zerowidthspace: '',
  zwj: '',
  zwnj: '',
  lrm: '',
  rlm: '',
  amp: '&',
  ast: '*',
  lowbar: '_',
  lsqb: '[',
  rsqb: ']',
  bsol: '\\',
};

/**
 * Text as a reader would see it once GitHub renders it: entities decoded, compatibility forms
 * folded (NFKC: full-width ＠ → @), invisible characters and HTML tags dropped (not replaced
 * by a space: `Req<b></b>uested` renders as one word), Markdown emphasis / escapes / link
 * brackets removed, and common Cyrillic / Greek homoglyphs mapped to Latin.
 */
/**
 * Remove HTML comments as a renderer drops them, by scanning (no regular expression): each
 * `<!--` up to the next `-->` or `--!>` is cut out; an unclosed comment hides everything
 * after it, so the rest of the text is dropped.
 */
function stripComments(text: string): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const start = text.indexOf('<!--', cursor);
    if (start < 0) return out + text.slice(cursor);
    out += text.slice(cursor, start);
    const plain = text.indexOf('-->', start + 4);
    const bang = text.indexOf('--!>', start + 4);
    if (plain < 0 && bang < 0) return out;
    const useBang = bang >= 0 && (plain < 0 || bang < plain);
    cursor = useBang ? bang + 4 : plain + 3;
  }
}

/**
 * Text with comments and tags removed, as a reader would see it. Comment removal repeats
 * until nothing changes (cutting one comment can join the text around it into another), tags
 * are dropped, and any angle bracket still left is removed — so the result contains no `<` or
 * `>` at all and therefore no markup that could hide or split a phrase.
 */
function stripMarkup(text: string): string {
  let out = text;
  for (let previous = ''; previous !== out;) {
    previous = out;
    out = stripComments(out);
  }
  // A comment terminator left without an opener renders as text; for DETECTION it is dropped
  // too (more look-alikes are caught, never fewer).
  out = out.split('--!>').join('').split('-->').join('');
  return out.replace(/<[^>]{0,200}>/g, '').replace(/[<>]/g, '');
}

function normalizeForDetection(text: string): string {
  const decoded = text
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_m, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});?/g, (_m, dec: string) => safeChar(Number(dec)))
    .replace(/&([a-z]{2,20});/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD\u180E]/g, '')
    .replace(/\u034F/g, ''); // combining grapheme joiner (own pattern: lint misleading-class)
  return stripMarkup(decoded)
    .replace(/[*_~`\\[\]]/g, '')
    .toLowerCase()
    .replace(/[\u0080-\uFFFF]/g, (ch) => HOMOGLYPHS[ch] ?? ch);
}

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/** Lines that can render as one paragraph and so form a look-alike when split. */
const JOIN_WINDOW = 4;

/**
 * Quotes (and marks) every line that, alone or joined with up to {@link JOIN_WINDOW} - 1
 * following lines, reads like an attribution once normalized.
 */
export function neutralizeAttributionLookalikes(body: string): string {
  const lines = body.split('\n');
  const flagged = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    if (LOOKALIKE.test(normalizeForDetection(lines[i]!))) {
      flagged.add(i);
      continue;
    }
    for (let size = 2; size <= JOIN_WINDOW && i + size <= lines.length; size += 1) {
      const window = lines.slice(i, i + size);
      if (LOOKALIKE.test(normalizeForDetection(window.join(' ')))) {
        for (let k = i; k < i + size; k += 1) flagged.add(k);
        break;
      }
    }
  }
  return lines
    .map((line, i) => (flagged.has(i) ? `> (quoted) ${line.replace(/^>\s?/, '')}` : line))
    .join('\n');
}

export function attributeAppPost(body: string, login: string): string {
  if (!isValidGithubLogin(login)) throw new Error('invalid GitHub login for attribution');
  const content = neutralizeAttributionLookalikes(body.trimEnd());
  return content ? `${attributionHeader(login)}\n\n${content}` : attributionHeader(login);
}

/** Commit-message trailer for App-made commits (git trailer convention). */
export function attributeAppCommitMessage(message: string, login: string): string {
  if (!isValidGithubLogin(login)) throw new Error('invalid GitHub login for attribution');
  const content = message
    .trimEnd()
    .split('\n')
    // No author-supplied trailer (any spacing / separator variant of the key).
    .filter((line) => !/^requested[\s_-]*by\s*:/i.test(line.trim()))
    .join('\n')
    .trimEnd();
  return `${content}\n\nRequested-by: @${login} ${ATTRIBUTION_SUFFIX}`;
}
