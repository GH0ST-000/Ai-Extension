import type { RepositoryAccessResult } from './github-access.service';

type TokenStub = { getDecryptedToken?: (userId: string) => Promise<string | null> | string | null };

/**
 * Test helper: a GithubAccessService double derived from a simple token stub (the shape the
 * older specs used). `resolveRepositoryAccess(userId, …)` grants the stub's token for that user
 * as a personal token (`pat`, no App) and reports `not_connected` when the stub returns null.
 * Repository-level authorization itself is covered by github-access.service.spec.ts and the H1
 * integration tests (github-repository-authorization.pg.spec.ts).
 */
export function repositoryAccessStub<T extends TokenStub>(
  stub: T,
  tokenFrom?: (userId: string) => Promise<{ token: string; source: 'pat' | 'installation' } | null>,
) {
  const resolve = async (userId: string): Promise<RepositoryAccessResult> => {
    const resolved = tokenFrom
      ? await tokenFrom(userId)
      : await Promise.resolve(stub.getDecryptedToken?.(userId)).then((token) =>
          token ? { token, source: 'pat' as const } : null,
        );
    return resolved
      ? { ok: true, ...resolved, workspaceId: 'ws_test' }
      : { ok: false, reason: 'not_connected', workspaceId: 'ws_test' };
  };
  return Object.assign(stub, {
    resolveRepositoryAccess: async (userId: string, _input?: unknown) => resolve(userId),
    getPersonalToken: async (userId: string) =>
      stub.getDecryptedToken ? stub.getDecryptedToken(userId) : null,
  });
}
