#!/usr/bin/env bash
# Builds the Mac app, signs it with a Developer ID certificate and notarizes it,
# so it opens without a Gatekeeper warning on other Macs.
# See "Release for the Mac" in README.md.
set -euo pipefail
cd "$(dirname "$0")/.."

TEAM_ID=56LR4QD85S

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

if [ -n "$(git status --porcelain)" ]; then
  echo "Warning: building with uncommitted changes." >&2
fi

# Old builds would otherwise be uploaded along with the new one.
rm -rf dist
pnpm build
electron-builder --mac -c.forceCodeSigning=true

# Fails if the app wasn't signed, notarized and stapled.
for app in dist/mac*/*.app; do
  xcrun stapler validate "$app"
  spctl --assess --type execute --verbose "$app"
done

VERSION=$(node -p "require('./package.json').version")
echo "Signed and notarized. To publish, push the release commit, then run:"
echo
# The app finds updates through latest-mac.yml, and installs them from the .zip.
echo "  gh release create v$VERSION dist/*.dmg dist/*.zip dist/*.blockmap dist/latest-mac.yml --generate-notes"
