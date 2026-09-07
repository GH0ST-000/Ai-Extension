import { describe, expect, it } from 'vitest';

import { parseGitHubUrl } from './adapters/github.adapter';
import { truncateText } from './dom-context';

describe('parseGitHubUrl', () => {
  it('parses repository root', () => {
    expect(parseGitHubUrl(new URL('https://github.com/acme/app'))).toEqual({
      owner: 'acme',
      repository: 'app',
    });
  });

  it('parses blob file URLs', () => {
    expect(parseGitHubUrl(new URL('https://github.com/acme/app/blob/main/src/index.ts'))).toEqual({
      owner: 'acme',
      repository: 'app',
      branch: 'main',
      filePath: 'src/index.ts',
    });
  });

  it('parses pull request URLs', () => {
    expect(parseGitHubUrl(new URL('https://github.com/acme/app/pull/42'))).toEqual({
      owner: 'acme',
      repository: 'app',
      pullRequestNumber: 42,
    });
  });

  it('returns null for non-GitHub hosts', () => {
    expect(parseGitHubUrl(new URL('https://gitlab.com/acme/app'))).toBeNull();
  });
});

describe('truncateText', () => {
  it('keeps short strings unchanged', () => {
    expect(truncateText('hello', 10)).toBe('hello');
  });

  it('truncates around an anchor when present', () => {
    const value = 'aaaa TARGET bbbb';
    const result = truncateText(value, 10, { anchor: 'TARGET' });
    expect(result.includes('TARGET')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(10);
  });
});
