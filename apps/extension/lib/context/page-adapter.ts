import type { PageContext } from '@project-x/types';

export type PageAdapter = {
  /** Return true when this adapter should handle the current page. */
  matches: (url: URL) => boolean;
  /** Build normalized context for the current page + selection. */
  extract: (url: URL) => PageContext;
};
