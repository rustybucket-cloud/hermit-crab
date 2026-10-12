#!/usr/bin/env bash
# Publishes the iOS app's web code as a live update: builds it, zips it, and uploads it with a
# manifest to the ios-web prerelease on GitHub. Copies of the app from an App Store build with the
# same native code download it in the background and switch to it the next time they start.
# Changes to native code (Swift, the Xcode project, Capacitor plugins) still need pnpm ios:release.
# Pushing to main runs this through .github/workflows/ios.yml. See BUILDING.md.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO=rustybucket-cloud/hermit-crab
# One prerelease holds the latest update. Prereleases aren't "latest", so the Mac updater ignores it.
TAG=ios-web
OUT=out/ios-update

if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash your changes first. The update is named after the commit it's built from." >&2
  exit 1
fi
# The workflow checks out the commit that was pushed, and runs one at a time.
if [ -z "${GITHUB_ACTIONS:-}" ]; then
  if [ "$(git branch --show-current)" != main ]; then
    echo "Publish from main." >&2
    exit 1
  fi
  git fetch --quiet origin main
  if ! git merge-base --is-ancestor origin/main HEAD; then
    echo "main is behind origin/main. Pull first." >&2
    exit 1
  fi
fi
gh auth status >/dev/null

VERSION=$(pnpm --reporter silent run ios:version)
NATIVE=${VERSION##*-}
PUBLISHED=$(gh release download "$TAG" -R "$REPO" -p ios-web.json -O - 2>/dev/null || echo '{}')
field() { node -p "JSON.parse(process.argv[1]).$1 ?? ''" "$PUBLISHED"; }
if [ "$(field version)" = "$VERSION" ]; then
  echo "$VERSION is already published."
  exit 0
fi

pnpm typecheck
IOS_RELEASE=1 pnpm exec vite build --config vite.mobile.config.ts

# What's in the bundle besides its version, so a commit that doesn't change the iOS app publishes nothing.
CONTENT=$(cd out/mobile && {
  sed '/name="bundle-version"/d' index.html
  find . -type f ! -path ./index.html -print0 | sort -z | xargs -0 shasum -a 256
} | shasum -a 256 | cut -c 1-16)
PUBLISHED_VERSION=$(field version)
if [ "$(field content)" = "$CONTENT" ] && [ "${PUBLISHED_VERSION##*-}" = "$NATIVE" ]; then
  echo "The iOS app hasn't changed since $PUBLISHED_VERSION. Nothing to publish."
  exit 0
fi

rm -rf "$OUT"
mkdir -p "$OUT"
ZIP=hermit-crab-ios-$VERSION.zip
(cd out/mobile && zip -qrX "../../$OUT/$ZIP" . -x '*.DS_Store')
SHA256=$(shasum -a 256 "$OUT/$ZIP" | cut -d ' ' -f 1)
URL="https://github.com/$REPO/releases/download/$TAG/$ZIP"
node -e 'const [version, content, url, sha256] = process.argv.slice(1)
  console.log(JSON.stringify({ version, content, url, sha256 }, null, 2))' \
  "$VERSION" "$CONTENT" "$URL" "$SHA256" > "$OUT/ios-web.json"

if ! gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  gh release create "$TAG" -R "$REPO" --prerelease --target "$(git rev-parse HEAD)" --title "iOS live update" \
    --notes "The latest web code for the iOS app, which the app downloads by itself. Published by scripts/ios-update.sh."
fi
gh release upload "$TAG" -R "$REPO" "$OUT/$ZIP" --clobber
# The manifest goes up last, so it never names a zip that isn't there yet.
gh release upload "$TAG" -R "$REPO" "$OUT/ios-web.json" --clobber
for asset in $(gh release view "$TAG" -R "$REPO" --json assets -q '.assets[].name'); do
  if [[ "$asset" == hermit-crab-ios-*.zip && "$asset" != "$ZIP" ]]; then
    gh release delete-asset "$TAG" "$asset" -R "$REPO" --yes
  fi
done

echo "Published $VERSION. App Store builds with native code $NATIVE will switch to it the next time they start."
