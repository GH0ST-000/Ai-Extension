# Systems (`/app/systems`)

Group GitHub repositories that work together into a **system**. Project X can then find
**relationships** (dependencies) between them and suggest other repositories that may belong in
the system.

| Term         | Meaning                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| Repository   | One GitHub repository you can access through your GitHub connection.            |
| System       | A named group of repositories with one primary repository.                      |
| Relationship | A dependency found between two repositories in a system, with evidence.         |
| Suggestion   | A repository outside the system that may be related. Never added automatically. |

## User journey

**Before:**

- A permanent three-field form (name, owner, repository) sat at the top of the page.
- The selected system was a dropdown with three equal-weight buttons. **Delete ran
  immediately, with no confirmation.**
- Repositories were edited through an always-visible inline form.
- Refresh showed one technical sentence ("analyzed 1, checked 0 relationships").
- Empty sections said only "No pending candidates."

**After:**

1. **Header:** what Systems are for, plus a three-term glossary (repository, system, relationship).
2. **No systems:** one empty state with **Create system**, and no form until the user asks for one.
3. **Create system** (dialog): system name and primary repository. The repository field accepts
   `owner/repo` or any GitHub URL (`https://github.com/acme/web`, `.git`, or a PR link); it's
   validated locally with examples, then the API verifies access.
4. **Selected system card:**
   - name, primary repository, repository count, and when relationships were last validated
     (only if the API returned a validation time);
   - a selector when there are several systems;
   - actions: **Refresh analysis**, **Discover relationships**, **System settings**;
   - an accurate explanation of both analyses (see "Refresh vs Discover"), plus a usage line:
     "each Refresh or Discover counts as one analysis toward your workspace's monthly limit.
     Viewing saved relationships is free", followed by "N of M left this month" when the plan
     has a limit. When none are left, both are disabled with a **Plan & usage** link. Usage is
     re-read after every scan.
   - Plans without multi-repository analysis see an upfront notice; **Create system**,
     **Refresh** and **Discover** are disabled (the API still enforces it).
5. **Overview cards:** repositories (and how many are enabled), known relationships, pending
   suggestions, unavailable repositories. Suggestions and unavailable repositories show **"—"**
   until an analysis has run in this visit; the page doesn't invent a 0.
6. **Repositories:**
   - one row per repository, showing role, Primary and Disabled badges, and where it came from
     (manual, suggestion, Project Memory);
   - an **Analyze** switch and a role selector on each row;
   - **Remove** asks for confirmation first; the primary repository can't be disabled or removed;
   - **Add repository** opens a dialog, which rejects duplicates locally.
7. **Relationships:** source → target, type in plain words, the resource (e.g.
   `POST /v1/payments`), a confidence badge, a status badge when not active, and collapsible
   evidence (provenance type, file and summary).
8. **Suggested repositories:** relationship, confidence and collapsible "Why this was
   suggested".
   - **Add to system** asks the existing API to add the repository (`source: deterministic_link`).
   - **Dismiss** hides it for this visit only.
   - "Not recommended" suggestions can't be added.
9. **System settings** (dialog): rename. **Delete system…** only reveals a confirmation step;
   **Yes, delete system** actually deletes. Destructive actions never sit next to the analysis
   buttons.

## Reading analysis results

| Result                                         | What the user sees                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Running                                        | Indeterminate spinner and an explanation. Every analysis and change button is disabled; double clicks are ignored. No fake percentage, because the API reports no progress |
| `analyzed: 1, relationshipsChecked: 0, candidates: []` | **Analysis completed:** "1 repository analyzed. No relationships found." plus "This system currently contains one repository…" and an **Add repository** action |
| Relationships or suggestions found             | Counts in plain words, e.g. "3 relationships found. 2 related repositories suggested for review."                                                          |
| `unavailable` not empty                        | **…with warnings**, listing the repositories that couldn't be analyzed and suggesting a GitHub access check                                                |
| `truncated: true`                              | **…with warnings** and **Partial results**: what's shown is accurate but may be incomplete                                                                 |
| Failure                                        | Error callout with a specific next step: plan, usage limit, GitHub settings, or **Try again** (only for transient errors such as 5xx or GitHub unreachable) |

The raw API response is kept under a collapsed **Technical details** section.

## Reliability

- One operation at a time: a synchronous lock plus disabled buttons.
- Each result belongs to the system and workspace it was started for. Switching system,
  switching workspace or leaving the page discards late responses.
- Switching workspace reloads the list and clears selection, results, suggestions and dialogs.
  The page never changes the active workspace itself.

## API contracts reused

No backend change. All calls go through existing `lib/api.ts` helpers:

- `GET /systems`, `POST /systems`, `PATCH /systems/:id` (rename), `DELETE /systems/:id`;
- `POST /systems/:id/repositories`, `PATCH|DELETE /systems/:id/repositories/:owner/:repo`;
- `POST /systems/:id/refresh`, `POST /systems/:id/relationships/discover`,
  `GET /systems/:id/relationships`;
- `GET /settings/github` (`getGithubConnection`), which shows the "Connect GitHub" notice.

## Known API limitations

- **No repository picker.** There's no endpoint that lists the user's GitHub repositories, so
  entry stays manual (owner/repo or URL). The API verifies access when adding.
- **Personal GitHub token required.** Access checks use the user's personal GitHub connection;
  the workspace GitHub App doesn't count.
- **No stored analysis history.** Suggestions, unavailable repositories and the last result
  exist only for the current visit. The page shows the latest relationship validation time when
  the API provides one.
- **Dismissed suggestions aren't saved.** There's no endpoint for it, so dismissals last for the
  visit only.
- **Relationships are per user.** The API lists only the relationships the signed-in user
  discovered, so teammates may see different relationship lists for the same system.
- **At most 200 relationships** are returned (`MULTI_REPO_MAX_RELATIONSHIPS`).
- **Usage:** every fresh scan (Refresh or Discover) is charged one `multi_repo_analysis`
  (monthly). Reading saved relationships is free. A second scan of the same system by the same
  user while one is running is rejected ("An analysis is already running").

## Refresh vs Discover

Both endpoints run the same scanner (see `docs/systems-discovery.md`), pass the same workspace,
system, plan (`MULTI_REPO_INTELLIGENCE`) and usage checks, and save the relationships they find.

| | Refresh analysis (`POST /systems/:id/refresh`) | Discover relationships (`POST /systems/:id/relationships/discover`) |
| --- | --- | --- |
| Returns | counts, suggestions, unavailable repositories, truncated, `scan` | full relationship list, suggestions, truncated, `scan` |
| Plan check | yes | yes |
| Counts toward usage | yes, 1 per run (refunded if the scan fails) | yes, 1 per run (refunded if the scan fails) |

`relationshipsChecked` is the number of **active** relationships after the scan, so the UI says
"N relationships found". `scan` (additive) lists, per repository, whether it was read
completely, partly (with reasons) or not at all, plus HTTP calls that could not be matched.

## Manual QA

1. A workspace with no systems shows **Create your first system**; nothing else is on screen.
2. **Create system** with empty fields shows both inline errors. Enter
   `https://github.com/<you>/<repo>.git` and the system is created and selected.
3. Without a personal GitHub connection, the "Connect GitHub to use Systems" notice appears.
   Creating a system shows **Repository not accessible** with a **GitHub settings** link.
4. **Refresh analysis** on a one-repository system: "Analysis completed — 1 repository analyzed.
   No relationships found." plus the add-repository guidance. **Technical details** is collapsed.
5. Double-click **Refresh analysis**: only one request is sent (check the Network tab), and the
   buttons stay disabled while it runs.
6. Add a second repository. Entering the primary again shows "already in this system".
7. **Discover relationships:** relationships show type, confidence and evidence. Suggestions can
   be added or dismissed.
8. Start a refresh, switch to another system immediately: no result appears on the new system.
9. Switch workspace from the sidebar: the list reloads and earlier results disappear.
10. **Remove** a repository: a confirmation appears first.
11. **System settings → Delete system…** shows a confirmation; **Keep system** cancels; **Yes,
    delete system** deletes.
12. Check Light, Dark and Auto themes; then check at about 375px width (cards stack, no
    horizontal scroll).
13. With the workspace at its monthly analysis limit, **Discover relationships** is disabled and
    "No analyses left this month" links to **Plan & usage**; **Refresh analysis** still works.
14. On a phone, **Refresh analysis** brings the result into view when it finishes.
15. Keyboard: Tab through the page. Every button shows a focus ring, and opening a form dialog
    focuses its first field.
