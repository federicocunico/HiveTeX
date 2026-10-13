# Spec Delta

## ADDED Requirements

### Requirement: Production deployment after stable publication
Publishing a stable HiveTeX release SHALL automatically initiate deployment of the web app and control plane to Vercel production. This SHALL work for releases published by the existing automated Release workflow and releases published manually. Drafts, prereleases and failed installer publication SHALL NOT initiate production deployment. Existing successful-CI deployments from master SHALL remain supported.

#### Scenario: Automated release publication
- **WHEN** the Release workflow publishes a stable version after the required installer assets are available
- **THEN** production deployment is initiated without maintainer action even though publication uses the built-in automation token

#### Scenario: Manual stable publication
- **WHEN** a maintainer publishes a stable version release manually
- **THEN** production deployment for that release is initiated under the same checks

#### Scenario: Draft or prerelease
- **WHEN** a release remains a draft, has a prerelease suffix, or is marked as a prerelease
- **THEN** it does not trigger a production deployment

#### Scenario: Publication failed
- **WHEN** installer checks or release publication fail
- **THEN** no release-driven production deployment is initiated and the release run reports the failure

### Requirement: Checked release source
A release-driven production deployment SHALL use the immutable commit resolved from its validated version tag and SHALL require successful CI for that exact commit. A missing or failing CI result SHALL block production changes with an actionable failure. Deployment SHALL NOT substitute a branch tip or the workflow runner's default commit for the release source.

#### Scenario: Master advances after tagging
- **WHEN** tag `v1.2.3` identifies commit A and master advances to B
- **THEN** a permitted release deploy uses A rather than silently deploying B

#### Scenario: CI missing or failed
- **WHEN** the release's exact source commit has no successful CI result
- **THEN** deployment waits for an applicable running check up to a bounded timeout or fails with a clear recovery instruction, and production remains unchanged

#### Scenario: Tag mismatch on retry
- **WHEN** a retry finds that the release tag no longer resolves to the recorded source commit
- **THEN** it refuses deployment and reports the mismatch

### Requirement: Ordered and repeatable production changes
All automated production deploys SHALL be serialized and SHALL recheck eligibility before changing production. A release deploy SHALL not replace a production commit that is a known newer descendant, and an older stable version SHALL not replace a newer published version. Duplicate notifications and retries for the same tag and commit SHALL be safe. A skipped stale deployment SHALL report its reason.

#### Scenario: Newer master is already deployed
- **WHEN** a release's commit is an ancestor of the current successful production commit
- **THEN** the release deploy is skipped with a message that production already contains newer code

#### Scenario: Repeat deployment notification
- **WHEN** the same release is delivered twice after its source is successfully deployed
- **THEN** the second run verifies or safely skips the existing result without rolling production back

#### Scenario: Old release published late
- **WHEN** a lower stable version is published after a newer stable release
- **THEN** it does not replace the newer production version

### Requirement: Verifiable production outcome and recovery
A production deploy SHALL report the source commit, release tag when applicable, deployment URL and terminal outcome. It SHALL verify the newly created deployment and the production target rather than treating a healthy previous deployment as success. Deploy or migration failures SHALL fail the run with useful logs. Maintainers SHALL be able to retry a failed release deployment without rebuilding or republishing installers.

#### Scenario: Release and production succeed
- **WHEN** publication and Vercel deployment finish successfully
- **THEN** the deployment summary identifies the release, source commit, Vercel deployment and verified production target

#### Scenario: Vercel upload or build fails
- **WHEN** a release is published but production deployment fails after bounded retries
- **THEN** the installers remain published, the deploy run fails visibly, and its summary explains how to retry that release

#### Scenario: Previous deployment remains healthy
- **WHEN** the former production endpoint is healthy but the new deployment fails or the alias still targets the former deployment
- **THEN** the run fails rather than reporting the release successfully deployed
