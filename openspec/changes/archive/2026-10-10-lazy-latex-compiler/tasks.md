# Tasks

## 1. Foundations

- [x] 1.1 Spike: confirm the SwiftLaTeX worker's synchronous XHR is intercepted by a service worker (Chromium, Firefox);
  results recorded in design.md (Chromium yes; Firefox no for worker XHR)
- [x] 1.2 Desktop `texcache` protocol for the in-browser engine: disk cache, safe paths, atomic writes, negative entries,
  upstream setting, stats/clear commands; verify Rust tests (hit/miss/negative/traversal refused)
- [x] 1.3 Managed downloads (D2): pinned table (Tectonic 0.17.0, TinyTeX v2026.10) with SHA-256, streaming download with
  progress, checksum check, safe extraction (zip, tar.gz, tar.xz, TinyTeX SFX), atomic install, remove, status; verify
  Rust tests (checksum mismatch refused, zip-slip refused, atomic swap) with local fixtures

## 2. Quick compiler (Tectonic)

- [x] 2.1 Tectonic backend (D3): untrusted compile into the existing pipeline, cache dir, engine mapping note,
  package-download events, detection of the managed install; verify Rust tests with a fake tectonic and a real
  `\usepackage{siunitx}` build on Windows
- [x] 2.2 Automatic set-up on first compile without TeX, *Download compiler now*, opt-out; desktop engine order (D1);
  verify a desktop e2e that compiles with no system TeX (test hook hiding PATH TeX) through the managed Tectonic

## 3. Full LaTeX (TinyTeX)

- [x] 3.1 Install/remove and detection (D4); verify Rust tests (detection order) and a manual install on Windows
- [x] 3.2 On-demand packages via tlmgr for the managed flavor only, loop guard, events; verify Rust tests with a fake
  tlmgr and a manual `\usepackage{tikz-cd}` build

## 4. Local compile helper

- [x] 4.1 Helper service (D5): loopback listener, origin allowlist + PNA preflight, pairing with in-app confirmation,
  tokens in the keychain, revoke, `/status`, `/compile` with limits and path validation; verify Rust tests (foreign
  origin refused, missing/invalid token refused, oversized body refused, compile through the native pipeline)
- [x] 4.2 Web helper engine and pairing UI: probe, pair, compile through it, advertise `native`; verify a Playwright
  test against a local helper (desktop app built with the helper) or a test double implementing the protocol

## 5. In-browser fallback and experience

- [x] 5.1 Web service worker cache for Chromium (D6), reachability gate before choosing the in-browser engine; verify a
  Playwright test with a local stand-in package server: second compile makes no requests
- [x] 5.2 Compiler state, status bar, failure messages, Account → Compiler panel (D7); verify svelte-check and e2e
  (state shown; "no compiler available" when nothing can compile)
- [x] 5.3 Docs (`docs/compilation.md`, README first-run notes), scheduled CI check of pinned release URLs and checksums;
  verify `make check`, CI and Desktop green
