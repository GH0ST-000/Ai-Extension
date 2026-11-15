/**
 * Direct callers for claims about a returned value, a null fallback or error propagation:
 * what the code does with the value decides whether a "silent null" or "swallowed error" is
 * a defect, and that lives in the callers, which callee-following never reaches.
 *
 * Callers are searched only in the PR's changed files (executable lines) and read through
 * the review's existing authorized, cached context provider. A call site is shown as
 * context; it does not prove the path runs. Nothing here logs source.
 */
import { redactSensitiveString, escapeRegExp } from '@project-x/shared';

import type { DiffLine } from './diff-hunks';
import { trimSection, type CodeSection, type FileContentProvider } from './pr-review-context';
import { looksLikeTestPath } from './pr-review-files';
import { executionPathRanks } from './pr-review-site';

export const MAX_CALLERS = 2;
const CALLER_RADIUS = 12;

export type CallerStatus =
  /** Not a return-value / fallback / error-propagation claim. */
  | 'not_applicable'
  /** The function containing the finding has no name to search for. */
  | 'unavailable'
  | 'none_in_changed_files'
  | 'found';

const RETURN_EVIDENCE_RE =
  /\breturn\b|\?\?|\|\||\?[^:?]+:\s*(?:null|undefined)\b|\bthrow\b|\bcatch\b|\breject\s*\(/;
const RETURN_CLAIM_RE =
  /\b(?:null|undefined|returns?|returned|fallback|falls back|propagat\w*|rethrow\w*|swallow\w*)\b/i;

/** Claims whose truth depends on what callers do with a value or an error. */
export function needsCallers(evidence: string, claim: string): boolean {
  return RETURN_EVIDENCE_RE.test(evidence) || RETURN_CLAIM_RE.test(claim);
}

export async function findCallers(input: {
  name: string | null;
  definitionPath: string;
  definitionRange: [number, number] | null;
  diffLinesByPath: ReadonlyMap<string, readonly DiffLine[]>;
  provider?: FileContentProvider;
  signal?: AbortSignal;
  maxChars: number;
}): Promise<{ status: CallerStatus; sections: CodeSection[]; found: number }> {
  if (!input.name || input.name.length < 3) {
    return { status: 'unavailable', sections: [], found: 0 };
  }
  const esc = escapeRegExp(input.name);
  const call = new RegExp(String.raw`(?<![\w$])${esc}\s*(?:<[^>()]*>)?\(`);
  // A definition, not a call: `function name(`, `const name =`, or a method signature whose
  // parameter list closes on the line and opens a body (`name(a: T): R {`). A bare call at
  // the start of a line (`name({`) is a call.
  const definition = new RegExp(
    String.raw`(?:function\s+|(?:const|let|var)\s+)${esc}\b|^\s*(?:(?:export|public|private|protected|static|async)\s+)*${esc}\s*(?:<[^>]*>)?\([^)]*\)\s*(?::[^{=]+)?\{\s*$`,
  );
  // A method is called through its own class: `this.name(` inside it, or a receiver that
  // names it (`this.notesService.remove(` for NotesService.remove) or is declared with its
  // type. `this.users.remove(` is another class's method with the same name.
  const owner = await ownerClass(input);
  const stem = owner?.replace(/(?:Service|Repository|Repo|Controller|Store|Manager|Client)$/, '');
  const receiverRe = new RegExp(String.raw`([A-Za-z_$][\w$.]*)\.${esc}\s*(?:<[^>()]*>)?\(`);
  const declaredAs = new Set<string>();
  if (owner) {
    const typed = new RegExp(
      String.raw`\b([A-Za-z_$][\w$]*)\s*(?::\s*${owner}\b|=\s*new\s+${owner}\b)`,
      'g',
    );
    for (const lines of input.diffLinesByPath.values()) {
      for (const l of lines) for (const m of l.text.matchAll(typed)) declaredAs.add(m[1]!);
    }
  }
  const sameClassCall = (text: string, path: string) => {
    if (!owner || !stem) return true;
    const receiver = receiverRe.exec(text)?.[1];
    if (!receiver) return true; // a plain call of an imported / module function
    if (receiver === 'this') return path === input.definitionPath;
    const last = receiver.split('.').pop()!;
    return last.toLowerCase().includes(stem.toLowerCase()) || declaredAs.has(last);
  };
  const hits: { path: string; line: number }[] = [];
  // Production callers first (a test calling the function says little about runtime use).
  const paths = [...input.diffLinesByPath.keys()].sort(
    (a, b) => Number(looksLikeTestPath(a)) - Number(looksLikeTestPath(b)),
  );
  for (const path of paths) {
    if (looksLikeTestPath(path)) continue;
    for (const l of input.diffLinesByPath.get(path) ?? []) {
      if (l.kind === '-' || l.newLine == null) continue;
      if (/^\s*(?:import|export\s+\{)/.test(l.text) || definition.test(l.text)) continue;
      if (
        path === input.definitionPath &&
        input.definitionRange &&
        l.newLine >= input.definitionRange[0] &&
        l.newLine <= input.definitionRange[1]
      ) {
        continue;
      }
      if (
        call.test(l.text) &&
        sameClassCall(l.text, path) &&
        !hits.some((h) => h.path === path && h.line === l.newLine)
      ) {
        hits.push({ path, line: l.newLine });
      }
    }
  }
  if (hits.length === 0) return { status: 'none_in_changed_files', sections: [], found: 0 };

  const sections: CodeSection[] = [];
  let left = input.maxChars;
  for (const hit of hits.slice(0, MAX_CALLERS)) {
    if (input.signal?.aborted || left <= 200) break;
    const text = input.provider
      ? await input.provider(hit.path, input.signal).catch(() => null)
      : null;
    let lines: { n: number; text: string }[];
    if (text != null) {
      const all = text.split('\n');
      const fn = executionPathRanks(hit.path, text, hit.line).functionRange;
      const from = Math.max(fn?.[0] ?? 1, hit.line - CALLER_RADIUS);
      const to = Math.min(fn?.[1] ?? all.length, hit.line + CALLER_RADIUS);
      lines = Array.from({ length: to - from + 1 }, (_, i) => ({
        n: from + i,
        text: all[from + i - 1] ?? '',
      }));
    } else {
      lines = (input.diffLinesByPath.get(hit.path) ?? [])
        .filter(
          (l) =>
            l.kind !== '-' && l.newLine != null && Math.abs(l.newLine - hit.line) <= CALLER_RADIUS,
        )
        .map((l) => ({ n: l.newLine!, text: l.text }));
    }
    const focus = Math.max(
      0,
      lines.findIndex((l) => l.n === hit.line),
    );
    const section = trimSection(
      {
        path: hit.path,
        label: `caller of ${input.name}() in this PR (line ${hit.line}) — context only; a call here does not prove this path runs`,
        lines: lines.map((l) => ({
          tag: 'HEAD' as const,
          n: l.n,
          old: null,
          text: redactSensitiveString(l.text),
        })),
        focus,
      },
      left,
    );
    if (!section) continue;
    left -= section.lines.reduce((n, l) => n + l.text.length + 16, section.label.length + 40);
    sections.push(section);
  }
  return { status: 'found', sections, found: hits.length };
}

/** The class declaring the definition (null for module functions or when unreadable). */
async function ownerClass(input: {
  definitionPath: string;
  definitionRange: [number, number] | null;
  provider?: FileContentProvider;
  signal?: AbortSignal;
}): Promise<string | null> {
  if (!input.provider || !input.definitionRange) return null;
  const text = await input.provider(input.definitionPath, input.signal).catch(() => null);
  if (text == null) return null;
  const lines = text.split('\n').slice(0, input.definitionRange[0]);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(
      lines[i]!,
    );
    if (m) return m[1]!;
    // A module-level function between the class and the definition: not a method.
    if (/^(?:export\s+)?(?:async\s+)?function\b|^(?:export\s+)?const\s/.test(lines[i]!))
      return null;
  }
  return null;
}
