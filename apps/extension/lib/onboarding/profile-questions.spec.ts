import { describe, expect, it } from 'vitest';

import { getDashboardBaseUrl, getDashboardWelcomeUrl } from '../workspace/dashboard-url';
import { offerProfileQuestionsAfterAuth } from './profile-questions';

describe('extension → optional profile questions', () => {
  it('is offered only right after registration, never to signing-in users', () => {
    expect(offerProfileQuestionsAfterAuth('register')).toBe(true);
    expect(offerProfileQuestionsAfterAuth('login')).toBe(false);
  });

  it('links to the existing dashboard welcome page without any credential', () => {
    const url = new URL(getDashboardWelcomeUrl());
    expect(url.origin).toBe(new URL(getDashboardBaseUrl()).origin);
    expect(url.pathname).toBe('/app/welcome');
    expect([...url.searchParams.keys()]).toEqual(['next']);
    expect(url.searchParams.get('next')).toBe('/app');
    expect(url.hash).toBe('');
    expect(url.toString()).not.toMatch(/token|access|refresh|eyJ/i);
  });
});
