# Align pnpm versions across the workspace and CI

## Summary

The daemon declares pnpm 11, while the frontend engine and mise configuration
require pnpm 10 and CI installs pnpm 10 for both jobs. Root scripts therefore
run different package-manager versions depending on which package and entry
point invoked them, creating avoidable lockfile and installation drift.

## Requirements

- Choose one supported pnpm major/version policy for the root, daemon, frontend,
  local mise environment, and CI.
- Declare the selected version consistently in package metadata and tool config.
- Keep each existing lockfile intentional, or adopt a workspace layout with a
  documented lockfile strategy.
- Ensure root setup/check/test/build commands use the selected version without
  relying on an ambient global pnpm.

## Acceptance Criteria

- Root, daemon, frontend, mise, and CI resolve the same pnpm version policy.
- Frozen-lockfile installation succeeds for both packages in a clean checkout.
- Root `setup`, `check`, `test`, and `build` run without engine/version warnings.
- Documentation names the supported Node and pnpm versions and matches CI.

## Notes

- Current references: `daemon/package.json:16`, `frontend/package.json:6-10`,
  `frontend/mise.toml:1-4`, and `.github/workflows/ci.yml:23-25`.

## Implementation

- Node `>=24 <25` and exact pnpm `11.5.2` are declared at root and in both
  packages; root and frontend mise configs plus all CI jobs select the same
  versions.
- Root scripts use `pnpm --dir` to run package-local setup, checks, tests, and
  builds under one selected executable.
- Daemon and frontend retain independent dependency lockfiles. The empty root
  importer lockfile is intentionally retained because pnpm root script
  invocation maintains it.
- Daemon direct and transitive Node typings resolve to Node 24 via the pnpm 11
  workspace override.
- Contributor documentation bootstraps with mise and does not depend on an
  ambient pnpm executable.

## Verification

- Frozen installation passes for the root, daemon, and frontend lockfiles under
  Node 24.18.0 and pnpm 11.5.2 without engine/version warnings or lockfile drift.
- Root `setup`, `check`, `build`, and `test` pass under the selected toolchain.
- Root test runs all 1,501 daemon tests and all 350 frontend Playwright tests.
- Two independent review rounds approved the final change with no findings.
- `git diff --check` passes.
