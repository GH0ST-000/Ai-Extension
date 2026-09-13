# Dependency audit policy (Day 29)

## Commands

```bash
pnpm audit --audit-level=high
pnpm audit --audit-level=critical
```

CI runs `pnpm audit --audit-level=high` with `continue-on-error: true` so transitive noise does not block all PRs,
but release owners must review findings before Day 30.

## Release-blocking policy

Block private beta if:

- Critical/high vulnerability in a **direct** production dependency that is exploitable in our trust model
- Known dangerous extension dependency with remote code execution / prototype pollution in our call path
- Unfixed auth/crypto package issues without compensating controls

## Day 29 actions taken

- Upgraded `next` to `15.5.24` (fixes critical Image Optimization / Windows RCE advisories)
- pnpm overrides:
  - `multer >= 2.3.0` (Nest platform-express DoS advisories)
  - `@babel/traverse >= 7.23.2` (Plasmo prettier plugin transitive)

## Deferred findings

| Package | Severity | Exposure | Mitigation | Reason deferred |
| --- | --- | --- | --- | --- |
| Remaining high/moderate transitive (Plasmo/Parcel/Nest graph) | high/moderate | Mostly build-time / non-network paths; not direct product code | Overrides for criticals; Dependabot weekly PRs | Full Plasmo major upgrade risks breaking extension build; Nest major upgrade out of Day 29 scope |
| `vite` peer / `svgo` peer warnings | n/a | Extension build tooling | Monitored | Plasmo pins older toolchain |

Re-run `pnpm audit --audit-level=critical` before Day 30 — must remain clean.

## Dependabot

`.github/dependabot.yml` opens weekly PRs for npm and GitHub Actions.
No auto-merge.
