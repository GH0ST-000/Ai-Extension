import type { PageContext } from '@project-x/types';

import { githubPageAdapter } from './adapters/github.adapter';
import { jiraPageAdapter } from './adapters/jira.adapter';
import { openapiPageAdapter } from './adapters/openapi.adapter';
import { genericPageAdapter } from './adapters/generic.adapter';
import type { PageAdapter } from './page-adapter';

/**
 * Ordered adapters. First match wins. Generic is always last.
 */
const ADAPTERS: readonly PageAdapter[] = [
  githubPageAdapter,
  jiraPageAdapter,
  openapiPageAdapter,
  genericPageAdapter,
];

/**
 * Extract a normalized page context for the current document.
 * Website-specific DOM logic lives only in adapters.
 */
export function extractPageContext(): PageContext {
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return genericPageAdapter.extract(new URL('https://invalid.local/'));
  }

  for (const adapter of ADAPTERS) {
    if (adapter.matches(url)) {
      return adapter.extract(url);
    }
  }

  return genericPageAdapter.extract(url);
}
