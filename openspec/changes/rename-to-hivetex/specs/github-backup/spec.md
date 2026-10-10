# Spec Delta

## MODIFIED Requirements

### Requirement: Remote divergence handling
If the bound branch contains commits not made by HiveTeX, the backup SHALL NOT force-push; it SHALL push to a separate
`hivetex/backup` branch and notify the owner. Backup commits made before the rename SHALL count as HiveTeX's own.

#### Scenario: Manual commit on GitHub
- **WHEN** someone pushed a manual commit to the bound branch
- **THEN** the next backup goes to `hivetex/backup` and owners see a divergence notice
