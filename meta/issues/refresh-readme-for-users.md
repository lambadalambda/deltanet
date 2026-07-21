# Refresh the README for users

## Summary

Make the repository landing page a concise introduction to Headwater and move
the detailed development and operations reference under `docs/`.

## Requirements

- Put rolling desktop nightly download information near the top of the README.
- Explain Headwater's user-facing model and basic first-run/following workflow.
- Include a real example feed invite that visitors can use to try following.
- Add the supplied Headwater screenshot as the README's product image.
- Preserve existing development, container, security, testing, CI, migration,
  and repository reference material under `docs/`.
- Keep explicit warnings that nightlies are unsigned development builds and are
  not backups.

## Acceptance Criteria

- A GitHub visitor can understand the product, find nightly downloads, install
  or run it, and follow the example feed without reading developer internals.
- The root README links to the moved development documentation.
- Existing technical guidance remains available under `docs/` with working
  relative links.
- The screenshot is stored as a repository asset and renders from the README.

## Notes

- Rolling nightlies are published by `.github/workflows/nightly.yml` at the
  `nightly` GitHub prerelease.
