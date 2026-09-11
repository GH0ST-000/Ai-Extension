import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('openapi.adapter source safety', () => {
  it('does not scrape document.body.innerText', () => {
    const source = readFileSync(join(__dirname, 'adapters/openapi.adapter.ts'), 'utf8');
    expect(source).not.toContain('body.innerText');
    expect(source).not.toContain('document.body.innerText');
  });

  it('does not eval page scripts', () => {
    const source = readFileSync(join(__dirname, 'adapters/openapi.adapter.ts'), 'utf8');
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toContain('new Function');
  });
});
