'use client';

import { Suspense, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { verifyGithubAppInstall } from '../../../../../lib/workspace-api';
import { useWorkspace } from '../../../../../lib/workspace-context';

/**
 * GitHub App "Callback URL" (user authorization). Runs inside the signed-in Studio: the API
 * links the installation only when this signed-in Owner/Admin, in this workspace, is the one
 * who started the install and GitHub confirms they control the installation.
 */
function GithubAppCallback() {
  const router = useRouter();
  const params = useSearchParams();
  const { ready, currentWorkspaceId, refresh } = useWorkspace();
  const started = useRef(false);

  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    const code = params.get('code')?.trim();
    const state = params.get('state')?.trim();
    if (!code || !state || !currentWorkspaceId) {
      router.replace('/app/settings?githubApp=error');
      return;
    }
    verifyGithubAppInstall(currentWorkspaceId, { code, state })
      .then(async () => {
        await refresh().catch(() => undefined);
        router.replace('/app/settings?githubApp=connected');
      })
      .catch(() => router.replace('/app/settings?githubApp=error'));
  }, [ready, currentWorkspaceId, params, refresh, router]);

  return (
    <p className="px-1 py-8 text-sm text-muted-foreground" role="status">
      Verifying your GitHub App installation…
    </p>
  );
}

export default function GithubAppCallbackPage() {
  return (
    <Suspense fallback={null}>
      <GithubAppCallback />
    </Suspense>
  );
}
