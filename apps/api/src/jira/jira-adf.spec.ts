import { describe, expect, it } from 'vitest';

import { boundComments, normalizeJiraRichText } from './jira-adf';

describe('normalizeJiraRichText', () => {
  it('handles plain strings', () => {
    const result = normalizeJiraRichText('  Hello   world  ', 100);
    expect(result.plainText).toBe('Hello world');
    expect(result.truncated).toBe(false);
  });

  it('normalizes headings, lists, code, and links from ADF', () => {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Acceptance' }],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'No duplicate charges' }],
                },
              ],
            },
          ],
        },
        {
          type: 'codeBlock',
          content: [{ type: 'text', text: 'const x = 1' }],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'docs',
              marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
            },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'id', marks: [{ type: 'code' }] },
          ],
        },
      ],
    };

    const text = normalizeJiraRichText(adf).plainText;
    expect(text).toContain('## Acceptance');
    expect(text).toContain('- No duplicate charges');
    expect(text).toContain('```');
    expect(text).toContain('const x = 1');
    expect(text).toContain('[docs](https://example.com)');
    expect(text).toContain('`id`');
  });

  it('skips media nodes and truncates long text', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'mediaSingle', content: [{ type: 'media' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'x'.repeat(50) }],
        },
      ],
    };
    const withMedia = normalizeJiraRichText(adf, 500);
    expect(withMedia.plainText).toContain('[attachment/media omitted]');
    const truncated = normalizeJiraRichText(adf, 20);
    expect(truncated.truncated).toBe(true);
    expect(truncated.plainText.length).toBeLessThanOrEqual(21);
  });

  it('tolerates malformed nodes', () => {
    expect(normalizeJiraRichText({ type: 'weird', foo: 1 }).plainText).toBe('');
    expect(normalizeJiraRichText(null).plainText).toBe('');
  });
});

describe('boundComments', () => {
  it('caps comment count and per-comment length with plainText shape', () => {
    const comments = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      body: { plainText: 'a'.repeat(5000), truncated: false },
    }));
    const result = boundComments(comments);
    expect(result.comments.length).toBeLessThanOrEqual(8);
    expect(result.truncated).toBe(true);
    for (const c of result.comments) {
      expect(c.body.plainText.length).toBeLessThanOrEqual(2001);
      expect(typeof c.body.plainText).toBe('string');
    }
  });
});
