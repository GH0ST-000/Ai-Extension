import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('jira.adapter source safety', () => {
  it('does not scrape document.body.innerText', () => {
    const source = readFileSync(join(__dirname, 'adapters/jira.adapter.ts'), 'utf8');
    expect(source).not.toContain('body.innerText');
    expect(source).not.toContain('document.body');
  });
});
