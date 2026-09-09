import { describe, expect, it } from 'vitest';

import { extractFixClipboardText, parseSuggestFixContent } from './parse-suggest-fix';

describe('parseSuggestFixContent', () => {
  it('extracts fence body and structured meta', () => {
    const content = [
      'Issue: Null deref on empty list.',
      'Why: items[0] is unchecked.',
      '```ts',
      'const first = items.at(0);',
      'if (!first) return;',
      '```',
      'Note: Prefer optional chaining only if API allows.',
    ].join('\n');

    const parsed = parseSuggestFixContent(content);
    expect(parsed.language).toBe('ts');
    expect(parsed.fixCode).toBe('const first = items.at(0);\nif (!first) return;');
    expect(parsed.issue).toBe('Null deref on empty list.');
    expect(parsed.why).toBe('items[0] is unchecked.');
    expect(parsed.note).toContain('Prefer optional chaining');
  });

  it('prefers a language-tagged code fence over a meta fence', () => {
    const content = [
      '```',
      'Issue: Endpoint naming inconsistency.',
      'Why: The route for employees should follow plural naming.',
      '```',
      '```php',
      "Route::apiResource('/employees', EmployeeController::class);",
      '```',
      'Note: Ensure references are updated.',
    ].join('\n');

    const parsed = parseSuggestFixContent(content);
    expect(parsed.language).toBe('php');
    expect(parsed.fixCode).toContain("'/employees'");
    expect(parsed.issue).toBe('Endpoint naming inconsistency.');
    expect(parsed.why).toContain('plural naming');
    expect(parsed.note).toContain('Ensure references');
    expect(parsed.fixCode).not.toContain('Issue:');
  });

  it('returns prose-only when no fence exists', () => {
    const parsed = parseSuggestFixContent('Issue: unclear without a patch yet.');
    expect(parsed.fixCode).toBeNull();
    expect(parsed.language).toBeNull();
    expect(parsed.issue).toBe('unclear without a patch yet.');
  });

  it('Copy Fix prefers fence body', () => {
    const content = 'Issue: x\n```js\nreturn a ?? b;\n```';
    expect(extractFixClipboardText(content)).toBe('return a ?? b;');
  });

  it('Copy Fix falls back to full text', () => {
    expect(extractFixClipboardText('plain suggestion')).toBe('plain suggestion');
  });
});
