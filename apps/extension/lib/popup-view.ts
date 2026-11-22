/**
 * How the popup document was opened.
 *
 * Normally it is the toolbar popup (a 340px bubble). When a content script asks the user to
 * sign in, the background opens the same document in a TAB with `?view=signin` (a content
 * script cannot open the toolbar popup). As a full page it must look like a page — a centered
 * card, not a small block in the corner of an empty tab — and go straight to the sign-in form.
 *
 * Round trip: the background remembers which tab asked (`OPEN_SIGN_IN`); when the sign-in
 * page reports success (`SIGN_IN_COMPLETE`) it closes the sign-in tab, brings the original
 * tab back to the front and tells its toolbar to run the interrupted action again
 * (`RESUME_AFTER_SIGN_IN`).
 */
export const SIGN_IN_VIEW_QUERY = 'view=signin';

/** Sign-in page → background: the user is now signed in. */
export const SIGN_IN_COMPLETE_MESSAGE = 'SIGN_IN_COMPLETE';
/** Background → the tab that asked to sign in: retry the action that needed it. */
export const RESUME_AFTER_SIGN_IN_MESSAGE = 'RESUME_AFTER_SIGN_IN';

/** chrome.storage.session key: sign-in tab id → the tab (and window) to return to. */
export const PENDING_SIGN_INS_KEY = 'px.pendingSignIns';

export type PendingSignIns = Record<string, { returnTabId: number; returnWindowId?: number }>;

export function isSignInPage(search: string): boolean {
  return new URLSearchParams(search).get('view') === 'signin';
}

/** URL of the sign-in page for `chrome.tabs.create`. */
export function signInPageUrl(getUrl: (path: string) => string): string {
  return getUrl(`popup.html?${SIGN_IN_VIEW_QUERY}`);
}

/** Record that `signInTabId` was opened for `returnTabId` (pure: returns the new map). */
export function addPendingSignIn(
  pending: PendingSignIns,
  signInTabId: number,
  returnTabId: number,
  returnWindowId?: number,
): PendingSignIns {
  return {
    ...pending,
    [String(signInTabId)]: {
      returnTabId,
      ...(returnWindowId !== undefined ? { returnWindowId } : {}),
    },
  };
}

/** Take (and remove) the return target of a sign-in tab; null when it was not opened by us. */
export function takePendingSignIn(
  pending: PendingSignIns,
  signInTabId: number,
): { target: PendingSignIns[string] | null; rest: PendingSignIns } {
  const key = String(signInTabId);
  const target = pending[key] ?? null;
  const { [key]: _removed, ...rest } = pending;
  return { target, rest };
}
