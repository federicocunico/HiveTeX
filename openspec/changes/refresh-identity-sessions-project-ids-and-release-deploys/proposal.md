# Proposal

## Why

HiveTeX needs a more distinctive icon, dependable sign-in across desktop restarts, and project names that do not compete for a global namespace. Publishing a desktop release must also update Vercel production reliably, so release distribution includes the browser app and control plane.

## What Changes

- Design a connected honeycomb H mark with amber and warm ivory on graphite, with a simplified small-size variant. Use one vector source for the web logo, favicon, desktop and installer icons.
- Make desktop session-token persistence and restoration reliable by awaiting credential-store operations, surfacing failures, and keeping saved sessions scoped to their server. Remember sign-in by default without saving passwords; preserve browser cookie sessions and the existing 30-day inactivity and revocation policy.
- **BREAKING**: New shared project creation accepts a readable name prefix and always assigns a server-generated random suffix, for example `projecttest-<random-suffix>`. A caller cannot reserve a plain-name share ID. Keep the existing request field usable by older clients as a prefix input, and return the actual generated ID.
- Permit multiple projects with the same prefix; enforce uniqueness with a database constraint and bounded retries. Retain existing unsuffixed IDs for lookup, joining, folders and existing members. New ID changes also use the convention so rename cannot bypass creation policy.
- Deploy stable published releases to Vercel from the exact tagged commit with successful CI, a reliable handoff from the Release workflow, production serialization, retry and deployment verification. Preserve existing master deploys and prevent stale release work from rolling production back. Drafts and prereleases do not deploy production.

## Capabilities

### New Capabilities

None; all four areas extend existing capabilities.

### Modified Capabilities

- `product-identity`: consistent, recognizable application mark across web and desktop surfaces.
- `user-accounts`: reliable remembered sessions, server isolation, credential-store failure feedback and restart/sign-out behavior.
- `project-access`: mandatory generated suffixes on newly assigned shareable IDs, duplicate prefixes, legacy compatibility and rename enforcement.
- `release-distribution`: stable-release production deployment, exact source selection, CI gating and visible deployment outcomes.

## Impact

- Branding: `apps/web/src/ui/Logo.svelte`, `apps/web/public/favicon.svg`, `apps/desktop/src-tauri/icons/source.svg`, generated bundle assets, `apps/desktop/app-icon.png` and Tauri bundle configuration.
- Sessions: `api.ts`, `auth.svelte.ts`, `secure.ts`, startup, server-choice UI and native credential commands; browser cookies remain the web transport.
- Projects: server create/update routes and validation; Projects, folder creation, import and local-publish UI; share/copy/settings flows and tests. Immutable internal `projects.id` already exists and stays intact; shareable `projects.slug` is the naming target. No bulk project migration is required.
- Delivery: Deploy/Release workflows, focused workflow/source-selection tests, setup/deployment documentation and release observability. Reuse existing Vercel secret and project variables.
- Out of scope: password storage on the PC, unlimited session lifetime, forced renaming of legacy projects, replacing local UUID identities, and a wider UI redesign.

## Approved Verification Follow-up

On 2026-10-13, the user approved moving clean installer icon inspection on Windows/macOS/Linux and a clean upgrade from an older installed version to release follow-up. Local automated checks and Windows restart/keychain verification remain implementation checks. This changes verification timing only; the product requirements and legacy compatibility remain unchanged.
