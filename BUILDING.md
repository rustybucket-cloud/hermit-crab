# Building and releasing the iOS app

The iOS app is the desktop app's web code in a Capacitor shell (`src/mobile`, `ios/`). Its bundle
identifier is `com.rustybucket.hermitcrab`, on team `56LR4QD85S`.

## Run it

```sh
pnpm install
pnpm ios:build   # builds the web code and copies it into ios/
pnpm ios:open    # opens Xcode; run from there
```

Development builds never take live updates, and drop one they find installed, so what you run is
what you built.

## Live updates

Web-only changes reach the App Store app without a new build. `pnpm ios:update` builds the web
code and uploads it to the [`ios-web`](https://github.com/rustybucket-cloud/hermit-crab/releases/tag/ios-web)
prerelease, with an `ios-web.json` manifest naming it. The app checks the manifest a little after it
starts and every few hours, downloads a newer bundle in the background, and switches to it the next
time it starts, so the page never reloads under someone's writing. If a new bundle doesn't start,
the app goes back to the one before and doesn't try it again (`src/mobile/updates.ts`).

A bundle's version is its commit's time and hash plus a hash of the native code it was built with:
the Swift, Xcode project and plist files in `ios/App`, and the installed Capacitor plugins
(`scripts/bundle-version.ts`, printed by `pnpm ios:version`). An app only takes bundles built for
its own native code, so changing any of those needs a new App Store build.

## Upload to App Store Connect

```sh
pnpm ios:release 7
```

Pass the build number, one higher than the latest in App Store Connect → TestFlight. It needs Xcode
signed in to the team's Apple account, or an App Store Connect API key in `ASC_KEY_ID` and
`ASC_ISSUER_ID`, read from `~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8` or
`ASC_KEY_PATH`.

Once a version is approved on the App Store, App Store Connect won't take more builds of it: raise
`MARKETING_VERSION` in the Xcode project first. That changes the native code's hash, so the next
push releases a build.

## Release from GitHub

On every push to `main`, the `iOS update or release` action
(`.github/workflows/ios.yml`) compares the native code's hash with the last release's. If they
match, it runs `pnpm ios:update`, which publishes nothing if the iOS app's code hasn't changed. If
native code changed, it runs `pnpm ios:release` on a GitHub macOS runner with the next build number,
so the new build goes to TestFlight. To release a build without a native change, run the action from
the Actions tab with **release** ticked (`gh workflow run ios.yml -f release=true`). Typecheck and
both builds run on pull requests (`.github/workflows/checks.yml`).

Releases are recorded as tags: `ios/build/<build number>`, with the build's native hash as the
message. The action creates them, but if you run `pnpm ios:release` by hand, tag the commit you built
from:

```sh
pnpm ios:version   # the native hash is the part after the last "-"
git tag -a ios/build/7 -m <native hash>
git push origin ios/build/7
```

To start, tag the latest build in App Store Connect with `-m none`, so the first push releases a
build that can take live updates.

Releasing needs these repository secrets (`gh secret set <name>`):

- `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_KEY_P8` (the `.p8` file's contents,
  `gh secret set ASC_KEY_P8 < AuthKey_<id>.p8`): an App Store Connect API key with Admin access,
  from App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys.
  Admin access lets Xcode manage profiles and sign the upload with a cloud-managed distribution
  certificate.
- `IOS_DEV_CERT_P12` and `IOS_DEV_CERT_PASSWORD`: an `Apple Development` certificate, exported
  from Keychain Access → My Certificates as a `.p12` with a password, then
  `base64 -i cert.p12 | gh secret set IOS_DEV_CERT_P12`. Xcode signs the archive with it; without
  it, every run would create a new certificate.

Runs go one at a time, so a push made during a release waits for its tag.
