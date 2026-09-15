# Chrome extension release & reproducible builds

Checklist and build steps for shipping `@project-x/extension` (Plasmo) to the Chrome Web Store while keeping supply-chain risk visible.

## Pre-submit review checklist

| Area | Check |
| --- | --- |
| **Permissions** | Manifest `permissions` / `host_permissions` match [extension-permissions.md](./extension-permissions.md); no broad `<all_urls>` unless justified. |
| **CSP** | `content_security_policy.extension_pages` blocks inline/eval; no remote script in extension pages. |
| **Secrets** | No API keys, GitHub/Jira tokens, or Paddle secrets in the bundle ([security-baseline.md](./security-baseline.md) #3). |
| **Network** | Production builds point at the correct `PLASMO_PUBLIC_*` API base URL; localhost hosts only in dev builds. |
| **Privacy** | Store listing text matches actual data collection (auth, error reports, provider calls). |
| **Version** | `package.json` / manifest version incremented; changelog notes user-visible changes. |
| **Audit** | `pnpm audit --audit-level=high` reviewed; extension transitive findings documented in [dependency-audit.md](./dependency-audit.md). |
| **SBOM** | CycloneDX artifact from CI archived with the release (see [signed-builds.md](./signed-builds.md)). |

## Reproducible `plasmo package` steps

Use the same toolchain as CI so two clean checkouts produce identical zip bytes (modulo timestamps embedded by Plasmo/Chrome — document any known drift).

1. **Clone at the release tag** (detached HEAD):

   ```bash
   git fetch --tags
   git checkout vX.Y.Z
   ```

2. **Node + pnpm versions** (pinned):

   ```bash
   nvm install   # reads repo root .nvmrc (Node 20)
   nvm use
   corepack enable
   corepack prepare pnpm@9.15.0 --activate
   ```

3. **Install from lockfile only:**

   ```bash
   pnpm install --frozen-lockfile
   ```

4. **Production env** (example — set to your release API):

   ```bash
   export PLASMO_PUBLIC_API_URL=https://api.example.com
   export NODE_ENV=production
   ```

5. **Clean build + store zip:**

   ```bash
   pnpm --filter @project-x/extension run clean
   pnpm --filter @project-x/extension run build
   pnpm --filter @project-x/extension run package
   ```

   Output: `apps/extension/build/chrome-mv3-prod.zip` (Plasmo default).

6. **Record hashes:**

   ```bash
   shasum -a 256 apps/extension/build/chrome-mv3-prod.zip
   ```

7. **Compare with CI:** Download the extension build artifact from the release commit’s Supply chain workflow run and diff hashes. If they differ, compare Node/pnpm versions, env vars, and lockfile integrity first.

## Determinism notes

- **Lockfile:** `pnpm-lock.yaml` at repo root is authoritative; never publish from `pnpm install` without `--frozen-lockfile`.
- **Overrides:** Root `package.json` `pnpm.overrides` affect the entire graph; document changes in `dependency-audit.md`.
- **Plasmo / Parcel:** Build tooling may embed build time or absolute paths in source maps inside the zip; Chrome Web Store re-packages and signs the upload — bitwise reproducibility across machines is a goal, not a guarantee until Plasmo major upgrades land.
- **OS:** CI uses `ubuntu-latest`; local macOS builds may differ slightly. Prefer Linux (or the CI artifact) for the canonical store upload.

## Chrome Web Store upload

1. [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole) → extension → **Package** → upload `chrome-mv3-prod.zip`.
2. Complete **Privacy** practices and **Justification** for each permission/host pattern.
3. Attach release notes; link privacy policy if collecting account/diagnostics data.
4. After approval, tag the git release with the store version and attach SBOM + cosign signatures from CI.
