# GitHub / Jira permission review (Day 29)

## Current model

Project X does **not** use a GitHub App or OAuth App for user login.
Users paste a **personal access token (classic or fine-grained)** in dashboard Settings.

Jira uses a **Jira Cloud API token** + email + site host (read-only Day 17–29).

## Least privilege guidance (product UX)

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

## Provider access ≠ workspace access

Workspace membership does not grant another member’s GitHub/Jira credentials.
Each user connects their own token; server decrypts only for that userId.

## Jira

Scopes used: read issue/comment/project metadata via REST.
Day 29 keeps Jira **read-only** — no issue transitions or comments from Project X.
