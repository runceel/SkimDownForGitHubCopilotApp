# Contributing

## Trust model for the extension

`.github/extensions/**` is executable code after checkout. Treat every change below that path,
including documentation-looking JavaScript, CSS, HTML, and vendored files, as a code change.
Do not install or run an extension from an unreviewed external pull request on a workstation
that has access to credentials or private repositories.

The `main` branch must require a pull request, the `Verify vendored assets` status check, and
approval from the owner in `.github/CODEOWNERS`. Repository administrators should also enable:

- at least one approving review and code-owner review;
- dismissal of stale approvals and approval after the latest push;
- conversation resolution before merge;
- blocked force pushes and branch deletion.

GitHub does not configure these settings from files in the repository. The repository owner
must keep the branch protection or ruleset aligned with this section.

## Reviewing an external pull request

1. Inspect changes to `.github/workflows/**`, `.github/actions/**`, and
   `.github/extensions/**` before approving any workflow run.
2. Do not expose repository or environment secrets to fork workflows. This repository's
   verification workflow has read-only contents permission and uses no secrets.
3. Confirm that action references remain pinned to full commit SHAs.
4. For vendored changes, require an immutable source, updated component metadata, a focused
   asset diff, and a successful `Verify vendored assets` check.
5. Check out or install the extension only after the executable diff has code-owner approval.

## Updating vendored assets

Vendored files are reconstructed byte-for-byte from sources pinned in `vendor-lock.json`.
Most come from a SkimDown for Windows commit. A narrowly scoped security update may instead
pin an individual file to the dependency's immutable upstream commit. Never edit
`web/vendor/**` by hand.

1. Review the upstream SkimDown for Windows commit and copy its full 40-character SHA.
   For an independently updated file, review its official release and pin its immutable
   upstream commit URL in that file's `source` field.
2. From the repository root, run:

   ```console
   node .github/extensions/skimdown/scripts/vendor-assets.mjs refresh <commit-sha>
   ```

3. Update component versions, licenses, homepages, package URLs, and purls in
   `vendor-lock.json`. Update `THIRD-PARTY-NOTICES.md` when any component metadata changed.
4. Regenerate the SBOM after a metadata-only change:

   ```console
   node .github/extensions/skimdown/scripts/vendor-assets.mjs sbom
   ```

5. Inspect every changed asset, then verify both the working tree and the pinned source:

   ```console
   node .github/extensions/skimdown/scripts/vendor-assets.mjs verify --source
   ```

To restore the currently locked bytes without changing versions or hashes, run:

```console
node .github/extensions/skimdown/scripts/vendor-assets.mjs restore
```

`vendor-lock.json` is the byte-level inventory. `vendor-sbom.cdx.json` is the generated
CycloneDX dependency inventory. Both files are reviewed and committed with an update.

## Publishing a release

Releases use semantic version tags such as `v1.0.0`. A release tag must point to a reviewed
commit on `main` for which all required checks have passed.

1. Confirm the intended commit is present on `main` and the vendored asset verification passed.
2. Create and push a new annotated tag. Never move or reuse a published tag.

   ```console
   git tag -a v1.0.0 -m "SkimDown v1.0.0"
   git push origin v1.0.0
   ```

3. The `Release extension` workflow runs the tests and integrity checks, packages the complete
   `.github/extensions/skimdown` directory as `skimdown-<version>.zip`, writes its SHA-256
   checksum, and creates the GitHub Release.
4. Verify the release assets, then use the immutable tag in the public installation URL:

   ```text
   https://github.com/runceel/SkimDownForGitHubCopilotApp/tree/v1.0.0/.github/extensions/skimdown
   ```

If a published release needs a correction, create a new patch version instead of replacing its
tag or assets.
