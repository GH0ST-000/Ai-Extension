/** Holds the closed shadow root so DOM helpers can still test containment. */
let toolbarShadowRoot: ShadowRoot | null = null;

export function registerToolbarShadowRoot(root: ShadowRoot): void {
  toolbarShadowRoot = root;
}

export function getToolbarShadowRoot(): ShadowRoot | null {
  return toolbarShadowRoot;
}
