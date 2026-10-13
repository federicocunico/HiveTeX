# Tasks

## 1. Compiler selection and cache recovery

- [x] 1.1 Select a coherent working TeX bin directory with bounded probes and managed TinyTeX preference; verify failed/hung/mixed PATH fixtures and existing compile regressions.
- [x] 1.2 Add serialized complete compiler-cache reset, actionable failures and account-panel controls; verify preserved project/compiler fixtures, busy rejection and frontend type checks, and document cache recovery.

## 2. Single-instance lifecycle

- [x] 2.1 Patch the pinned Windows instance handshake to wait with a deadline and always reject duplicate startup; verify deterministic delayed-primary and burst/cross-path launch regressions.
- [x] 2.2 Verify bounded worker crash recovery, background reopen and update restart leave one app/worker; record automated Windows lifecycle evidence and limits in documentation.

## 3. Complete Windows uninstall

- [x] 3.1 Implement scoped maintenance cleanup of app-owned data, credentials and autostart without a GUI; verify cleanup fixtures, reparse-point isolation and idempotence.
- [ ] 3.2 Integrate explicit-uninstall cleanup into NSIS and MSI while preserving upgrade data; verify both installer types and upgrade paths with isolated Windows installer checks, and document explicit uninstall data removal.

## 4. Windows CI and release preparation

- [x] 4.1 Simplify required CI/Desktop checks to Windows and move timing-dependent UI/network diagnostics to explicit warnings with artifacts; verify workflow configuration, policy tests and warning behavior.
- [ ] 4.2 Run Windows build/lint/type/unit/native regressions and packaged checks, fix deterministic failures and record results; set the unused v0.7.3 (or v0.7.4) consistently and verify source versions and release notes.

- [ ] 4.3 Accept verified legacy Vercel CLI commit metadata and use project-scoped API delivery; verify immutable source, project/SHA rejection, staged promotion regressions and a successful checked deploy.

## Workflow follow-up

- Sync delta specs and archive after tracked implementation and verification tasks are complete.
- Commit/push master and monitor triggered CI/Desktop/deployment workflows to a terminal state; fix failures.
- Tag/push the prepared version only after required checks pass; monitor installer publication and production deployment, verify public assets and report release readiness.
