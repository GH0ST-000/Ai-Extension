/**
 * Read-only code context for PR review: the enclosing function/method of changed lines and
 * the definitions of authorization-style helpers they call. Pure text processing over files
 * fetched at the PR head SHA (same workspace-scoped GitHub credentials as the diff); nothing
 * here changes what counts as evidence — context is for understanding only.
 */
import { escapeRegExp } from '@project-x/shared';
import type { DiffLine } from './diff-hunks';

/** Loads a file's full text at the PR head, or null (binary, too large, limit reached, error). */
export type FileContentProvider = (path: string, signal?: AbortSignal) => Promise<string | null>;

const CONTROL = /^(?:if|for|while|switch|catch|return|await|new|throw|else|do|try|typeof|void)\b/;
const SIGNATURE_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\b|class\b|interface\b)|^\s*(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(|^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)|^\s*(?:describe|it|test)\s*\(/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isSignature(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || CONTROL.test(trimmed) || trimmed.startsWith('//') || trimmed.startsWith('*')) {
    return false;
  }
  return SIGNATURE_RE.test(line);
}

export type LineRange = { start: number; end: number };

/**
 * 1-based line range of the function/method/class block enclosing `line`, bounded to
 * `maxLines` around the target. Falls back to a ±window when no brace block is found.
 */
export function enclosingRange(fileLines: string[], line: number, maxLines = 80): LineRange {
  const idx = Math.min(Math.max(line - 1, 0), Math.max(fileLines.length - 1, 0));
  const window = (): LineRange => {
    const half = Math.floor(maxLines / 2);
    return {
      start: Math.max(1, idx + 1 - half),
      end: Math.min(fileLines.length, idx + 1 + half),
    };
  };

  let sig = -1;
  const targetIndent = indentOf(fileLines[idx] ?? '');
  for (let i = idx; i >= 0 && idx - i <= 400; i -= 1) {
    const text = fileLines[i] ?? '';
    if (isSignature(text) && (i === idx || indentOf(text) < targetIndent || indentOf(text) === 0)) {
      sig = i;
      break;
    }
  }
  if (sig === -1) return window();

  const sigIndent = indentOf(fileLines[sig]!);
  let end = -1;
  for (let i = sig + 1; i < fileLines.length && i - sig <= 600; i += 1) {
    const text = fileLines[i]!;
    if (text.trim() && indentOf(text) <= sigIndent && /^\s*[}\])]/.test(text)) {
      end = i;
      break;
    }
  }
  if (end === -1 || end < idx) return window();

  const start = sig + 1;
  const stop = end + 1;
  if (stop - start + 1 <= maxLines) return { start, end: stop };
  // Long block: keep the signature region and a window around the target.
  const half = Math.floor(maxLines / 2);
  return {
    start: Math.max(start, idx + 1 - half),
    end: Math.min(stop, idx + 1 + half),
  };
}

/** Merge overlapping / adjacent ranges. */
export function mergeRanges(ranges: LineRange[], gap = 2): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: LineRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + gap) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export function renderNumbered(fileLines: string[], range: LineRange): string {
  const out: string[] = [];
  for (let n = range.start; n <= range.end; n += 1) {
    out.push(`${n}: ${fileLines[n - 1] ?? ''}`);
  }
  return out.join('\n');
}

/** Names that decide authorization, tenancy or deletion — worth showing their definitions. */
const HELPER_NAME_RE =
  /^(?:authori[sz]e\w*|assert\w*|require\w*|ensure\w*|check\w*(?:Access|Permission|Role|Member|Owner)\w*|can[A-Z]\w*|is(?:Allowed|Authorized|Member|Owner|Admin|Permitted)\w*|verify\w*|guard\w*|\w*Guard|resolveWorkspace\w*|findItemFor\w*|scope\w*|withWorkspace\w*|neutralize\w*|sanitize\w*|validate\w*)$/;

/** Helper calls on changed lines (`foo(`, `this.foo(`, `await bar.foo(`). */
export function helperCallNames(lines: Pick<DiffLine, 'kind' | 'text'>[]): string[] {
  const names = new Set<string>();
  for (const line of lines) {
    if (line.kind === ' ') continue;
    for (const m of line.text.matchAll(/([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/g)) {
      const name = m[1]!;
      if (HELPER_NAME_RE.test(name)) names.add(name);
    }
  }
  return [...names].slice(0, 12);
}

/** 1-based range of `name`'s definition in a file (method, function or arrow const). */
/** A bare `name(` line opens a definition only if its parameters close into a body `{`. */
function opensDefinitionBody(lines: string[], i: number): boolean {
  let acc = '';
  for (let k = i; k < Math.min(lines.length, i + 12); k += 1) {
    acc += ` ${lines[k]!.trim()}`;
    const t = acc.trimEnd();
    if (/\)\s*(?::\s*[^;{}=]+)?\{\s*(?:\}\s*)?$/.test(t)) return true;
    if (/;\s*$/.test(t) || /\)\s*[,)\]]\s*$/.test(t) || /=>\s*/.test(lines[k]!)) return false;
  }
  return false;
}

export function findDefinition(fileLines: string[], name: string, maxLines = 60): LineRange | null {
  const escaped = escapeRegExp(name);
  const def = new RegExp(
    String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|static|readonly|override|async)\s+)*(?:function\s+)?${escaped}\s*(?:<[^>]*>)?\s*\(|^\s*(?:export\s+)?(?:const|let)\s+${escaped}\s*(?::[^=]+)?=`,
  );
  for (let i = 0; i < fileLines.length; i += 1) {
    const text = fileLines[i]!;
    if (/^\s*(?:this\.|await\b|return\b|\.)/.test(text)) continue;
    const declared = /\bfunction\b/.test(text) || /^\s*(?:export\s+)?(?:const|let)\s/.test(text);
    if (
      def.test(text) &&
      !/;\s*$/.test(text.trim()) &&
      (declared || opensDefinitionBody(fileLines, i))
    ) {
      return enclosingRange(fileLines, i + 1, maxLines);
    }
  }
  return null;
}

export type ContextBlock = { path: string; label: string; text: string };

/**
 * Context for a set of changed lines in one file: enclosing blocks of the changed lines, then
 * definitions of authorization-style helpers they call (same file first, then other fetched
 * files). Whole blocks only; stops before exceeding `maxChars`.
 */
export async function buildContextBlocks(input: {
  path: string;
  changedLines: Pick<DiffLine, 'kind' | 'text' | 'newLine' | 'oldLine'>[];
  provider: FileContentProvider;
  /** Other paths whose helpers may be looked up (already-fetched PR files). */
  helperPaths?: string[];
  maxChars: number;
  maxLinesPerBlock?: number;
}): Promise<ContextBlock[]> {
  const blocks: ContextBlock[] = [];
  let used = 0;
  const push = (block: ContextBlock): boolean => {
    const overhead = block.label.length + block.path.length + 32;
    let text = block.text;
    if (used + overhead + text.length > input.maxChars) {
      // Trim an oversized block by whole lines instead of discarding it (large files).
      const room = input.maxChars - used - overhead - 40;
      if (room < 200) return false;
      const kept: string[] = [];
      let size = 0;
      for (const line of text.split('\n')) {
        if (size + line.length + 1 > room) break;
        kept.push(line);
        size += line.length + 1;
      }
      text = `${kept.join('\n')}\n… [block trimmed for budget]`;
    }
    blocks.push({ ...block, text });
    used += overhead + text.length;
    return true;
  };

  const text = await input.provider(input.path);
  if (text == null) return blocks;
  const fileLines = text.split('\n');
  const targets = input.changedLines
    .filter((l) => l.kind === '+' && l.newLine != null)
    .map((l) => l.newLine!);
  const ranges = mergeRanges(
    targets.map((n) => enclosingRange(fileLines, n, input.maxLinesPerBlock ?? 80)),
  );
  for (const range of ranges) {
    push({
      path: input.path,
      label: `lines ${range.start}-${range.end} (enclosing code at PR head)`,
      text: renderNumbered(fileLines, range),
    });
  }

  const covered = (path: string, r: LineRange) =>
    blocks.some(
      (b) => b.path === path && b.label.startsWith(`lines ${r.start}-`) && b.text.length > 0,
    );
  for (const name of helperCallNames(input.changedLines)) {
    const candidates = [input.path, ...(input.helperPaths ?? []).filter((p) => p !== input.path)];
    for (const path of candidates) {
      const content = path === input.path ? text : await input.provider(path);
      if (content == null) continue;
      const lines = content.split('\n');
      const range = findDefinition(lines, name);
      if (!range || covered(path, range)) continue;
      push({
        path,
        label: `definition of ${name}(), lines ${range.start}-${range.end}`,
        text: renderNumbered(lines, range),
      });
      break;
    }
  }
  return blocks;
}

export function renderContextBlocks(blocks: ContextBlock[]): string {
  return blocks.map((b) => `### context: ${b.path} — ${b.label}\n${b.text}`).join('\n\n');
}

// ── Finding-centred verification context ────────────────────────────────────

/** One rendered code line. Tags make added / deleted / unchanged / head code unambiguous. */
export type CodeLine = {
  tag: 'ADD' | 'DEL' | 'CTX' | 'HEAD';
  /** Head (new-file) line number; null for deleted lines. */
  n: number | null;
  /** Base (old-file) line number for deleted lines. */
  old: number | null;
  text: string;
};

export type CodeSection = { path: string; label: string; lines: CodeLine[]; focus: number };

export function renderCodeLine(line: CodeLine): string {
  const num = line.tag === 'DEL' ? `old ${line.old ?? '?'}` : String(line.n ?? '?');
  return `${line.tag.padEnd(4)} ${num.padStart(7)} | ${line.text}`;
}

export function renderSection(section: CodeSection): string {
  return `### ${section.label} — ${section.path}\n${section.lines.map(renderCodeLine).join('\n')}`;
}

/** Keep the focus line and grow symmetrically until the rendered size reaches `maxChars`. */
export function trimSection(section: CodeSection, maxChars: number): CodeSection | null {
  const header = section.label.length + section.path.length + 8;
  const sizes = section.lines.map((l) => renderCodeLine(l).length + 1);
  const focus = Math.min(Math.max(section.focus, 0), section.lines.length - 1);
  if (section.lines.length === 0 || header + sizes[focus]! > maxChars) return null;
  let lo = focus;
  let hi = focus;
  let used = header + sizes[focus]!;
  for (;;) {
    let grew = false;
    if (hi + 1 < sizes.length && used + sizes[hi + 1]! <= maxChars) {
      hi += 1;
      used += sizes[hi]!;
      grew = true;
    }
    if (lo - 1 >= 0 && used + sizes[lo - 1]! <= maxChars) {
      lo -= 1;
      used += sizes[lo]!;
      grew = true;
    }
    if (!grew) break;
  }
  const trimmed = lo > 0 || hi < section.lines.length - 1;
  return {
    path: section.path,
    label: trimmed ? `${section.label} (trimmed around the finding)` : section.label,
    lines: section.lines.slice(lo, hi + 1),
    focus: focus - lo,
  };
}

function toCodeLine(line: DiffLine): CodeLine {
  return line.kind === '+'
    ? { tag: 'ADD', n: line.newLine, old: null, text: line.text }
    : line.kind === '-'
      ? { tag: 'DEL', n: null, old: line.oldLine, text: line.text }
      : { tag: 'CTX', n: line.newLine, old: line.oldLine, text: line.text };
}

/** Index of the finding in the file's diff lines (by line number, else by evidence). */
export function findingFocusIndex(
  diffLines: DiffLine[],
  lineStart: number | null,
  lineEnd: number | null,
  evidenceIndex: number | null,
): number {
  if (lineStart != null) {
    const end = lineEnd ?? lineStart;
    const i = diffLines.findIndex((l) => {
      const n = l.kind === '-' ? l.oldLine : l.newLine;
      return n != null && n >= lineStart && n <= end;
    });
    if (i >= 0) return i;
  }
  return evidenceIndex != null && evidenceIndex >= 0 ? evidenceIndex : 0;
}

/** ±radius diff lines around the finding, tagged ADD / DEL / CTX. */
export function diffWindowSection(
  path: string,
  diffLines: DiffLine[],
  focusIndex: number,
  radius = 60,
): CodeSection {
  const lo = Math.max(0, focusIndex - radius);
  const hi = Math.min(diffLines.length, focusIndex + radius + 1);
  return {
    path,
    label:
      'diff around the finding (ADD = added, DEL = deleted, not present at PR head, CTX = unchanged)',
    lines: diffLines.slice(lo, hi).map(toCodeLine),
    focus: focusIndex - lo,
  };
}

/**
 * Head code around the finding: ±radius lines, limited to the enclosing function when it is
 * smaller, plus the enclosing signature when it lies above the window.
 */
export function headWindowSections(
  path: string,
  fileText: string,
  focusLine: number,
  radius = 60,
): CodeSection[] {
  const fileLines = fileText.split('\n');
  const focus = Math.min(Math.max(1, focusLine), fileLines.length);
  const block = enclosingRange(fileLines, focus, 2 * radius + 1);
  const start = Math.max(1, Math.max(block.start, focus - radius));
  const end = Math.min(fileLines.length, Math.min(block.end, focus + radius));
  const head = (from: number, to: number): CodeLine[] =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      tag: 'HEAD' as const,
      n: from + i,
      old: null,
      text: fileLines[from + i - 1] ?? '',
    }));
  const sections: CodeSection[] = [
    {
      path,
      label: 'code at PR head around the finding',
      lines: head(start, end),
      focus: focus - start,
    },
  ];
  // The enclosing signature (who calls this, with which parameters) when it is above.
  const sigStart = enclosingRange(fileLines, focus, 2_000).start;
  if (sigStart < start) {
    sections.push({
      path,
      label: 'enclosing function signature at PR head',
      lines: head(sigStart, Math.min(sigStart + 2, start - 1)),
      focus: 0,
    });
  }
  return sections;
}

const CALL_KEYWORDS = new Set([
  'if',
  'async',
  'constructor',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'typeof',
  'await',
  'new',
  'super',
  'require',
  'import',
  'expect',
  'describe',
  'it',
  'test',
  'map',
  'filter',
  'find',
  'some',
  'every',
  'reduce',
  'forEach',
  'push',
  'join',
  'split',
  'slice',
  'trim',
  'includes',
  'has',
  'get',
  'set',
  'then',
  'catch',
  'toString',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'Promise',
  'JSON',
  'parse',
  'stringify',
  'keys',
  'values',
  'entries',
  'from',
  'test',
  'exec',
  'replace',
  'log',
  'warn',
  'error',
  'Math',
  'max',
  'min',
  'Date',
  'Error',
  'Set',
  'Map',
  'resolve',
  'reject',
]);

/** Called function names in a set of lines (excluding keywords and common built-ins). */
export function calledNames(texts: string[]): string[] {
  const names = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/g)) {
      const name = m[1]!;
      if (name.length > 2 && !CALL_KEYWORDS.has(name)) names.add(name);
    }
  }
  return [...names];
}

/** Paths whose diff lines (added or unchanged) contain a definition of `name`. */
export function definitionPathsInDiff(
  name: string,
  diffLinesByPath: Map<string, DiffLine[]>,
): string[] {
  const escaped = escapeRegExp(name);
  const def = new RegExp(
    String.raw`(?:^|\s)(?:export\s+)?(?:(?:public|private|protected|static|readonly|override|async)\s+)*(?:function\s+)?${escaped}\s*(?:<[^>]*>)?\s*\([^)]*\)?\s*(?::[^{=]+)?\{?\s*$|(?:const|let)\s+${escaped}\s*(?::[^=]+)?=`,
  );
  const out: string[] = [];
  for (const [path, lines] of diffLinesByPath) {
    if (
      lines.some(
        (l) =>
          l.kind !== '-' && def.test(l.text) && !/^\s*(?:this\.|await\b|return\b)/.test(l.text),
      )
    ) {
      out.push(path);
    }
  }
  return out;
}

export type VerificationContext = {
  sections: CodeSection[];
  stats: { diffWindow: boolean; headContext: boolean; helpers: number };
  /** The finding's file at PR head (already fetched), for dependency resolution. */
  headText: string | null;
};

/**
 * Code shown to the verifier, centred on the finding:
 * 1. the diff window (±60 lines) around the finding, with ADD/DEL/CTX tags;
 * 2. head code (±60 lines, enclosing function) around the finding's head line;
 * 3. definitions of guards / helpers / callees used in that window — in the same file or in
 *    other changed files (located from the diff, then fetched at the PR head).
 * Sections are trimmed around the finding, never dropped because a whole file is large.
 */
export async function buildVerificationContext(input: {
  path: string;
  diffLinesByPath: Map<string, DiffLine[]>;
  lineStart: number | null;
  lineEnd: number | null;
  headLine: number | null;
  evidenceIndex: number | null;
  provider?: FileContentProvider;
  maxChars: number;
  radius?: number;
  maxHelpers?: number;
  /** Review cancellation / deadline: aborts in-flight source reads. */
  signal?: AbortSignal;
}): Promise<VerificationContext> {
  const radius = input.radius ?? 60;
  const diffLines = input.diffLinesByPath.get(input.path) ?? [];
  const sections: CodeSection[] = [];
  let left = input.maxChars;
  const add = (section: CodeSection | null, share: number): boolean => {
    if (!section) return false;
    const fitted = trimSection(section, Math.min(left, share));
    if (!fitted) return false;
    sections.push(fitted);
    left -= renderSection(fitted).length + 2;
    return true;
  };

  const focusIndex = findingFocusIndex(
    diffLines,
    input.lineStart,
    input.lineEnd,
    input.evidenceIndex,
  );
  const diffWindow =
    diffLines.length > 0
      ? add(
          diffWindowSection(input.path, diffLines, focusIndex, radius),
          Math.floor(input.maxChars * 0.4),
        )
      : false;

  let headContext = false;
  let windowTexts = diffLines
    .slice(Math.max(0, focusIndex - radius), focusIndex + radius + 1)
    .filter((l) => l.kind !== '-')
    .map((l) => l.text);
  const headText =
    input.provider && !input.signal?.aborted
      ? await input.provider(input.path, input.signal)
      : null;
  const focusHead = input.headLine ?? diffLines[focusIndex]?.newLine ?? input.lineStart;
  if (headText != null && focusHead != null) {
    const [window, signature] = headWindowSections(input.path, headText, focusHead, radius);
    headContext = add(window!, Math.floor(left * 0.65));
    if (signature) add(signature, left);
    windowTexts = windowTexts.concat(window!.lines.map((l) => l.text));
  }

  // Guards / helpers / callees used around the finding.
  let helpers = 0;
  const maxHelpers = input.maxHelpers ?? 4;
  const seen = new Set<string>();
  for (const name of calledNames(windowTexts)) {
    if (helpers >= maxHelpers || left < 300) break;
    const sameFile = headText != null ? findDefinition(headText.split('\n'), name, 40) : null;
    const candidates: { path: string; text: string | null; range: LineRange | null }[] = [];
    if (sameFile && HELPER_NAME_RE.test(name)) {
      candidates.push({ path: input.path, text: headText, range: sameFile });
    } else if (!sameFile && input.provider) {
      for (const path of definitionPathsInDiff(name, input.diffLinesByPath)) {
        if (path === input.path) continue;
        const text = await input.provider(path, input.signal);
        const range = text ? findDefinition(text.split('\n'), name, 40) : null;
        if (range) {
          candidates.push({ path, text, range });
          break;
        }
      }
    }
    for (const c of candidates) {
      const key = `${c.path}:${c.range!.start}`;
      if (seen.has(key) || c.text == null) continue;
      seen.add(key);
      const lines = c.text.split('\n');
      const section: CodeSection = {
        path: c.path,
        label: `definition of ${name}() at PR head`,
        lines: Array.from({ length: c.range!.end - c.range!.start + 1 }, (_, i) => ({
          tag: 'HEAD' as const,
          n: c.range!.start + i,
          old: null,
          text: lines[c.range!.start + i - 1] ?? '',
        })),
        focus: 0,
      };
      if (add(section, Math.max(300, Math.floor(left / Math.max(1, maxHelpers - helpers))))) {
        helpers += 1;
      }
    }
  }
  return { sections, stats: { diffWindow, headContext, helpers }, headText };
}
