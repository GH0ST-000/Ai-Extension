/**
 * Deterministic candidate-quality checks run after validation and before verification.
 *
 * - Test entry files (Gate B): a runtime claim can only be rejected when its evidence is in a
 *   file that is provably not on a production execution path — it runs test cases at the top
 *   level AND exports nothing (so nothing can import code from it), AND it is test code by
 *   path or test-framework import. Path alone never decides; anything exported (a helper or
 *   fixture production code might import) or unreadable stays a candidate.
 * - Project Memory echo (Gate C): the claim repeats phrases of an applied rule that appear
 *   nowhere in the changed code. A flag for routing and telemetry, never a rejection.
 *
 * Nothing here logs source or rule text.
 */
import ts from 'typescript';

import type { DiffLine } from './diff-hunks';
import { looksLikeTestPath } from './pr-review-files';

// ── Gate B: test entry files ───────────────────────────────────────────────

export type TestCodeStatus =
  /** Runs test cases at the top level and exports nothing: not importable by production. */
  | 'test_entry'
  /** Test-looking code that exports something, or test-runner-free test-path code. */
  | 'test_support'
  | 'not_test';

const RUNNERS = new Set(['describe', 'it', 'test', 'suite', 'context']);
const TEST_FRAMEWORKS =
  /^(?:vitest|jest|@jest\/globals|mocha|node:test|bun:test|@playwright\/test|ava|tap)$/;

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** `describe(…)`, `it.each(…)(…)`, `test.skip(…)` → the runner name, else null. */
function runnerName(expr: ts.Expression): string | null {
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isCallExpression(e)) e = e.expression;
    else if (ts.isPropertyAccessExpression(e)) e = e.expression;
    else if (ts.isAwaitExpression(e)) e = e.expression;
    else break;
  }
  return ts.isIdentifier(e) && RUNNERS.has(e.text) ? e.text : null;
}

function exportsSomething(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isExportDeclaration(n) || ts.isExportAssignment(n)) {
      found = true;
      return;
    }
    if (
      ts.canHaveModifiers(n) &&
      (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      found = true;
      return;
    }
    // CommonJS: module.exports = … / exports.x = …
    if (
      ts.isPropertyAccessExpression(n) &&
      ((ts.isIdentifier(n.expression) && n.expression.text === 'exports') ||
        (ts.isIdentifier(n.expression) &&
          n.expression.text === 'module' &&
          n.name.text === 'exports'))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

export function classifyTestCode(path: string, text: string): TestCodeStatus {
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  } catch {
    return looksLikeTestPath(path) ? 'test_support' : 'not_test';
  }
  const runsTests = sf.statements.some(
    (s) => ts.isExpressionStatement(s) && runnerName(s.expression) != null,
  );
  const importsFramework = sf.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      TEST_FRAMEWORKS.test(s.moduleSpecifier.text),
  );
  const testByPathOrImport = looksLikeTestPath(path) || importsFramework;
  if (runsTests && testByPathOrImport && !exportsSomething(sf)) return 'test_entry';
  if (testByPathOrImport) return 'test_support';
  return 'not_test';
}

/**
 * Full text of a file added by the PR, from its diff lines (every head line 1..N added and
 * present). Null when the diff does not contain the whole file.
 */
export function fullTextOfAddedFile(lines: readonly DiffLine[]): string | null {
  const added = lines.filter((l) => l.newLine != null);
  if (added.length === 0 || added.some((l) => l.kind !== '+')) return null;
  const byLine = new Map(added.map((l) => [l.newLine!, l.text]));
  const max = Math.max(...byLine.keys());
  if (byLine.size !== max) return null;
  return Array.from({ length: max }, (_, i) => byLine.get(i + 1)!).join('\n');
}

// ── Gate C: Project Memory echo ────────────────────────────────────────────

/** Rule texts from the server-built memory block (`- [conf] (CATEGORY) key: summary`). */
export function memoryRulesFromBlock(block: string | undefined): string[] {
  if (!block) return [];
  const rules: string[] = [];
  for (const line of block.split('\n')) {
    const m = /^- \[[^\]]*\] \([^)]*\) (.*)$/.exec(line.trim());
    if (m) rules.push(m[1]!);
  }
  return rules;
}

const STOPWORDS = new Set(
  (
    'a an the and or but if then else of to in on at by for from with without into onto ' +
    'is are was were be been being am do does did has have had must should shall can could ' +
    'may might will would this that these those it its they them their there here we our you ' +
    'your he she his her as so than too very not no nor any all each every some such only ' +
    'also just when while where which who whom whose what why how about over under again ' +
    'more most other same own'
  ).split(' '),
);

/** Lower-case content words; camelCase / snake_case split so code and prose compare. */
export function contentWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

function bigrams(words: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < words.length; i += 1) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

export type MemoryEcho = {
  /** Index of the rule in the applied block (never its text). */
  rule: number;
  /** Rule phrases repeated by the claim. */
  shared: number;
  /** Of those, phrases that appear nowhere in the changed code. */
  ungrounded: number;
};

/**
 * The claim repeats an applied rule (at least two of its two-word phrases) and at least one
 * repeated phrase is absent from the changed code — wording that came from memory, not code.
 */
export function detectMemoryEcho(
  claim: string,
  rules: readonly string[],
  changedCode: string,
): MemoryEcho | null {
  if (rules.length === 0) return null;
  const claimPhrases = bigrams(contentWords(claim));
  const codePhrases = bigrams(contentWords(changedCode));
  let best: MemoryEcho | null = null;
  rules.forEach((rule, index) => {
    const shared = [...bigrams(contentWords(rule))].filter((p) => claimPhrases.has(p));
    const ungrounded = shared.filter((p) => !codePhrases.has(p));
    if (shared.length >= 2 && ungrounded.length >= 1) {
      if (!best || ungrounded.length > best.ungrounded) {
        best = { rule: index, shared: shared.length, ungrounded: ungrounded.length };
      }
    }
  });
  return best;
}
