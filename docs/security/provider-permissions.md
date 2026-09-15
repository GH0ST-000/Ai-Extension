# GitHub / Jira permission review

## GitHub access models

Project X supports two GitHub credential paths for server-side API calls:

1. **Workspace GitHub App (preferred for teams)** — install the Project X GitHub App on a user or organization. The API mints **short-lived installation access tokens** on demand (RS256 app JWT → `POST /app/installations/{id}/access_tokens`). We **do not** store installation tokens in the database.
2. **Personal access token (fallback)** — each user can still paste a **classic or fine-grained PAT** in dashboard Settings. Used when the workspace has no active App installation, or for solo/dev flows.

### Token preference (server)

For authenticated API calls that reach GitHub:

- If `X-Workspace-Id` resolves to a workspace with an **active** GitHub App installation **and** the server has GitHub App env configured → use an **installation token**.
- Otherwise → decrypt and use the **acting user's PAT** (existing Settings flow unchanged).

Workspace membership does **not** grant another member's PAT. The App installation is **workspace-scoped**; PATs remain **user-scoped**.

### GitHub App permissions (least privilege)

Configure the GitHub App with only what Project X uses today:

| Capability | GitHub App permission |
| --- | --- |
| Read repo metadata / PR / files / checks | **Metadata** (read-only, automatic) + **Contents** (read) + **Pull requests** (read) + **Checks** (read) |
| Post PR comments & reviews | **Pull requests** (read & write) |
| Apply patch (commit to PR head) | **Contents** (read & write) |

**Not requested / not used:**

- Administration, organization administration, workflows write, secrets, delete repositories

### PAT guidance (fallback)

Documented for users in shared GitHub trust copy:

| Capability | Needed scopes / permissions |
| --- | --- |
| Read PR / files / checks | `repo` contents + pull requests read (or fine-grained: Contents + Pull requests + Checks read) |
| Post comment | Pull requests: Read and write |
| Submit review | Pull requests: Read and write |
| Apply patch (commit to PR head) | Contents: Read and write on the head repository |

**Not requested / not used by Project X:**

- Administration
- Workflows write
- Organization administration
- Delete repositories
- Secrets management

### API surface (GitHub App)

| Endpoint | Purpose |
| --- | --- |
| `POST /api/workspaces/:id/integrations/github-app/install` | Returns GitHub install URL + opaque `state` |
| `GET /api/integrations/github-app/setup` | GitHub setup URL callback (links installation → workspace) |
| `POST /api/webhooks/github-app` | Installation lifecycle (`created`, `deleted`, `suspend`, …) |
| `GET /api/workspaces/:id/integrations/github-app/status` | Workspace installation status (no secrets) |
| `DELETE /api/workspaces/:id/integrations/github-app` | Disconnect (best-effort GitHub uninstall + mark removed) |

User PAT connect/disconnect remains **`/api/settings/github`** (unchanged).

## Jira

Jira uses a **Jira Cloud API token** + email + site host (read-only).

Scopes used: read issue/comment/project metadata via REST.
Project X keeps Jira **read-only** — no issue transitions or comments from Project X.

## Provider access ≠ workspace access

Workspace membership does not grant another member’s GitHub/Jira credentials.
Each user connects their own Jira token; GitHub PATs are per-user. GitHub App installs are per-workspace.
