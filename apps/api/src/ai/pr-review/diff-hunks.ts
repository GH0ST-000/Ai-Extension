/**
 * Unified-diff helpers for PR review: parse GitHub `patch` text into line maps, split
 * oversized patches into bounded chunks without dropping lines silently, and locate
 * model-cited evidence inside the exact text a batch reviewed.
 */

export type DiffLineKind = '+' | '-' | ' ';

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  /** Line number in the base file (null for added lines or unknown). */
  oldLine: number | null;
  /** Line number in the head file (null for removed lines or unknown). */
  newLine: number | null;
};

export type DiffHunk = { header: string; lines: DiffLine[] };

export type PatchChunk = {
  /** Text sent to the model (hunk headers + prefixed lines). */
  text: string;
  /** Lines contained in this chunk, with their real line numbers. */
  lines: DiffLine[];
  /** True when a single line was longer than the chunk budget and had to be cut. */
  lineCut: boolean;
};

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a GitHub patch. Text without hunk headers (page-scraped excerpts) becomes one hunk
 * with unknown line numbers, so evidence can still be checked but lines cannot.
 */
export function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let numbered = false;

  for (const raw of patch.split('\n')) {
    const header = HUNK_HEADER_RE.exec(raw);
    if (header) {
      current = { header: raw, lines: [] };
      hunks.push(current);
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      numbered = true;
      continue;
    }
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    if (!current) {
      current = { header: '', lines: [] };
      hunks.push(current);
    }
    const first = raw[0];
    const kind: DiffLineKind = first === '+' || first === '-' ? first : ' ';
    const text = first === '+' || first === '-' || first === ' ' ? raw.slice(1) : raw;
    if (!numbered) {
      current.lines.push({ kind, text, oldLine: null, newLine: null });
      continue;
    }
    if (kind === '+') {
      current.lines.push({ kind, text, oldLine: null, newLine });
      newLine += 1;
    } else if (kind === '-') {
      current.lines.push({ kind, text, oldLine, newLine: null });
      oldLine += 1;
    } else {
      current.lines.push({ kind, text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return hunks.filter((h) => h.lines.length > 0);
}

function renderLine(line: DiffLine): string {
  return `${line.kind}${line.text}`;
}

function continuationHeader(first: DiffLine): string {
  const oldStart = first.oldLine ?? '?';
  const newStart = first.newLine ?? '?';
  return `@@ -${oldStart} +${newStart} @@ (hunk continued)`;
}

/**
 * Split a patch into chunks of at most `maxChars` characters. Hunks are kept whole when they
 * fit; larger hunks are split at line boundaries with a continuation header carrying the real
 * line numbers. Every line ends up in exactly one chunk. Only a single line longer than the
 * whole budget is cut, and that chunk is flagged with `lineCut`.
 */
export function chunkPatch(patch: string, maxChars: number): PatchChunk[] {
  const budget = Math.max(200, Math.floor(maxChars));
  const chunks: PatchChunk[] = [];
  let text = '';
  let lines: DiffLine[] = [];

  const flush = () => {
    if (lines.length > 0) chunks.push({ text, lines, lineCut: false });
    text = '';
    lines = [];
  };
  const append = (piece: string, pieceLines: DiffLine[]) => {
    text = text ? `${text}\n${piece}` : piece;
    lines.push(...pieceLines);
  };

  for (const hunk of parsePatch(patch)) {
    const rendered = [hunk.header, ...hunk.lines.map(renderLine)].filter(Boolean).join('\n');
    if (rendered.length <= budget) {
      if (text && text.length + 1 + rendered.length > budget) flush();
      append(rendered, hunk.lines);
      continue;
    }

    // Oversized hunk: split by lines, each piece with a continuation header.
    flush();
    let pieceLines: DiffLine[] = [];
    let pieceText = '';
    const flushPiece = () => {
      if (pieceLines.length > 0)
        chunks.push({ text: pieceText, lines: pieceLines, lineCut: false });
      pieceLines = [];
      pieceText = '';
    };
    for (const line of hunk.lines) {
      const rendered = renderLine(line);
      const head = continuationHeader(line);
      if (head.length + 1 + rendered.length > budget) {
        // A single line larger than the budget (minified code): cut it, flag it.
        flushPiece();
        const room = Math.max(1, budget - head.length - 20);
        chunks.push({
          text: `${head}\n${rendered.slice(0, room)} … [line cut]`,
          lines: [line],
          lineCut: true,
        });
        continue;
      }
      if (pieceLines.length === 0) {
        pieceText = `${head}\n${rendered}`;
        pieceLines = [line];
      } else if (pieceText.length + 1 + rendered.length > budget) {
        flushPiece();
        pieceText = `${head}\n${rendered}`;
        pieceLines = [line];
      } else {
        pieceText = `${pieceText}\n${rendered}`;
        pieceLines.push(line);
      }
    }
    flushPiece();
  }
  flush();
  return chunks;
}

function normalizeCode(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Comparison form: whitespace never decides whether code matches (`{where:{}}` = `{ where: {} }`). */
function compactCode(value: string): string {
  return value.replace(/\s+/g, '');
}

/** Evidence line variants (compact): as written, and without a leading diff marker. */
function evidenceVariants(line: string): string[] {
  const trimmed = line.trim();
  const variants = [compactCode(trimmed)];
  if (/^[+-]/.test(trimmed)) variants.push(compactCode(trimmed.slice(1)));
  return variants.filter((v) => v.length >= 3);
}

/** Markdown fences and elision markers (`...`, `…`, `// ...`) are formatting, not code. */
const FORMATTING_LINE_RE = /^\s*(?:```[\w-]*|~~~[\w-]*|(?:\/\/\s*)?(?:\.\.\.|…)\s*)$/;

type WantedLine = { variants: string[]; quoted: string; side: '+' | '-' | null };

function wantedLines(evidence: string): WantedLine[] {
  return evidence
    .replace(/\r/g, '')
    .split('\n')
    .filter((raw) => !FORMATTING_LINE_RE.test(raw))
    .map((raw) => {
      const t = raw.trim();
      return {
        variants: evidenceVariants(raw),
        quoted: normalizeCode(t.replace(/^[+-]/, '')),
        side: t.startsWith('+') ? ('+' as const) : t.startsWith('-') ? ('-' as const) : null,
      };
    })
    .filter((w) => w.variants.length > 0)
    .slice(0, MAX_EVIDENCE_LINES_CHECKED);
}

/**
 * Indices matching every wanted line in order from `start` (wanted[0] at `start`), or null.
 * Later lines keep to the anchor's side of the diff (a moved line has a deleted and an added
 * copy; an added anchor continues on added/context lines) unless the evidence marks the side
 * itself, and a long line wrapped over two evidence lines may match one diff line.
 */
function completeMatch(
  wanted: WantedLine[],
  lines: DiffLine[],
  haystack: string[],
  start: number,
  /** For a context anchor: which side later lines prefer (head copy, or deleted copy). */
  contextSide: '+' | '-' = '+',
): number[] | null {
  const anchor = lines[start]!.kind;
  const sideOk = (w: WantedLine, kind: DiffLine['kind']) => {
    if (w.side === '+') return kind !== '-';
    if (w.side === '-') return kind !== '+';
    if (anchor === '+') return kind !== '-';
    if (anchor === '-') return kind !== '+';
    return contextSide === '+' ? kind !== '-' : kind !== '+';
  };
  const matched = [start];
  for (let k = 1, cursor = start + 1; k < wanted.length; k += 1) {
    const prev = matched[matched.length - 1]!;
    // Wrapped line: this evidence line continues the previous one on the same diff line.
    const joined = wanted[k - 1]!.variants.some((a) =>
      wanted[k]!.variants.some((b) => haystack[prev]!.includes(a + b)),
    );
    if (joined) {
      matched.push(prev);
      continue;
    }
    const hit = (i: number) => wanted[k]!.variants.some((v) => haystack[i]!.includes(v));
    let found = -1;
    for (let i = cursor; i < haystack.length; i += 1) {
      if (hit(i) && sideOk(wanted[k]!, lines[i]!.kind)) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      for (let i = cursor; i < haystack.length; i += 1) {
        if (hit(i)) {
          found = i;
          break;
        }
      }
    }
    if (found === -1) return null;
    matched.push(found);
    cursor = found + 1;
  }
  return matched;
}

export type EvidenceLocation = {
  /** Line range in the file (null when the chunk has no line numbers, e.g. page excerpts). */
  start: number | null;
  end: number | null;
};

/** Every stored evidence line is checked (the batch validator keeps at most 12). */
export const MAX_EVIDENCE_LINES_CHECKED = 12;

/**
 * Find model-cited evidence in the reviewed lines. Every non-trivial evidence line (up to
 * {@link MAX_EVIDENCE_LINES_CHECKED}) must appear, in order, in the diff lines. Returns the
 * matched diff lines, or null when the evidence is not present.
 */
export type EvidenceMatch = {
  /** The evidence line as quoted (diff marker removed, whitespace normalized). */
  quoted: string;
  line: DiffLine;
};

export function matchEvidenceLines(lines: DiffLine[], evidence: string): EvidenceMatch[] | null {
  return matchEvidenceAll(lines, evidence, 1)[0] ?? null;
}

/**
 * Every complete, in-order match of the evidence (one per distinct anchor of its first line),
 * so callers can choose between copies — e.g. a re-indented or moved line present both as a
 * deleted and an added line. At most `limit` matches, in diff order.
 */
/** A collapsed quote may stand for at most this many source lines. */
const MAX_COLLAPSED_LINES = 8;

/**
 * Runs of source-contiguous diff lines on one side: head lines (context/added, consecutive
 * new-file numbers; interleaved deleted lines do not break them) and deleted lines
 * (consecutive old-file numbers). A run never mixes sides or skips a line number.
 */
function contiguousRuns(lines: DiffLine[]): { side: '+' | '-'; lines: DiffLine[] }[] {
  const runs: { side: '+' | '-'; lines: DiffLine[] }[] = [];
  let head: DiffLine[] = [];
  let del: DiffLine[] = [];
  const flush = (side: '+' | '-', run: DiffLine[]) => {
    if (run.length > 1) runs.push({ side, lines: run });
  };
  for (const line of lines) {
    if (line.kind === '-') {
      const prev = del[del.length - 1];
      if (
        prev &&
        line.oldLine != null &&
        prev.oldLine != null &&
        line.oldLine === prev.oldLine + 1
      ) {
        del.push(line);
      } else {
        flush('-', del);
        del = [line];
      }
    } else {
      const prev = head[head.length - 1];
      if (
        prev &&
        line.newLine != null &&
        prev.newLine != null &&
        line.newLine === prev.newLine + 1
      ) {
        head.push(line);
      } else {
        flush('+', head);
        head = [line];
      }
    }
  }
  flush('-', del);
  flush('+', head);
  return runs;
}

/**
 * A model sometimes collapses several consecutive source lines onto one evidence line
 * (`if (!actor) { throw new Error('FORBIDDEN'); }`), sometimes keeping each line's diff marker
 * (`-  const m = find({ -    where: … },`). Such a line stands for those lines only when it
 * equals, ignoring whitespace, the WHOLE lines of one contiguous run on one side of the diff —
 * plain, or with each line's own marker at every line boundary. Fragments, reordered or non-adjacent lines, and deleted + added lines joined together
 * never match (the evidence stays ungrounded). Lines found as written are kept unchanged.
 */
/** The marker a unified diff shows before a line: `-` deleted, `+` added, none for context. */
function diffMarker(line: DiffLine): string {
  return line.kind === '-' ? '-' : line.kind === '+' ? '+' : '';
}

function expandCollapsed(
  wanted: WantedLine[],
  lines: DiffLine[],
  haystack: string[],
): WantedLine[] {
  const runs = contiguousRuns(lines);
  return wanted
    .flatMap((w) => {
      if (haystack.some((h) => w.variants.some((v) => h.includes(v)))) return [w];
      for (const run of runs) {
        if (w.side === '+' && run.side === '-') continue;
        if (w.side === '-' && run.side === '+') continue;
        for (let i = 0; i < run.lines.length; i += 1) {
          // Three renderings of the same window: plain lines joined; every line with its own
          // diff marker (`-  a({ -    b },`); and markers on every line but the first (the
          // first marker is optional in a quote). A marker counts only at a line boundary and
          // only if it is the marker of the line it introduces.
          let joined = '';
          let marked = '';
          let markedAfterFirst = '';
          for (let j = i; j < Math.min(run.lines.length, i + MAX_COLLAPSED_LINES); j += 1) {
            const line = run.lines[j]!;
            const text = compactCode(line.text);
            const marker = diffMarker(line);
            joined += text;
            marked += marker + text;
            markedAfterFirst += (j === i ? '' : marker) + text;
            const forms = [joined, marked, markedAfterFirst];
            if (j > i && w.variants.some((v) => forms.includes(v))) {
              return run.lines.slice(i, j + 1).map((l) => ({
                variants: [compactCode(l.text)].filter((v) => v.length >= 3),
                quoted: normalizeCode(l.text),
                side: run.side === '-' ? ('-' as const) : null,
              }));
            }
            if (!w.variants.some((v) => forms.some((f) => v.startsWith(f)))) break;
          }
        }
      }
      return [w];
    })
    .filter((w) => w.variants.length > 0);
}

export function matchEvidenceAll(
  lines: DiffLine[],
  evidence: string,
  limit = 8,
): EvidenceMatch[][] {
  const haystack = lines.map((line) => compactCode(line.text));
  const wanted = expandCollapsed(wantedLines(evidence), lines, haystack).slice(
    0,
    MAX_EVIDENCE_LINES_CHECKED,
  );
  if (wanted.length === 0) return [];
  const out: EvidenceMatch[][] = [];
  for (let start = 0; start < haystack.length && out.length < limit; start += 1) {
    if (!wanted[0]!.variants.some((v) => haystack[start]!.includes(v))) continue;
    if (wanted[0]!.side === '+' && lines[start]!.kind === '-') continue;
    if (wanted[0]!.side === '-' && lines[start]!.kind === '+') continue;
    // A context anchor can continue on the head copy or on the deleted copy of a moved line:
    // offer both so the change classification can choose (selectEvidenceMatch).
    const sides: ('+' | '-')[] = lines[start]!.kind === ' ' ? ['+', '-'] : ['+'];
    const seen = new Set<string>();
    for (const side of sides) {
      const matched = completeMatch(wanted, lines, haystack, start, side);
      if (!matched || seen.has(matched.join(','))) continue;
      seen.add(matched.join(','));
      out.push(matched.map((i, k) => ({ quoted: wanted[k]!.quoted, line: lines[i]! })));
    }
  }
  return out;
}

/** Line range of matched evidence (null numbers for unnumbered page excerpts). */
export function evidenceRange(matched: DiffLine[]): EvidenceLocation {
  // One numbering: head (new-file) lines when the evidence has any, else old-file lines of
  // deleted code. Mixing them (old 13 … new 52) describes no real range.
  const head = matched.map((line) => line.newLine).filter((n): n is number => n != null);
  const numbers = head.length
    ? head
    : matched.map((line) => line.oldLine).filter((n): n is number => n != null);
  return numbers.length === 0
    ? { start: null, end: null }
    : { start: Math.min(...numbers), end: Math.max(...numbers) };
}

export function locateEvidence(lines: DiffLine[], evidence: string): EvidenceLocation | null {
  const matched = matchEvidenceLines(lines, evidence);
  return matched ? evidenceRange(matched.map((m) => m.line)) : null;
}

const NON_EVIDENCE_WORDS = new Set([
  'return',
  'const',
  'let',
  'var',
  'if',
  'else',
  'true',
  'false',
  'null',
  'undefined',
  'await',
  'async',
  'function',
  'export',
  'import',
  'from',
  'new',
  'this',
  'void',
  'type',
  'interface',
  'class',
  'extends',
  'implements',
  'public',
  'private',
  'protected',
  'static',
  'readonly',
  'try',
  'catch',
  'finally',
  'throw',
  'for',
  'while',
  'case',
  'break',
  'continue',
  'default',
  'switch',
  'yield',
  'typeof',
  'instanceof',
  'of',
  'as',
  'do',
  'any',
  'string',
  'number',
  'boolean',
  'unknown',
  'never',
  'object',
]);

/**
 * Evidence that can actually support a claim: at least 12 non-whitespace characters and one
 * identifier that is not a keyword. Rejects `});`, `return`, `}`, `return null;`, `} else {`.
 */
export function isSubstantiveCode(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  const identifiers = text.match(/[A-Za-z_$][\w$]{2,}/g) ?? [];
  const meaningful = identifiers.some((id) => !NON_EVIDENCE_WORDS.has(id.toLowerCase()));
  if (compact.length >= 12) return meaningful;
  // Short but decisive: a call or decorator of a non-keyword name (`eval(code);`, `@Public()`).
  if (compact.length < 6) return false;
  // A decorator changes behaviour by itself (`@Public()`, `@SkipAuth()`), whatever its name.
  if (/^@[A-Za-z_$][\w$]{2,}\s*\([^()]*\)/.test(text.trim())) return true;
  // A complete call (`name(…)`), not a fragment such as `= compute(`.
  const callee = /(?:^@|(?<![\w$.]))([A-Za-z_$][\w$]{2,})\s*\([^()]*\)/.exec(text)?.[1];
  return callee != null && !NON_EVIDENCE_WORDS.has(callee.toLowerCase()) && meaningful;
}

/** True when any reviewed line (new side, or old side for removed lines) is in [start, end]. */
export function rangeTouchesLines(lines: DiffLine[], start: number, end: number): boolean {
  return lines.some((line) => {
    const n = line.kind === '-' ? line.oldLine : line.newLine;
    return n != null && n >= start && n <= end;
  });
}
