'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type {
  GitHubConnectionStatus,
  JiraConnectionStatus,
  ResponseStyle,
  UserSettings,
  WorkspaceGitHubAppStatus,
} from '@project-x/types';
import { RESPONSE_STYLES } from '@project-x/types';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { GithubPatGuide } from '../../../components/github-pat-guide';
import { JiraConnectGuide } from '../../../components/jira-connect-guide';
import { StudioSelect } from '../../../components/studio-select';
import {
  ApiError,
  deleteGithubConnection,
  deleteJiraConnection,
  getGithubConnection,
  getJiraConnection,
  getSettings,
  logout,
  updateSettings,
  upsertGithubConnection,
  upsertJiraConnection,
} from '../../../lib/api';
import { getStoredUser } from '../../../lib/auth-storage';
import { useWorkspace } from '../../../lib/workspace-context';
import {
  disconnectGithubApp,
  getGithubAppStatus,
  startGithubAppInstall,
} from '../../../lib/workspace-api';
const STYLE_LABELS: Record<ResponseStyle, string> = {
  CONCISE: 'Concise',
  BALANCED: 'Balanced',
  DETAILED: 'Detailed',
};

export default function SettingsPage() {
  const router = useRouter();
  const user = getStoredUser();
  const { currentWorkspaceId, hasPermission, ready: workspaceReady } = useWorkspace();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [draft, setDraft] = useState<UserSettings | null>(null);
  const [github, setGithub] = useState<GitHubConnectionStatus | null>(null);
  const [githubApp, setGithubApp] = useState<WorkspaceGitHubAppStatus | null>(null);
  const [githubToken, setGithubToken] = useState('');
  const [jira, setJira] = useState<JiraConnectionStatus | null>(null);
  const [jiraEmail, setJiraEmail] = useState('');
  const [jiraToken, setJiraToken] = useState('');
  const [jiraSiteHost, setJiraSiteHost] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [githubSaving, setGithubSaving] = useState(false);
  const [githubAppSaving, setGithubAppSaving] = useState(false);
  const [jiraSaving, setJiraSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [githubMessage, setGithubMessage] = useState<string | null>(null);
  const [githubAppMessage, setGithubAppMessage] = useState<string | null>(null);
  const [jiraMessage, setJiraMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubAppError, setGithubAppError] = useState<string | null>(null);
  const [jiraError, setJiraError] = useState<string | null>(null);

  const canManageIntegrations = hasPermission('integrations:manage');

  const refreshGithubApp = useCallback(async (workspaceId: string) => {
    const status = await getGithubAppStatus(workspaceId);
    setGithubApp(status);
    return status;
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get('githubApp');
    if (!flag) {
      return;
    }
    if (flag === 'connected') {
      setGithubAppMessage('GitHub App installed for this workspace.');
    } else if (flag === 'error') {
      setGithubAppError('GitHub App install did not complete. Try again from Settings.');
    }
    router.replace('/app/settings', { scroll: false });
  }, [router]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [nextSettings, nextGithub, nextJira] = await Promise.all([
          getSettings(),
          getGithubConnection(),
          getJiraConnection(),
        ]);
        if (cancelled) {
          return;
        }
        setSettings(nextSettings);
        setDraft(nextSettings);
        setGithub(nextGithub);
        setJira(nextJira);
        if (nextJira.siteHost) {
          setJiraSiteHost(nextJira.siteHost);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Unable to load settings.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!workspaceReady || !currentWorkspaceId) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const status = await refreshGithubApp(currentWorkspaceId);
        if (cancelled) {
          return;
        }
        setGithubApp(status);
      } catch (err) {
        if (!cancelled) {
          setGithubAppError(
            err instanceof ApiError ? err.message : 'Unable to load GitHub App status.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceReady, currentWorkspaceId, refreshGithubApp]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) {
      return;
    }

    setSaving(true);
    setMessage(null);
    setError(null);

    try {
      const saved = await updateSettings({
        maxOutputTokens: draft.maxOutputTokens,
        responseStyle: draft.responseStyle,
        includePageContext: draft.includePageContext,
      });
      setSettings(saved);
      setDraft(saved);
      setMessage('Settings saved. They apply to the next AI request.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to save settings.');
    } finally {
      setSaving(false);
    }
  }

  async function onConnectGithub(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setGithubSaving(true);
    setGithubMessage(null);
    setGithubError(null);

    try {
      const status = await upsertGithubConnection({ token: githubToken });
      setGithub(status);
      setGithubToken('');
      setGithubMessage(
        status.githubLogin
          ? `Connected as @${status.githubLogin}. Token is stored encrypted on the API.`
          : 'GitHub connected. Token is stored encrypted on the API.',
      );
    } catch (err) {
      setGithubError(err instanceof ApiError ? err.message : 'Unable to save GitHub token.');
    } finally {
      setGithubSaving(false);
    }
  }

  async function onDisconnectGithub() {
    setGithubSaving(true);
    setGithubMessage(null);
    setGithubError(null);

    try {
      await deleteGithubConnection();
      setGithub({ connected: false });
      setGithubToken('');
      setGithubMessage('GitHub disconnected.');
    } catch (err) {
      setGithubError(err instanceof ApiError ? err.message : 'Unable to disconnect GitHub.');
    } finally {
      setGithubSaving(false);
    }
  }

  async function onInstallGithubApp() {
    if (!currentWorkspaceId) {
      setGithubAppError('Select a workspace before installing the GitHub App.');
      return;
    }
    setGithubAppSaving(true);
    setGithubAppMessage(null);
    setGithubAppError(null);
    try {
      const { installUrl } = await startGithubAppInstall(currentWorkspaceId);
      window.location.assign(installUrl);
    } catch (err) {
      setGithubAppError(
        err instanceof ApiError ? err.message : 'Unable to start GitHub App install.',
      );
      setGithubAppSaving(false);
    }
  }

  async function onDisconnectGithubApp() {
    if (!currentWorkspaceId) {
      return;
    }
    setGithubAppSaving(true);
    setGithubAppMessage(null);
    setGithubAppError(null);
    try {
      await disconnectGithubApp(currentWorkspaceId);
      setGithubApp({
        appConfigured: githubApp?.appConfigured ?? false,
        connected: false,
      });
      setGithubAppMessage('GitHub App disconnected from this workspace.');
    } catch (err) {
      setGithubAppError(err instanceof ApiError ? err.message : 'Unable to disconnect GitHub App.');
    } finally {
      setGithubAppSaving(false);
    }
  }

  async function onConnectJira(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setJiraSaving(true);
    setJiraMessage(null);
    setJiraError(null);

    try {
      const status = await upsertJiraConnection({
        email: jiraEmail,
        apiToken: jiraToken,
        siteHost: jiraSiteHost,
      });
      setJira(status);
      setJiraToken('');
      setJiraMessage(
        status.siteHost
          ? `Connected to ${status.siteHost}${
              status.displayName ? ` as ${status.displayName}` : ''
            }. Token is stored encrypted on the API.`
          : 'Jira connected. Token is stored encrypted on the API.',
      );
    } catch (err) {
      setJiraError(err instanceof ApiError ? err.message : 'Unable to save Jira connection.');
    } finally {
      setJiraSaving(false);
    }
  }

  async function onDisconnectJira() {
    setJiraSaving(true);
    setJiraMessage(null);
    setJiraError(null);

    try {
      await deleteJiraConnection();
      setJira({ connected: false });
      setJiraToken('');
      setJiraMessage('Jira disconnected.');
    } catch (err) {
      setJiraError(err instanceof ApiError ? err.message : 'Unable to disconnect Jira.');
    } finally {
      setJiraSaving(false);
    }
  }

  async function signOut() {
    await logout();
    router.replace('/login');
  }

  const dirty =
    draft &&
    settings &&
    (draft.maxOutputTokens !== settings.maxOutputTokens ||
      draft.responseStyle !== settings.responseStyle ||
      draft.includePageContext !== settings.includePageContext);

  return (
    <div className="space-y-8">
      <header className="rise-in">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
          Preferences
        </p>
        <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight text-ink">
          Settings
        </h1>
        <p className="mt-3 max-w-xl text-base text-muted-foreground">
          Control response length, tone, page context, workspace GitHub App, personal PAT fallback,
          and read-only Jira Cloud access.
        </p>
      </header>

      <section className="rise-in-delay-1 space-y-3">
        <h2 className="px-1 font-display text-lg font-semibold tracking-tight">Assistant</h2>

        {loading ? (
          <div className="rounded-3xl border border-line bg-panel/75 px-5 py-8 text-sm text-muted-foreground shadow-panel">
            Loading settings…
          </div>
        ) : draft ? (
          <form
            onSubmit={onSubmit}
            className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel"
          >
            <div className="flex flex-col gap-3 border-b border-line/80 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-ink">Max output tokens</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Caps how long answers can be (150–2000). Lower is cheaper.
                </p>
              </div>
              <input
                type="number"
                min={150}
                max={2000}
                step={50}
                value={draft.maxOutputTokens}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    maxOutputTokens: Number(event.target.value),
                  })
                }
                className="w-28 rounded-xl border border-line bg-mist px-3 py-2 text-sm font-semibold text-ink outline-none ring-accent/30 focus:ring-2"
              />
            </div>

            <div className="flex flex-col gap-3 border-b border-line/80 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-ink">Response style</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  How verbose the assistant should be in the floating panel.
                </p>
              </div>
              <StudioSelect
                id="response-style"
                label="Response style"
                value={draft.responseStyle}
                options={RESPONSE_STYLES.map((style) => ({
                  value: style,
                  label: STYLE_LABELS[style],
                }))}
                onChange={(responseStyle) => setDraft({ ...draft, responseStyle })}
                className="sm:w-44 [&>label]:sr-only [&>button]:mt-0"
              />
            </div>

            <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-ink">Include page context</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Surrounding text, URL, and GitHub metadata with each request.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={draft.includePageContext}
                onClick={() =>
                  setDraft({
                    ...draft,
                    includePageContext: !draft.includePageContext,
                  })
                }
                className={[
                  'self-start rounded-xl border px-3 py-2 text-sm font-semibold sm:self-auto',
                  draft.includePageContext
                    ? 'border-accent bg-accent-soft text-ink'
                    : 'border-line bg-mist text-muted-foreground',
                ].join(' ')}
              >
                {draft.includePageContext ? 'On' : 'Off'}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-line/80 bg-mist/50 px-5 py-4">
              <button
                type="submit"
                disabled={saving || !dirty}
                className="rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              {message ? <p className="text-sm text-accent">{message}</p> : null}
              {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
            </div>
          </form>
        ) : (
          <div className="rounded-3xl border border-line bg-panel/75 px-5 py-8 text-sm text-red-600 dark:text-red-400 shadow-panel">
            {error ?? 'Settings unavailable.'}
          </div>
        )}
      </section>

      <section className="rise-in-delay-1 space-y-3">
        <h2 className="px-1 font-display text-lg font-semibold tracking-tight">GitHub App</h2>
        <p className="max-w-2xl px-1 text-sm text-muted-foreground">
          Recommended. Install the Project X GitHub App on this workspace for least-privilege,
          short-lived tokens. Personal PATs below remain a fallback when the App is not installed.
        </p>

        {!workspaceReady || loading ? (
          <div className="rounded-3xl border border-line bg-panel/75 px-5 py-8 text-sm text-muted-foreground shadow-panel">
            Loading GitHub App…
          </div>
        ) : (
          <div className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel">
            <div className="flex flex-col gap-2 border-b border-line/80 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-ink">Workspace installation</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {!githubApp?.appConfigured
                    ? 'GitHub App is not configured on the API yet.'
                    : githubApp.connected
                      ? `Connected${
                          githubApp.accountLogin ? ` to @${githubApp.accountLogin}` : ''
                        }${
                          githubApp.repositorySelection
                            ? ` · repos: ${githubApp.repositorySelection}`
                            : ''
                        }${githubApp.status === 'suspended' ? ' · suspended' : ''}`
                      : 'Not installed for this workspace'}
                </p>
              </div>
              <span
                className={[
                  'self-start rounded-xl border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide sm:self-auto',
                  githubApp?.connected
                    ? 'border-accent bg-accent-soft text-ink'
                    : 'border-line bg-mist text-muted-foreground',
                ].join(' ')}
              >
                {githubApp?.connected
                  ? githubApp.status === 'suspended'
                    ? 'Suspended'
                    : 'Installed'
                  : 'Not installed'}
              </span>
            </div>

            <div className="space-y-4 px-5 py-4">
              <p className="text-sm text-muted-foreground">
                Permissions requested: Contents (R/W), Pull requests (R/W), Checks (read). Tokens
                are minted on demand and never stored.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                {canManageIntegrations && githubApp?.appConfigured && !githubApp.connected ? (
                  <button
                    type="button"
                    disabled={githubAppSaving || !currentWorkspaceId}
                    onClick={() => {
                      void onInstallGithubApp();
                    }}
                    className="rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:opacity-50"
                  >
                    {githubAppSaving ? 'Opening GitHub…' : 'Install GitHub App'}
                  </button>
                ) : null}
                {canManageIntegrations && githubApp?.connected ? (
                  <>
                    <button
                      type="button"
                      disabled={githubAppSaving || !currentWorkspaceId}
                      onClick={() => {
                        void onInstallGithubApp();
                      }}
                      className="rounded-xl border border-line bg-panel px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
                    >
                      {githubAppSaving ? 'Opening…' : 'Manage on GitHub'}
                    </button>
                    <button
                      type="button"
                      disabled={githubAppSaving}
                      onClick={() => {
                        void onDisconnectGithubApp();
                      }}
                      className="rounded-xl border border-line bg-panel px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
                    >
                      Disconnect App
                    </button>
                  </>
                ) : null}
                {!canManageIntegrations ? (
                  <p className="text-sm text-muted-foreground">
                    Ask a workspace admin to install or disconnect the GitHub App.
                  </p>
                ) : null}
                {!githubApp?.appConfigured ? (
                  <p className="text-sm text-muted-foreground">
                    Set <code className="rounded bg-mist px-1 py-0.5 text-xs">GITHUB_APP_*</code> on
                    the API to enable installs.
                  </p>
                ) : null}
                {githubAppMessage ? (
                  <p className="text-sm text-accent">{githubAppMessage}</p>
                ) : null}
                {githubAppError ? (
                  <p className="text-sm text-red-600 dark:text-red-400">{githubAppError}</p>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="rise-in-delay-1 space-y-3">
        <h2 className="px-1 font-display text-lg font-semibold tracking-tight">
          GitHub PAT (fallback)
        </h2>
        <p className="max-w-2xl px-1 text-sm text-muted-foreground">
          Optional personal token when the workspace App is not installed. Validated with GitHub,
          encrypted on the API, and never returned to the browser or extension.
        </p>

        {loading ? (
          <div className="rounded-3xl border border-line bg-panel/75 px-5 py-8 text-sm text-muted-foreground shadow-panel">
            Loading GitHub connection…
          </div>
        ) : (
          <div className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel">
            <div className="flex flex-col gap-2 border-b border-line/80 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-ink">Connection</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {github?.connected
                    ? `Connected${github.githubLogin ? ` as @${github.githubLogin}` : ''}`
                    : 'Not connected'}
                </p>
              </div>
              <span
                className={[
                  'self-start rounded-xl border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide sm:self-auto',
                  github?.connected
                    ? 'border-accent bg-accent-soft text-ink'
                    : 'border-line bg-mist text-muted-foreground',
                ].join(' ')}
              >
                {github?.connected ? 'Connected' : 'Disconnected'}
              </span>
            </div>

            <form onSubmit={onConnectGithub} className="space-y-4 px-5 py-4">
              <div>
                <label htmlFor="github-pat" className="text-sm font-semibold text-ink">
                  Personal Access Token
                </label>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Fine-grained PAT with{' '}
                  <span className="font-medium text-ink">Pull requests: Read and write</span>.
                </p>
                <GithubPatGuide />
                <input
                  id="github-pat"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={
                    github?.connected ? '••••••••  (paste to replace)' : 'ghp_… or github_pat_…'
                  }
                  value={githubToken}
                  onChange={(event) => setGithubToken(event.target.value)}
                  className="mt-3 w-full rounded-xl border border-line bg-mist px-3 py-2.5 font-mono text-sm text-ink outline-none ring-accent/30 focus:ring-2"
                />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  disabled={githubSaving || githubToken.trim().length < 8}
                  className="rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:opacity-50"
                >
                  {githubSaving ? 'Saving…' : github?.connected ? 'Update token' : 'Save token'}
                </button>
                {github?.connected ? (
                  <button
                    type="button"
                    disabled={githubSaving}
                    onClick={() => {
                      void onDisconnectGithub();
                    }}
                    className="rounded-xl border border-line bg-panel px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
                  >
                    Disconnect
                  </button>
                ) : null}
                {githubMessage ? <p className="text-sm text-accent">{githubMessage}</p> : null}
                {githubError ? (
                  <p className="text-sm text-red-600 dark:text-red-400">{githubError}</p>
                ) : null}
              </div>
            </form>
          </div>
        )}
      </section>

      <section className="rise-in-delay-1 space-y-3">
        <h2 className="px-1 font-display text-lg font-semibold tracking-tight">Jira</h2>
        <p className="max-w-2xl px-1 text-sm text-muted-foreground">
          Connect one Jira Cloud site with an Atlassian API token (email + token). Read-only —
          Project X never creates, edits, comments on, or transitions issues. Credentials stay
          encrypted on the API and are never returned to the browser or extension.
        </p>

        {loading ? (
          <div className="rounded-3xl border border-line bg-panel/75 px-5 py-8 text-sm text-muted-foreground shadow-panel">
            Loading Jira connection…
          </div>
        ) : (
          <div className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel">
            <div className="flex flex-col gap-2 border-b border-line/80 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-ink">Connection</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {jira?.connected
                    ? `Connected to ${jira.siteHost ?? 'Jira Cloud'}${
                        jira.displayName ? ` as ${jira.displayName}` : ''
                      }`
                    : 'Not connected'}
                </p>
              </div>
              <span
                className={[
                  'self-start rounded-xl border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide sm:self-auto',
                  jira?.connected
                    ? 'border-accent bg-accent-soft text-ink'
                    : 'border-line bg-mist text-muted-foreground',
                ].join(' ')}
              >
                {jira?.connected ? 'Connected' : 'Disconnected'}
              </span>
            </div>

            <form onSubmit={onConnectJira} className="space-y-4 px-5 py-4">
              <div>
                <label htmlFor="jira-email" className="text-sm font-semibold text-ink">
                  Atlassian account email
                </label>
                <input
                  id="jira-email"
                  type="email"
                  autoComplete="username"
                  placeholder="you@company.com"
                  value={jiraEmail}
                  onChange={(event) => setJiraEmail(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-line bg-mist px-3 py-2.5 text-sm text-ink outline-none ring-accent/30 focus:ring-2"
                />
              </div>
              <div>
                <label htmlFor="jira-site" className="text-sm font-semibold text-ink">
                  Site host
                </label>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Must be <span className="font-medium text-ink">*.atlassian.net</span> (e.g.
                  company.atlassian.net).
                </p>
                <input
                  id="jira-site"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="company.atlassian.net"
                  value={jiraSiteHost}
                  onChange={(event) => setJiraSiteHost(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-line bg-mist px-3 py-2.5 font-mono text-sm text-ink outline-none ring-accent/30 focus:ring-2"
                />
              </div>
              <div>
                <label htmlFor="jira-token" className="text-sm font-semibold text-ink">
                  API token
                </label>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Create at id.atlassian.com → Security → API tokens. Not your password. Day 17 uses
                  read access only.
                </p>
                <JiraConnectGuide />
                <input
                  id="jira-token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={
                    jira?.connected ? '••••••••  (paste to replace)' : 'Atlassian API token'
                  }
                  value={jiraToken}
                  onChange={(event) => setJiraToken(event.target.value)}
                  className="mt-3 w-full rounded-xl border border-line bg-mist px-3 py-2.5 font-mono text-sm text-ink outline-none ring-accent/30 focus:ring-2"
                />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  disabled={
                    jiraSaving ||
                    jiraEmail.trim().length < 3 ||
                    jiraSiteHost.trim().length < 3 ||
                    jiraToken.trim().length < 8
                  }
                  className="rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:opacity-50"
                >
                  {jiraSaving ? 'Saving…' : jira?.connected ? 'Update connection' : 'Connect Jira'}
                </button>
                {jira?.connected ? (
                  <button
                    type="button"
                    disabled={jiraSaving}
                    onClick={() => {
                      void onDisconnectJira();
                    }}
                    className="rounded-xl border border-line bg-panel px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
                  >
                    Disconnect
                  </button>
                ) : null}
                {jiraMessage ? <p className="text-sm text-accent">{jiraMessage}</p> : null}
                {jiraError ? (
                  <p className="text-sm text-red-600 dark:text-red-400">{jiraError}</p>
                ) : null}
              </div>
            </form>
          </div>
        )}
      </section>

      <section className="rise-in-delay-1 space-y-3">
        <h2 className="px-1 font-display text-lg font-semibold tracking-tight">Workspace</h2>
        <div className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel">
          <Link
            href="/app/workspace"
            className="flex items-center justify-between gap-3 border-b border-line/80 px-5 py-4 transition hover:bg-mist/60"
          >
            <div>
              <p className="text-sm font-semibold text-ink">General</p>
              <p className="mt-0.5 text-sm text-muted-foreground">Name, slug, and soft delete.</p>
            </div>
            <span className="text-sm font-semibold text-muted-foreground">Open</span>
          </Link>
          <Link
            href="/app/workspace/members"
            className="flex items-center justify-between gap-3 border-b border-line/80 px-5 py-4 transition hover:bg-mist/60"
          >
            <div>
              <p className="text-sm font-semibold text-ink">Members</p>
              <p className="mt-0.5 text-sm text-muted-foreground">Invites, roles, and ownership.</p>
            </div>
            <span className="text-sm font-semibold text-muted-foreground">Open</span>
          </Link>
          <Link
            href="/app/billing"
            className="flex items-center justify-between gap-3 px-5 py-4 transition hover:bg-mist/60"
          >
            <div>
              <p className="text-sm font-semibold text-ink">Billing</p>
              <p className="mt-0.5 text-sm text-muted-foreground">Plan, seats, and usage.</p>
            </div>
            <span className="text-sm font-semibold text-muted-foreground">Open</span>
          </Link>
        </div>
      </section>

      <section className="rise-in-delay-2 space-y-3">
        <h2 className="px-1 font-display text-lg font-semibold tracking-tight">Project memory</h2>
        <div className="rounded-3xl border border-line bg-panel/75 p-6 shadow-panel">
          <p className="font-display text-xl font-semibold tracking-tight text-ink">
            Learned repository context
          </p>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            Review architecture chips, active rules, learn candidates, and clear memory for a GitHub
            repo.
          </p>
          <Link
            href="/app/memory"
            className="mt-4 inline-flex rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-soft transition hover:brightness-110"
          >
            Open Memory
          </Link>
        </div>
      </section>

      <section className="rise-in-delay-2 space-y-3">
        <h2 className="px-1 font-display text-lg font-semibold tracking-tight">Account</h2>
        <div className="rounded-3xl border border-line bg-panel/75 p-6 shadow-panel">
          <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="font-display text-xl font-semibold tracking-tight text-ink">
                {user?.name?.trim() || user?.email || 'Signed in'}
              </p>
              {user?.email ? (
                <p className="mt-1 text-sm text-muted-foreground">{user.email}</p>
              ) : null}
              <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                Sign in with the same email in the extension popup to run Ask AI.
              </p>
            </div>
            <button
              type="button"
              onClick={signOut}
              className="inline-flex rounded-xl border border-line bg-panel px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-mist"
            >
              Sign out
            </button>
          </div>
        </div>
      </section>

      <section className="rise-in-delay-3 grid gap-4 md:grid-cols-2">
        <div className="rounded-3xl bg-accent-soft p-6">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
            Privacy
          </p>
          <p className="mt-3 font-display text-2xl font-semibold tracking-tight text-ink">
            Secrets stay on the API.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            OpenAI keys, GitHub PATs, and Jira API tokens never ship in the extension. Tokens are
            encrypted at rest and never echoed back in API responses.
          </p>
        </div>
        <div className="rounded-3xl border border-line bg-panel/70 p-6 shadow-panel">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Cost control
          </p>
          <p className="mt-3 font-display text-2xl font-semibold tracking-tight text-ink">
            Tokens follow you.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Concise style and lower max tokens reduce spend on every streamed answer.
          </p>
        </div>
      </section>
    </div>
  );
}
