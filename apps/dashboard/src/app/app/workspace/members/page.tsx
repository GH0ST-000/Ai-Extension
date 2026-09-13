'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { WorkspaceMembership, WorkspaceRole } from '@project-x/types';

import { StudioSelect } from '../../../../components/studio-select';
import { ApiError } from '../../../../lib/api';
import { useWorkspace } from '../../../../lib/workspace-context';
import {
  changeRole,
  inviteMember,
  listMembers,
  removeMember,
  transferOwnership,
} from '../../../../lib/workspace-api';

function apiMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const ROLE_OPTIONS = [
  { value: 'admin' as const, label: 'Admin' },
  { value: 'member' as const, label: 'Member' },
];

function memberLabel(member: WorkspaceMembership): string {
  return member.user?.name?.trim() || member.user?.email || member.userId;
}

export default function WorkspaceMembersPage() {
  const { ready, current, hasPermission } = useWorkspace();
  const workspaceId = current?.workspace.id ?? null;
  const myRole = current?.membership.role ?? null;

  const [members, setMembers] = useState<WorkspaceMembership[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [inviting, setInviting] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canInvite = hasPermission('members:invite');
  const canManage = hasPermission('members:manage');
  const isOwner = myRole === 'owner';

  const loadMembers = useCallback(async () => {
    if (!workspaceId) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await listMembers(workspaceId);
      setMembers(next.filter((member) => member.status !== 'removed'));
    } catch (err) {
      setError(apiMessage(err, 'Unable to load members.'));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  async function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId || !canInvite) {
      return;
    }

    setInviting(true);
    setMessage(null);
    setError(null);
    setInviteLink(null);
    try {
      const invitation = await inviteMember(workspaceId, {
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      setInviteEmail('');
      setInviteRole('member');
      if (invitation.token) {
        const path = `/invite/${invitation.token}`;
        setInviteLink(typeof window !== 'undefined' ? `${window.location.origin}${path}` : path);
        setMessage('Invitation created. Share the link below before it expires.');
      } else {
        setMessage(`Invitation sent to ${invitation.email}.`);
      }
      await loadMembers();
    } catch (err) {
      setError(apiMessage(err, 'Unable to invite member.'));
    } finally {
      setInviting(false);
    }
  }

  async function onChangeRole(membershipId: string, role: 'admin' | 'member') {
    if (!workspaceId || !canManage) {
      return;
    }
    setBusyId(membershipId);
    setMessage(null);
    setError(null);
    try {
      await changeRole(workspaceId, membershipId, { role });
      setMessage('Role updated.');
      await loadMembers();
    } catch (err) {
      setError(apiMessage(err, 'Unable to change role.'));
    } finally {
      setBusyId(null);
    }
  }

  async function onRemove(membershipId: string) {
    if (!workspaceId || !canManage) {
      return;
    }
    setBusyId(membershipId);
    setMessage(null);
    setError(null);
    try {
      await removeMember(workspaceId, membershipId);
      setMessage('Member removed.');
      await loadMembers();
    } catch (err) {
      setError(apiMessage(err, 'Unable to remove member.'));
    } finally {
      setBusyId(null);
    }
  }

  async function onTransfer(membershipId: string) {
    if (!workspaceId || !isOwner) {
      return;
    }
    setBusyId(membershipId);
    setMessage(null);
    setError(null);
    try {
      await transferOwnership(workspaceId, { membershipId });
      setMessage('Ownership transferred.');
      await loadMembers();
    } catch (err) {
      setError(apiMessage(err, 'Unable to transfer ownership.'));
    } finally {
      setBusyId(null);
    }
  }

  if (!ready) {
    return (
      <div className="rounded-3xl border border-line bg-panel/75 px-5 py-8 text-sm text-muted-foreground shadow-panel">
        Loading workspace…
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="rise-in">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
          Workspace
        </p>
        <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight text-ink">
          Members
        </h1>
        <p className="mt-3 max-w-xl text-base text-muted-foreground">
          Invite teammates, adjust roles, and transfer ownership when needed.
        </p>
      </header>

      {message ? (
        <p className="rounded-xl border border-accent bg-accent-soft px-3 py-2 text-sm text-ink">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-xl border border-line bg-panel px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      {inviteLink ? (
        <div className="rounded-xl border border-line bg-mist px-3 py-2 text-xs text-ink">
          <p className="font-semibold">Share this invite link:</p>
          <p className="mt-1 break-all font-mono">{inviteLink}</p>
        </div>
      ) : null}

      {canInvite ? (
        <section className="rise-in-delay-1 space-y-3">
          <h2 className="px-1 font-display text-lg font-semibold tracking-tight">Invite</h2>
          <form
            onSubmit={onInvite}
            className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel"
          >
            <div className="grid gap-4 px-5 py-4 sm:grid-cols-[1fr_160px]">
              <div>
                <label htmlFor="invite-email" className="text-sm font-semibold text-ink">
                  Email
                </label>
                <input
                  id="invite-email"
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-line bg-mist px-3 py-2.5 text-sm font-semibold text-ink outline-none ring-accent/30 focus:ring-2"
                />
              </div>
              <StudioSelect
                id="invite-role"
                label="Role"
                value={inviteRole}
                options={ROLE_OPTIONS}
                onChange={setInviteRole}
              />
            </div>
            <div className="border-t border-line/80 bg-mist/50 px-5 py-4">
              <button
                type="submit"
                disabled={inviting || !inviteEmail.trim()}
                className="rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:opacity-50"
              >
                {inviting ? 'Inviting…' : 'Send invite'}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="rise-in-delay-1 space-y-3">
        <div className="flex items-center justify-between px-1">
          <h2 className="font-display text-lg font-semibold tracking-tight">People</h2>
          <button
            type="button"
            onClick={() => void loadMembers()}
            disabled={loading}
            className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink"
          >
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="rounded-3xl border border-line bg-panel/75 px-5 py-8 text-sm text-muted-foreground shadow-panel">
            Loading members…
          </div>
        ) : members.length === 0 ? (
          <div className="rounded-3xl border border-line bg-panel/75 px-5 py-8 text-sm text-muted-foreground shadow-panel">
            No members yet.
          </div>
        ) : (
          <ul className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel">
            {members.map((member) => {
              const busy = busyId === member.id;
              const role = member.role as WorkspaceRole;
              const canEditRole = canManage && role !== 'owner';
              const canRemove = canManage && role !== 'owner';
              const canTransfer = isOwner && role !== 'owner' && member.status === 'active';

              return (
                <li
                  key={member.id}
                  className="flex flex-col gap-3 border-b border-line/80 px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{memberLabel(member)}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {member.user?.email ?? member.userId} · {member.status}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {canEditRole ? (
                      <StudioSelect
                        id={`role-${member.id}`}
                        label="Role"
                        value={role === 'admin' ? 'admin' : 'member'}
                        options={ROLE_OPTIONS}
                        onChange={(next) => void onChangeRole(member.id, next)}
                        className="sm:w-36 [&>label]:sr-only [&>button]:mt-0"
                      />
                    ) : (
                      <span className="rounded-full border border-line bg-mist px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {role}
                      </span>
                    )}
                    {canTransfer ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onTransfer(member.id)}
                        className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-ink disabled:opacity-50"
                      >
                        Make owner
                      </button>
                    ) : null}
                    {canRemove ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onRemove(member.id)}
                        className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-ink disabled:opacity-50"
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
