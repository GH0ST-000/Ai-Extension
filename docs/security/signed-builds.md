# Signed builds (Sigstore / cosign)

Project X uses **keyless cosign** in GitHub Actions for release integrity. No repository secrets or locally generated private keys are required for the default path.

## Threat model

- **Goal:** Prove that release checksums (and optionally SBOMs) were produced by a workflow running in this GitHub repository, not by an arbitrary machine.
- **Non-goals:** Code signing for Chrome Web Store packages (Google handles extension signing). Container image signing until we publish images to a registry (extend the same workflow with `cosign sign` on image digests).

## Keyless signing flow

1. **Trigger:** Push a version tag (`v*`) or publish a GitHub Release, or run [Release signing (cosign)](../../.github/workflows/release-sign.yml) manually (`workflow_dispatch`).
2. **Identity:** The workflow requests an OIDC token (`permissions.id-token: write`). Sigstore binds the signature to the GitHub Actions issuer and this repo’s workflow ref.
3. **Artifact:** For tags/releases, CI builds a `source-<tag>.tar.gz` from `HEAD` and writes `release-checksums.txt` (SHA-256). For manual runs, sign files matching the input glob (default `sbom-*.cdx.json`) or the checksum file stub.
4. **Sign:** `cosign sign-blob --yes` emits `.sig` and `.pem` (certificate chain) alongside the checksum file.
5. **Verify (consumers):**

   ```bash
   cosign verify-blob \
     --certificate release-checksums.txt.pem \
     --certificate-identity-regexp 'https://github.com/.+/\.github/workflows/release-sign\.yml@.+' \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com \
     release-checksums.txt \
     --signature release-checksums.txt.sig
   ```

   Adjust `certificate-identity` to match your org/repo if you fork.

## SBOM + signing together

1. Run or download artifacts from [Supply chain](../../.github/workflows/supply-chain.yml) (`cyclonedx-sbom-<sha>`).
2. Add SBOM paths to `release-checksums.txt` (or re-run supply-chain on the release commit and sign those files via `workflow_dispatch`).
3. Store SBOM JSON + cosign `.sig`/`.pem` with the release assets.

## Future: container images

When API/dashboard run as OCI images:

```yaml
- run: cosign sign --yes "${IMAGE}@${DIGEST}"
```

Use the same OIDC permissions; optionally add SLSA provenance with `actions/attest-build-provenance`.

## Operational notes

- **Rekor transparency log:** Keyless signatures are recorded in Sigstore Rekor; retain `.pem` for offline verification if Rekor is unavailable.
- **Forks:** Keyless signing should remain disabled on untrusted forks (default GitHub behavior for `workflow_run` / secret-less workflows).
- **No fake keys:** Do not commit cosign key pairs; use keyless or org-managed keys in GitHub Environments only if policy requires non-OIDC signing.
