import { describe, expect, it } from 'vitest';

import {
  findJiraIssueKeysInText,
  jiraSiteBaseUrl,
  normalizeJiraIssueKey,
  normalizeJiraSiteHost,
} from './jira-site';

describe('normalizeJiraSiteHost', () => {
  it('accepts bare *.atlassian.net hosts', () => {
    expect(normalizeJiraSiteHost('Company.atlassian.net')).toBe('company.atlassian.net');
  });

  it('accepts https URLs and strips path', () => {
    expect(normalizeJiraSiteHost('https://acme.atlassian.net/browse/PAY-1')).toBe(
      'acme.atlassian.net',
    );
  });

  it('rejects http and non-Atlassian hosts (SSRF)', () => {
    expect(normalizeJiraSiteHost('http://acme.atlassian.net')).toBeNull();
    expect(normalizeJiraSiteHost('https://evil.example.com')).toBeNull();
    expect(normalizeJiraSiteHost('https://atlassian.net.evil.com')).toBeNull();
    expect(normalizeJiraSiteHost('169.254.169.254')).toBeNull();
    expect(normalizeJiraSiteHost('localhost')).toBeNull();
  });
});

describe('normalizeJiraIssueKey', () => {
  it('uppercases valid keys', () => {
    expect(normalizeJiraIssueKey('pay-321')).toBe('PAY-321');
  });

  it('rejects bare numbers and malformed keys', () => {
    expect(normalizeJiraIssueKey('321')).toBeNull();
    expect(normalizeJiraIssueKey('PAY')).toBeNull();
    expect(normalizeJiraIssueKey('pay_321')).toBeNull();
  });
});

describe('findJiraIssueKeysInText', () => {
  it('finds boundary-aware keys and rejects partial numbers', () => {
    expect(findJiraIssueKeysInText('Fixes PAY-321 and also mentions 321 alone')).toEqual([
      'PAY-321',
    ]);
  });

  it('dedupes keys', () => {
    expect(findJiraIssueKeysInText('PAY-1 then pay-1 again')).toEqual(['PAY-1']);
  });
});

describe('jiraSiteBaseUrl', () => {
  it('builds https base only', () => {
    expect(jiraSiteBaseUrl('acme.atlassian.net')).toBe('https://acme.atlassian.net');
  });
});
