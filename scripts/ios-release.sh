#!/usr/bin/env bash
# Builds the iOS app and uploads it to App Store Connect.
# Pushing to main runs this through .github/workflows/ios.yml when native code changes. See BUILDING.md.
set -euo pipefail
cd "$(dirname "$0")/.."

TEAM_ID=56LR4QD85S
OUT=ios/release
ARCHIVE="$OUT/HermitCrab.xcarchive"
# The build number, which must be higher than every build already uploaded for
# this version.
BUILD_NUMBER=${1:-}
if ! [[ "$BUILD_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "Usage: pnpm ios:release <build number>, one higher than the latest in App Store Connect." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Warning: building with uncommitted changes. Live updates published later may not fit this build's native code." >&2
fi
VERSION=$(pnpm --reporter silent run ios:version)

# Optional App Store Connect API key. Without one, Xcode's signed-in account is used.
auth=()
if [ -n "${ASC_KEY_ID:-}" ]; then
  auth=(
    -authenticationKeyID "$ASC_KEY_ID"
    -authenticationKeyIssuerID "${ASC_ISSUER_ID:?Set ASC_ISSUER_ID with ASC_KEY_ID}"
    -authenticationKeyPath "${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}"
  )
fi

# Stamps the bundle built into the app with its version, so the app can take live updates (scripts/ios-update.sh).
IOS_RELEASE=1 pnpm ios:build

rm -rf "$OUT"
mkdir -p "$OUT"

# Info.plist reads CFBundleVersion from CURRENT_PROJECT_VERSION.
xcodebuild archive -quiet \
  -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination generic/platform=iOS -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates ${auth[@]+"${auth[@]}"} \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic CURRENT_PROJECT_VERSION="$BUILD_NUMBER"

# Uploads straight to App Store Connect with the build number given above.
cat > "$OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>destination</key>
  <string>upload</string>
  <key>teamID</key>
  <string>$TEAM_ID</string>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
</dict>
</plist>
EOF

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT" \
  -allowProvisioningUpdates ${auth[@]+"${auth[@]}"}

echo "Uploaded build $BUILD_NUMBER. The build appears in App Store Connect → TestFlight once Apple finishes processing it."
echo "Its web bundle is $VERSION. It takes live updates for native code ${VERSION##*-}."
