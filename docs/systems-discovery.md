# Systems relationship discovery

How Project X finds dependencies between the repositories of a system. Deterministic and
evidence-based: no AI, no code execution, no requests to URLs found in repositories.

## Pipeline

```
Refresh / Discover ─► workspace + system check ─► plan check ─► usage reservation (1 analysis,
one scan per user+system at a time) ─► scan each ENABLED repository ─► detect ─► match ─►
persist this user's rows ─► supersede stale rows ─► response (+ scan report) ─► commit usage
```

| Step | Code |
| --- | --- |
| Entry, plan + usage | `MultiRepoService.chargedDiscovery` / `charged` (`apps/api/src/multi-repo/multi-repo.service.ts`) |
| GitHub reads | `RepositoryScanner` (`apps/api/src/multi-repo/repository-scanner.ts`) |
| File selection | `planRepositoryScan` (`packages/shared/src/multi-repo/scan-plan.ts`) |
| OpenAPI | `extractOpenApiOperations` (`openapi-detect.ts`) |
| Server routes | `detectRouteDefinitions` (`route-detect.ts`) |
| HTTP calls | `detectHttpCalls` (`http-calls.ts`) |
| Paths | `normalizeHttpPath`, `httpPathsMatch` (`http-paths.ts`) |
| Manifest | `parseServiceDependencyManifest` (`manifest-detect.ts`) |
| Matching | `matchHttpDependencies` (`http-match.ts`) |

## What is read (per repository, default branch)

1. `GET /repos/{owner}/{repo}`: access check (personal GitHub token) and default branch.
2. `GET /repos/{owner}/{repo}/git/trees/HEAD?recursive=1`, plus the root tree when GitHub
   truncates the listing.
3. `GET /repos/{owner}/{repo}/git/blobs/{sha}` for the selected files only (4 at a time).

**Selected first:**
1. Root `package.json`, `README.md`, `service-dependencies.json`, and OpenAPI/Swagger files.
2. OpenAPI files up to two directories deep.
3. TypeScript/JavaScript under `src/`, `app/`, `lib/`, `server/`, `api/`, `routes/`, `services/`
   and `clients/`, with names such as client, api, service, route, controller, server, index or
   users ranked first.
4. Any other source, shallowest first.

**Never read:**
- directories `node_modules`, `dist`, `build`, `out`, `coverage`, `.next`, `vendor`, `generated`;
- test directories, `fixtures` and `examples`;
- `*.d.ts`, `*.spec.*`, `*.test.*`, minified and bundled files, and source maps.

| Limit | Value | Constant |
| --- | --- | --- |
| Files per repository | 24 | `MULTI_REPO_MAX_FILES_PER_REPO` |
| Files per analysis | 80 | `MULTI_REPO_MAX_TOTAL_FILES` |
| Bytes per file | 512 KB | `MULTI_REPO_MAX_FILE_BYTES` |
| Bytes per analysis | 4 MB | `MULTI_REPO_MAX_SCAN_BYTES` |
| GitHub requests per analysis | 150 | `MULTI_REPO_MAX_GITHUB_REQUESTS` |
| Tree entries considered | 20,000 | `MULTI_REPO_MAX_TREE_ENTRIES` |
| Suggestion access checks | 10 | `MULTI_REPO_MAX_CANDIDATE_LOOKUPS` |
| Manifest size | 64 KB | `MULTI_REPO_MAX_MANIFEST_BYTES` |
| OpenAPI operations per file | 80 | `MULTI_REPO_MAX_HTTP_OPS` |
| Relationships stored | 200 | `MULTI_REPO_MAX_RELATIONSHIPS` |

Every limit that cuts a scan short is reported, never silently ignored.

## Failure reporting (`scan` in both responses)

Each repository is reported as `complete`, `partial` (with issue counts) or `unavailable`.

| Code | Meaning |
| --- | --- |
| `repository_inaccessible` | 403 or 404 on the repository; marked unavailable |
| `token_invalid` | 401; **stops all further requests** in this analysis |
| `rate_limited` | 429, or 403 with `x-ratelimit-remaining: 0` / `retry-after`; **stops all further requests** |
| `github_error` | 5xx or network error |
| `tree_truncated` | GitHub (or the 20,000-entry cap) truncated the listing |
| `file_budget_reached` / `byte_budget_reached` / `request_budget_reached` | A budget cut the scan short |
| `file_too_large` | A relevant file is over 512 KB |
| `file_unreadable` | A selected file couldn't be read |
| `manifest_invalid` | `service-dependencies.json` isn't valid |

`unresolvedHttpCalls` counts calls that matched no provider, or more than one. When a whole
analysis can't start (no GitHub token, plan without Systems, usage limit, scan already running),
the request fails with an actionable error and no usage is charged.

## Detection capabilities

| Signal | Status | Notes |
| --- | --- | --- |
| OpenAPI 3 / Swagger 2 (YAML, quoted or unquoted keys, and JSON) | Supported | Top-level `paths:`, methods, and the `servers[0].url` / `basePath` prefix. Line-based reading; YAML is never deserialised |
| Express / Fastify-style routes | Supported | `app.get`, `router.get`, `.route().get()`, and routers mounted with `app.use('/prefix', router)` or a router **factory** `app.use('/prefix', createUsersRouter())`, from the same or an imported file. Routes of routers whose mount point can't be found are **not reported** (their full path is unknown) |
| NestJS controllers | Supported | `@Controller` prefix plus method decorators plus `setGlobalPrefix` |
| HTTP calls | Supported | `fetch`, injected fetch on `this` (`this.fetchImpl`, `this.fetch`), `axios.get/post/...`, `axios(config)`, `axios.request`, `http(Client).get`, `new URL(path, base)`. URLs built from literals, template literals, `+`, local and file-level constants, `process.env.X`, `import.meta.env.X`, `config.*Url`, `this.baseUrl`. **One level of request wrappers** in the same file: when a function's fetch URL is `base + <its parameter>` (e.g. `getJson(path)`), every call of that function is resolved, including endpoint maps (`ENDPOINTS.users`, `ENDPOINTS.userById(id)`). A parameter right after a `/` is a path segment (`/users/${id}` → `{param}`), not a wrapper. Default `fetch` method is GET |
| `service-dependencies.json` | Supported | Validated and size-bounded. Targets must be enabled, readable repositories of the same system. Repositories outside the system can only become suggestions (access-checked) |
| npm package dependencies | Supported | A dependency name equal to another system repository's root `package.json` `name` |
| Kafka topics | Partially supported | Decorators and producer calls in the scanned files |
| README / `package.json` repository links | Suggestions only | De-duplicated, then access-checked (at most 10) |
| TypeScript imports, Docker Compose, gateway configs, shared contracts | Not supported | |

## Matching and false-positive prevention

- **Normalisation:** `:id`, `{id}` and `${id}` all become `{param}`. Query strings, fragments,
  duplicate and trailing slashes are removed. Paths stay case-sensitive.
- **Path matching:** a provider parameter matches any consumer segment. A dynamic consumer
  segment never matches a literal provider route (`/users/{param}` ≠ `/users/me`).
- **Methods** must be equal, unless one side is unknown.
- **One provider only:** a call matching several repositories is ambiguous and yields no link,
  unless the consumer's manifest maps the call's base-URL variable (e.g. `USER_API_BASE_URL`)
  to one of them.
- **Generic endpoints** (`/health`, `/status`, `/metrics`, `/ping`, `/version`, …) never establish
  a relationship on their own.
- **Absolute URLs to external hosts** (anything but localhost) are never matched.
- **Direction** is always consumer → provider (`HTTP_CALLS`), plus `PROVIDES_API` on the
  provider for the matched endpoints only.

**Confidence** is decided by evidence quality only; a manifest never raises it by itself:

| Evidence | Confidence |
| --- | --- |
| A concrete call (known method) matched to a **uniquely identified** provider operation: OpenAPI or a mounted route, on a non-generic endpoint | high |
| Calls matched only through weaker evidence (unknown method), or attributed among several providers only because the manifest lists the endpoint | medium |
| Declared, and the code uses the declared base-URL variable, but no provider route or OpenAPI operation found | medium |
| Declaration only (shown as "not confirmed by provider routes or OpenAPI") | low |

**Ambiguity and conflicts:**
- **Ambiguous:** a call served by several system repositories is unresolved, unless the
  consumer's manifest base-URL variable or declared endpoint list names exactly one of them.
- **Conflict:** the manifest maps the call's base URL to repository A, but only repository B
  serves the endpoint. The call is reported as unresolved and attributed to neither.

Each endpoint is **one** row carrying every evidence record:
- the calling file and line (`http_call`, at the call site, e.g. `this.getJson(...)`);
- each provider record: the OpenAPI operation **and** the server route when both exist
  (`openapi_reference`, `http_call`);
- the declaration (`service_manifest`).

## Persistence and lifecycle

- **Rows are per user.** The upsert key includes `userId`, so another member's scan never
  modifies your rows (this was a confirmed bug before). No migration was needed: the table has
  no unique constraint.
- **Re-found rows** take the latest scan's confidence and evidence. Rows with `user_explicit`
  provenance are only re-validated, never overwritten.
- **Stale rows** are marked `superseded`, never deleted. This only happens after a **complete**
  scan of both repositories that no longer produces the finding. It never happens for partly
  read, unavailable or disabled repositories, other users' rows, or when the 200-relationship
  limit was hit. Superseded rows are excluded from analysis context and come back to `active`
  when the evidence returns.

## Security

- **What is read:** only `api.github.com` is called, with the user's own token. Owner and
  repository are URL-encoded, and blob SHAs from the tree are validated (`^[0-9a-f]{40,64}$`)
  before use. URLs found in code or manifests are never requested.
- **Repository content is untrusted text:** it's parsed with bounded scanners. No `eval`, no
  YAML deserialisation, no execution.
- **Access:** manifests can't create relationships to repositories outside the system, disabled
  repositories, or repositories the user can't read. Suggestions are de-duplicated before access
  checks and capped.
- **Logs:** counts only (repositories, requests, partial flag); never tokens or file content.
- **Workspace isolation:** systems are resolved inside the caller's workspace before anything is
  reserved or read.

## Manual QA with the private test repositories

Real GitHub. This uses two analyses from the workspace's monthly usage.

1. A team-plan workspace, with your personal GitHub token (with access to both private
   repositories) connected in **Settings**.
2. Open the system **Test Microservices** and make sure both `gh0st-000/project-x-test-api` and
   `gh0st-000/project-x-test-client` are enabled.
3. Click **Refresh analysis**. Expect:
   - "2 repositories analyzed";
   - relationships `gh0st-000/project-x-test-client → gh0st-000/project-x-test-api`, at least
     `GET /api/users` and `GET /api/users/{param}`;
   - evidence naming the client source file and line, the API's OpenAPI or route file, and
     `service-dependencies.json`.
4. If the result says a repository was only partly read, the listed reason tells you why: check
   the token's repository access or the rate limit.
5. Click **Discover relationships**. The same relationships appear, with no duplicates, and the
   usage line drops by one.
6. Optional: in a branch of the client repository, remove the `getUser` call and merge it to
   the default branch. After **Refresh**, `GET /api/users/{param}` shows **Superseded**.
7. If 0 relationships are found, the result's notes show how many HTTP calls couldn't be
   matched. Compare the client's calls and the API's routes with the capabilities above.

## Known limitations

- **Default branch only;** at most 24 files per repository (large repositories are partly read
  and reported as such).
- **Routes and calls built dynamically** across files (factories, wrappers, routers mounted more
  than 4 levels deep) may be missed.
- **Kafka matching** is unchanged and limited to the scanned files.
- **Rows are per user,** so teammates each need to run their own analysis to see relationships.

## Contract change impact (Phase 1, deterministic)

**Contract diff** (`apps/api/src/openapi/lib/diff.ts`):
- **Canonical operations:** `GET /users/{id}` equals `GET /users/{userId}` and `/users/:id/`. Renaming a path parameter is not a change, and a renamed required path parameter isn't a new required field. Methods and segments stay distinct.
- **Nested response fields** are compared by stable paths (`users[].name`, `user.address.city`, `[].id`), through `$ref`, arrays and `allOf`. Recursive and truncated schemas are bounded, and never produce a type-change claim.
- **Classification:**
  - removed field or type change: breaking;
  - added field: non-breaking (`added-response-field`);
  - required → optional, or became nullable: uncertain;
  - response enum value added: uncertain; response enum value removed: non-breaking (request enums keep the old rules).
- **Reporting:** only the topmost removed or added field is reported. Documentation-only edits produce nothing.

**Downstream impact** (`computeDownstreamImpact`, `packages/shared/src/multi-repo/downstream-impact.ts`), a pure function:
- **Inputs:** breaking changes on an operation × **active `HTTP_CALLS`** rows consumer → changed provider, with the same method and canonical path. Provider self-rows, superseded rows, other directions and files are never used.
- **Consumers** are de-duplicated across systems, keeping the strongest confidence, the evidence (call site, contract or route, declaration) and the last validation time (stale after 14 days).
- **Wording:** "potentially affected" (field usage isn't checked). "No known consumers" is **not** a statement of safety.
- **Confidence** equals the relationship's confidence.

**Scoping** (`MultiRepoService.computeContractDownstreamImpact`, internal, no route yet):
- systems of the caller's workspace with the provider enabled;
- only the caller's own rows;
- only consumers enabled in that system.

No GitHub calls and no usage charge. Revoked GitHub access isn't re-checked here (Phase 2 should).

**`analyzeChangeImpact` changes:**
- **Downstream only:** only repositories that depend on the changed one are considered.
- **HTTP matching** uses canonical method and path from patch routes or the summary (no substrings, no file names). Without a verified contract diff, such a match is reported as risk `HTTP_CONTRACT_IMPACT_UNVERIFIED`, and in `unaffectedOrNotEvident` with "contract impact not verified", never as "requires change: yes".
- **Kafka and package matching** is unchanged.

## PR Review integration (Phase 2)

Every PR Review (`REVIEW_ENTIRE_PR`) now includes a deterministic **Downstream Impact** analysis, with no AI and no extra usage.

1. **Changed contracts:** taken from the trusted PR file list: OpenAPI/Swagger paths, including a renamed file's previous path. At most 3 are compared. If none changed, no GitHub request is made and the status is `not_analyzed` (no section is shown).
2. **Reading contracts:** `PullRequestDiffService.fetchFileAtRef` reads the base and head versions at the PR's **immutable** `base.sha` and `head.sha`, with the same workspace credentials as the diff.
   - **Limits:** 1.5 MB per document, 10 s per request.
   - **Failures are categorised:** 404, 403, 429, too large.
   - **Added file:** additions only. **Deleted file:** not treated as removal (`contract_deleted`). **Page-fallback diff:** `unverified_shas`.
3. **Diff and graph:** the Phase 1 diff, then `ContractImpactService.computeForProvider` over the reviewer's authorised graph: workspace Systems containing the enabled provider, the reviewer's own active `HTTP_CALLS` rows, and enabled consumers only.
4. **Consumer re-authorisation:** each consumer is checked with the **reviewer's personal GitHub token**, never the workspace App and never another user's token. Checks are bounded (10, 4 concurrent). Anything not verified is **removed** (name, paths and evidence), leaving only a count (`consumers_withheld`, `no_personal_token`, `access_check_unavailable`).
5. **Isolation:** the analysis runs in parallel with the AI batches, with a 45 s deadline and review cancellation. It never fails the review: errors become `unavailable`.

**Output:**
- **Live response:** a `## Downstream Impact` Markdown section **before** `## Summary`. Older extensions ignore it; the current extension shows it in the report panel but never in GitHub review drafts.
- **Review History:** the structured result is stored in `snapshot.downstreamImpact` (bounded, schema version unchanged). The shared report Markdown **never** contains consumer names.
- **Reading history** re-verifies every consumer with the **viewer's** own token and redacts what can't be verified. These are access checks only: no contract reads, no AI, no charge.
- **Statuses:** `verified`, `partial`, `no_known_consumers` (not "safe"), `no_system`, `compatible`, `unavailable`, `not_analyzed`.

**Manual end-to-end test with the private repositories:**
1. In `project-x-test-api`, push branch `breaking/display-name` with `fixtures/breaking-change-displayName.patch` applied, and open a PR.
2. Make sure **Test Microservices** has a recent Refresh, and that your personal GitHub token can read both repositories.
3. Run **Review entire PR** from the extension on that PR. Expect a "Downstream impact" block: `GET /api/users` (`users[].name` removed) and `GET /api/users/{id}` (`user.name` removed), both naming `gh0st-000/project-x-test-client` with High confidence. `GET /health` should not appear.
4. Open the review in **Review history** on the dashboard and confirm the same section appears.
