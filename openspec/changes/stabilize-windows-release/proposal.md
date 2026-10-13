# Proposal

## Why

BUGS.md reports failed compilation on a Windows machine with several installed versions and duplicate tray icons/processes. Mixed PATH detection and a startup race in the pinned single-instance plugin make these reports plausible; release validation also repeatedly fails on browser timing and unnecessary Linux network-lab jobs.

## What Changes

- Resolve each system TeX distribution as one coherent, bounded-probed installation; prefer app-managed full LaTeX and skip broken system candidates.
- Add a desktop compiler-cache reset covering build artifacts, quick-compiler packages and browser TeX files, retaining documents, sessions and installed compilers.
- Close the Windows single-instance startup race and verify simultaneous launches, launches from another installed path, background reopening, worker crashes and update restart.
- **BREAKING**: an explicit Windows uninstall removes HiveTeX-owned per-user state, managed compilers, cached/local project replicas, credentials and login startup. Upgrade/uninstall-for-replacement preserves this state. External folders and unrelated TeX installations remain outside the cleanup boundary.
- Simplify required CI to Windows static checks, deterministic unit/native tests and packaged/installer checks. Keep timing-dependent browser/desktop diagnostics visible as warnings with logs; remove Linux/macOS test matrices and the scheduled Docker lab.
- Publish Windows v0.7.3 unless it already exists, in which case use v0.7.4; update master, retain signed updates and checked production deployment, and monitor all triggered workflows.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `compiler-provisioning`: coherent TeX selection and a complete, safe compiler-cache reset.
- `desktop-project-seeding`: concurrent/cross-version launches cannot create duplicate app or worker identities.
- `release-distribution`: Windows release/test scope, advisory diagnostics and complete explicit uninstall distinct from upgrades.

## Impact

Native TeX detection and filesystem maintenance; compiler account panel; Windows instance plugin; NSIS and MSI uninstall integration; Windows lifecycle/installer regression checks; GitHub Actions and release documentation. Existing spec requirements for three-platform releases are deliberately replaced by Windows-only distribution for this release. No user-specified external project folder or system-wide TeX distribution is removed.
