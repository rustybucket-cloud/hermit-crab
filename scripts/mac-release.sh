#!/usr/bin/env bash
# Releases a new version of the Mac app: sets the version, builds the app, signs it with a
# Developer ID certificate and notarizes it, then commits the version, pushes main and
# publishes a GitHub release that the app's updater picks up.
# See "Release for the Mac" in README.md.
set -euo pipefail
cd "$(dirname "$0")/.."

TEAM_ID=56LR4QD85S

VERSION=${1:-}
CURRENT=$(node -p "require('./package.json').version")
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: pnpm mac:release <version>, such as 1.2.3. The current version is $CURRENT." >&2
  exit 1
fi
TAG=v$VERSION

# Everything that could stop the release is checked before the slow build.
if [ "$(git branch --show-current)" != main ]; then
  echo "Release from main." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash your changes first, so the release matches what's pushed." >&2
  exit 1
fi
git fetch --quiet origin main
if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "main is behind origin/main. Pull first." >&2
  exit 1
fi
if git rev-parse --quiet --verify "refs/tags/$TAG" >/dev/null || gh release view "$TAG" >/dev/null 2>&1; then
  echo "$TAG has already been released." >&2
  exit 1
fi
if [ "$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | tail -1)" != "$VERSION" ]; then
  echo "$VERSION is lower than the current version, $CURRENT. The updater only offers higher versions." >&2
  exit 1
fi
gh auth status >/dev/null

if ! security find-identity -v -p codesigning | grep -q "Developer ID Application: .*($TEAM_ID)"; then
  echo "No Developer ID Application certificate for team $TEAM_ID in the keychain." >&2
  echo "Create one in Xcode → Settings → Accounts → Manage Certificates → + → Developer ID Application." >&2
  exit 1
fi

# Notarization credentials. electron-builder also accepts APPLE_API_KEY, APPLE_API_KEY_ID
# and APPLE_API_ISSUER, or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID.
if [ -z "${APPLE_API_KEY:-}" ] && [ -z "${APPLE_ID:-}" ]; then
  export APPLE_KEYCHAIN_PROFILE=${APPLE_KEYCHAIN_PROFILE:-hermit-crab-notary}
  if ! xcrun notarytool history --keychain-profile "$APPLE_KEYCHAIN_PROFILE" >/dev/null 2>&1; then
    echo "No notarization credentials in keychain profile \"$APPLE_KEYCHAIN_PROFILE\"." >&2
    echo "Store them with: xcrun notarytool store-credentials $APPLE_KEYCHAIN_PROFILE --team-id $TEAM_ID" >&2
    exit 1
  fi
fi

# The build reads the version from package.json. Put it back if the build fails.
sed -i '' -E "s/^  \"version\": \"[^\"]+\",$/  \"version\": \"$VERSION\",/" package.json
trap 'git checkout -- package.json' ERR
trap 'git checkout -- package.json; exit 130' INT

pnpm typecheck
# Old builds would otherwise be uploaded along with the new one.
rm -rf dist
pnpm build
electron-builder --mac -c.forceCodeSigning=true

# Fails if the app wasn't signed, notarized and stapled.
for app in dist/mac*/*.app; do
  xcrun stapler validate "$app"
  spctl --assess --type execute --verbose "$app"
done
trap - ERR INT

# Nothing to commit if an earlier run got this far before failing.
git diff --quiet package.json || git commit --quiet -m "Release $VERSION" package.json
git push --quiet origin main
# The app finds updates through latest-mac.yml, and installs them from the .zip.
gh release create "$TAG" dist/*.dmg dist/*.zip dist/*.blockmap dist/latest-mac.yml \
  --target "$(git rev-parse HEAD)" --title "HermitCrab Writing $VERSION" --generate-notes

echo "Released $TAG. Copies of the app on 0.2.0 or later will offer to update to it."
