import { describe, expect, it } from 'vitest';

import {
  attributionFromSearch,
  referrerHostOf,
  signupAttributionFrom,
  withAttribution,
} from './attribution';

describe('first-touch attribution (client side)', () => {
  it('keeps only allowlisted campaign parameters with safe values', () => {
    const params = attributionFromSearch(
      '?utm_source=google&utm_medium=cpc&utm_campaign=launch&utm_content=hero&ref=partner1' +
        '&email=a%40b.com&token=abc&next=%2Fapp&utm_term=x&gclid=123',
    );
    expect(Object.fromEntries(params)).toEqual({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'launch',
      utm_content: 'hero',
      ref: 'partner1',
    });
  });

  it('drops unsafe or oversized values', () => {
    const params = attributionFromSearch(
      `?utm_source=a%40b.com&utm_medium=${'x'.repeat(101)}&utm_campaign=%3Cscript%3E&ref=https%3A%2F%2Fevil`,
    );
    expect([...params.keys()]).toEqual([]);
  });

  it('referrer: external host only, never a path or own site', () => {
    expect(
      referrerHostOf('https://news.ycombinator.com/item?id=1&token=x', 'app.example.com'),
    ).toBe('news.ycombinator.com');
    expect(referrerHostOf('https://app.example.com/pricing', 'app.example.com')).toBeNull();
    expect(referrerHostOf('', 'app.example.com')).toBeNull();
    expect(referrerHostOf('javascript:alert(1)', 'app.example.com')).toBeNull();
    expect(attributionFromSearch('', 'news.ycombinator.com').get('ref_host')).toBe(
      'news.ycombinator.com',
    );
  });

  it('carries parameters into the register link and the signup payload', () => {
    const attribution = attributionFromSearch('?utm_source=newsletter&ref=friend');
    const href = withAttribution('/login?mode=register', attribution);
    expect(href).toBe('/login?mode=register&utm_source=newsletter&ref=friend');
    expect(withAttribution('/login?mode=register', new URLSearchParams())).toBe(
      '/login?mode=register',
    );
    expect(signupAttributionFrom(new URLSearchParams(href.split('?')[1]))).toEqual({
      utmSource: 'newsletter',
      referral: 'friend',
    });
    expect(signupAttributionFrom(new URLSearchParams('mode=register'))).toBeUndefined();
  });
});
