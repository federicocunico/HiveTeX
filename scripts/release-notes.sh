#!/usr/bin/env bash
# Release notes for a version tag: a download table built from the release's attached installers, first-launch notes,
# and GitHub's generated changelog. Used by .github/workflows/release.yml; prints Markdown.
# Usage: scripts/release-notes.sh v0.2.0 assets.txt   (assets.txt: one attached file name per line)
# Needs GH_REPO (owner/name) and an authenticated gh.
set -euo pipefail

tag="$1"
assets="$2"
base="https://github.com/${GH_REPO}/releases/download/${tag}"

# A Markdown link to the first attached file matching the pattern, or nothing.
link() {
  local name
  name=$(grep -E "$1" "$assets" | grep -v '\.sig$' | head -1 || true)
  [ -n "$name" ] && printf '[%s](%s/%s)' "$name" "$base" "$name"
}
# "a or b", skipping whichever is missing.
either() {
  local a b
  a=$(link "$1")
  b=$(link "$2")
  if [ -n "$a" ] && [ -n "$b" ]; then printf '%s or %s' "$a" "$b"; else printf '%s%s' "$a" "$b"; fi
}

cat <<EOF
## Download

| System | Installer |
|---|---|
| Windows 10 and 11 | $(either '\.exe$' '\.msi$') |
| macOS 11 or later (Apple silicon and Intel) | $(link '\.dmg$') |
| Linux | $(either '\.AppImage$' '\.deb$')$( [ -n "$(link '\.rpm$')" ] && printf ' or %s' "$(link '\.rpm$')" ) |

**First launch**

- **Windows:** SmartScreen shows "Windows protected your PC". Click *More info*, then *Run anyway*.
- **macOS:** open the \`.dmg\` and drag HiveTeX to Applications. If macOS blocks it, open *System Settings → Privacy &
  Security* and click *Open Anyway*.
- **Linux:** run \`chmod +x HiveTeX_*.AppImage\` and start it, or install the \`.deb\` or \`.rpm\`. Device keys need a
  keychain (GNOME Keyring or KWallet), which standard desktops have.
- The sign-in screen shows the server (\`hivetex.vercel.app\` by default). Use *Change* to connect to another one.

Already installed? *Account → Check for updates* installs this version.

EOF

# GitHub's changelog since the previous tag (pull requests and contributors, then a "Full Changelog" compare link).
gh api "repos/${GH_REPO}/releases/generate-notes" -f tag_name="$tag" --jq .body
