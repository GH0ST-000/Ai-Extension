# Dependency audit policy

## Commands

```bash
pnpm audit --audit-level=high
pnpm audit --audit-level=critical
```

CI runs `pnpm audit --audit-level=high` with `continue-on-error: true` on the main CI workflow so transitive noise does not block every PR; release owners must review findings before shipping.

Supply-chain CI also generates CycloneDX SBOMs per app — see [`.github/workflows/supply-chain.yml`](../../.github/workflows/supply-chain.yml).

## Release-blocking policy

Block private beta / production if:

- Critical/high vulnerability in a **direct** production dependency that is exploitable in our trust model
- Known dangerous extension dependency with remote code execution / prototype pollution in our call path
- Unfixed auth/crypto package issues without compensating controls

## Mitigations applied (supply-chain item #6)

pnpm overrides at repo root (see `package.json`) to lift transitive packages where semver-compatible:

| Override | Rationale |
| --- | --- |
| `multer >= 2.3.0` | Nest platform-express DoS |
| `@babel/traverse >= 7.23.2` | Plasmo prettier plugin |
| `msgpackr`, `content-security-policy-parser`, `svgo`, `browserslist` | Plasmo / Parcel build graph |
| `glob`, `picomatch`, `tmp`, `brace-expansion@*` | `@nestjs/cli` dev toolchain |
| `lodash >= 4.18.0` | `@nestjs/config` runtime merge helper |
| `sharp >= 0.35.4`, `postcss >= 8.5.22` | Next / Plasmo image & CSS pipeline |
| `undici` | Pin `^7.29.0` (not `>=7.29.0`) — `>=` resolved to undici 8 and broke jsdom’s `wrap-handler` import used by extension Vitest |
| `brace-expansion` (1.x / 2.x / 5.x pins) | eslint / Nest CLI minimatch chains |
| `deepmerge-ts >= 8.0.0` | Prisma config CLI (verified `prisma generate`) |

Re-run after overrides:

```bash
pnpm install
pnpm audit --audit-level=high
```

## Latest high audit (item #6)

After overrides and lockfile refresh:

```bash
pnpm audit --audit-level=high
# 0 high (22 moderate, 8 low — mostly dev/build tooling)
```

Moderate findings are tracked via Dependabot; triage before major releases.

## Deferred / monitor

| Package / area | Severity | Exposure | Mitigation | Reason deferred |
| --- | --- | --- | --- | --- |
| Moderate Plasmo / Parcel / Nest CLI transitive | moderate | Build-time devDependencies | Overrides for known critical/high paths; SBOM in CI | Major toolchain upgrades need dedicated QA |
| `vite` / `esbuild` peer mismatch (extension) | n/a | Extension Vitest only | Monitored | Plasmo pins older esbuild |

## Dependabot

`.github/dependabot.yml` opens weekly PRs for npm and GitHub Actions. No auto-merge.

## Related docs

- [signed-builds.md](./signed-builds.md) — keyless cosign on tags/releases
- [extension-release.md](./extension-release.md) — Chrome Web Store + reproducible `plasmo package`
