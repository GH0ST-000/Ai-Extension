import { describe, expect, it } from 'vitest';

import { addPendingSignIn, isSignInPage, signInPageUrl, takePendingSignIn } from './popup-view';

describe('popup sign-in page', () => {
  it('the background opens the popup document with the sign-in view', () => {
    const url = signInPageUrl(
      (path) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`,
    );
    expect(url).toBe('chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html?view=signin');
    expect(isSignInPage(new URL(url).search)).toBe(true);
  });

  it('the toolbar popup (no query) is not the sign-in page', () => {
    expect(isSignInPage('')).toBe(false);
    expect(isSignInPage('?view=other')).toBe(false);
    expect(isSignInPage('?x=1&view=signin')).toBe(true);
  });

  it('remembers which tab to return to, once, per sign-in tab', () => {
    let pending = addPendingSignIn({}, 50, 7, 2);
    pending = addPendingSignIn(pending, 51, 9);
    const first = takePendingSignIn(pending, 50);
    expect(first.target).toEqual({ returnTabId: 7, returnWindowId: 2 });
    expect(takePendingSignIn(first.rest, 50).target).toBeNull(); // used once
    expect(takePendingSignIn(first.rest, 51).target).toEqual({ returnTabId: 9 });
    expect(takePendingSignIn({}, 99).target).toBeNull(); // a tab we did not open
  });
});
