'use client';

import type { WorkspaceInvitation } from '@project-x/types';

function formatExpiry(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Pending workspace invitations (M3). Shown only to people who can invite; the server enforces
 * the same rule. Never displays invitation tokens (the API does not return them here).
 */
export function PendingInvitations({
  invitations,
  loading,
  revokingId,
  onRevoke,
}: {
  invitations: WorkspaceInvitation[];
  loading: boolean;
  revokingId: string | null;
  onRevoke: (invitationId: string) => void;
}) {
  return (
    <section className="rise-in-delay-1 space-y-3" aria-labelledby="pending-invitations-title">
      <h2
        id="pending-invitations-title"
        className="px-1 font-display text-lg font-semibold tracking-tight"
      >
        Pending invitations
      </h2>
      {loading ? (
        <div className="rounded-3xl border border-line bg-panel/75 px-5 py-6 text-sm text-muted-foreground shadow-panel">
          Loading invitations…
        </div>
      ) : invitations.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-line bg-panel/75 px-5 py-6 text-sm text-muted-foreground shadow-panel">
          No pending invitations.
        </div>
      ) : (
        <ul className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel">
          {invitations.map((invitation) => {
            const busy = revokingId === invitation.id;
            return (
              <li
                key={invitation.id}
                className="flex flex-col gap-3 border-b border-line/80 px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{invitation.email}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Expires {formatExpiry(invitation.expiresAt)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-line bg-mist px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {invitation.role}
                  </span>
                  <button
                    type="button"
                    disabled={revokingId !== null}
                    onClick={() => onRevoke(invitation.id)}
                    aria-label={`Revoke invitation for ${invitation.email}`}
                    className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-ink disabled:opacity-50"
                  >
                    {busy ? 'Revoking…' : 'Revoke'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
