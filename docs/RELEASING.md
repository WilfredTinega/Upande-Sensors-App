# Build & Release

The app is built and released entirely by GitHub Actions. There is no Expo
account, no EAS credits, and no manual APK step — the runner does what `eas
build` would do, using `expo prebuild` plus Gradle.

## One-time setup

You need an Android **upload keystore**. Android identifies an app by its
signing key, so this must be generated once and then kept forever: an APK signed
with a different key cannot be installed over an existing one.

```bash
./scripts/setup-signing.sh
```

That generates `upande-sensors-upload.keystore` (PKCS12 — Gradle's default store
type) and prints its password once. It uses `keytool` if a JDK is installed and
falls back to `openssl` otherwise, so it works without a JDK. If the GitHub CLI
is installed and authenticated it uploads the secrets directly; otherwise it
writes them to `SECRETS-TO-UPLOAD.txt` for pasting into
**Settings → Secrets and variables → Actions**.

| Secret | Contents |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the keystore, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias (`upande-sensors`) |
| `ANDROID_KEY_PASSWORD` | key password (same as the store password — PKCS12 does not meaningfully separate them) |
| `ANDROID_KEY_SHA256` | certificate fingerprint, so the build can prove it signed with the right key |

The release job refuses to run until the first four exist. `ANDROID_KEY_SHA256`
is optional but recommended: without it the build only checks that it wasn't
debug-signed, rather than that it was signed with *your* key.

**Back up the keystore file and password in a password manager.** It is
gitignored and it cannot be regenerated. Losing it means every existing install
has to be uninstalled before it can be updated.

## Day-to-day flow

```
branch ──▶ PR to main ──▶ PR Checks ──▶ merge ──▶ Release ──▶ GitHub Release + APK
```

### On a pull request — `.github/workflows/pr.yml`

Three jobs run against every PR targeting `main`:

- **Lint & dependency check** — `expo lint`, `expo install --check` (catches
  dependency versions that drift off the SDK 54 line), and `expo-doctor`.
- **Version preview** — posts the exact version and `versionCode` the merge will
  produce to the run summary.
- **Debug APK** — prebuilds and assembles a debug APK, uploaded as an artifact
  so a reviewer can install the PR on a device. This is what proves the native
  project still compiles before the merge lands.

### On merge to main — `.github/workflows/release.yml`

1. Advances the version by one odometer step (see [Versioning](#versioning)).
2. Writes it into `app.json` and `package.json`, and derives
   `android.versionCode`.
3. `expo prebuild --platform android --clean` regenerates `android/`.
4. `./gradlew assembleRelease`, signed with the upload keystore.
5. Verifies the signature with `apksigner`.
6. Commits `chore(release): x.y.z [skip ci]`, tags `vx.y.z`, pushes both.
7. Publishes a GitHub Release with generated notes and
   `upande_sensors_vx.y.z.apk` attached.

Users get updates by downloading the APK from the Releases page.

## Versioning

`app.json` → `expo.version` is the single source of truth; `package.json` is
kept in sync.

**Every merge to main advances the version by exactly one step.** The digits roll
over like an odometer:

- **patch (`z`)** counts `0`–`99`, then carries into the minor
- **minor (`y`)** counts `0`–`49`, then carries into the major
- **major (`x`)** is unbounded

```
1.0.0 → 1.0.1 → … → 1.0.99 → 1.1.0 → 1.1.1 → … → 1.49.99 → 2.0.0 → 2.0.1 → …
```

So one major version is 5,000 releases wide (50 minors × 100 patches).

Because the limits are fixed, the version *is* a counter in disguise, which is
exactly what Android's `versionCode` needs:

```
versionCode = (major * 50 + minor) * 100 + patch
```

`1.0.0` → `5000`, `1.0.99` → `5099`, `1.1.0` → `5100`, `2.0.0` → `10000`. It goes
up by exactly 1 per release, never collides, and needs no external counter. A
version outside the limits (`1.50.0`, `1.0.100`) makes the script fail loudly
rather than silently emit a lower code.

Commit style has no effect on the version. It is not enforced anywhere. If a
subject happens to start with a conventional-commit type — `feat:`, `fix:`,
`perf:`, `refactor:`, `docs:`, `build:`, `ci:`, `chore:` — the release notes
group it under that heading; anything else lands under **Other**. Either way the
commit shows up in the changelog.

Preview what a branch would release:

```bash
npm run version:next          # 1.0.0 -> 1.0.1 (patch, versionCode 5001, …)
npm run version:notes         # the changelog markdown
```

To skip ahead to a round number — say a release worth calling `1.1.0` rather
than `1.0.37` — run the **Release** workflow manually from the Actions tab and
pick `minor` or `major`. Those still respect the rollover: `--bump minor` on
`1.49.5` lands on `2.0.0`.

## Signing, and why there's a config plugin

`expo prebuild` regenerates `android/` from scratch on every run, and the stock
template signs release builds with a throwaway debug key. `plugins/withReleaseSigning.js`
re-applies a real `release` signing config on each prebuild, driven by Gradle
properties so no secret is ever written to a file in the repo. Without the
properties set it falls back to debug signing, so local release builds still
work.

## Building locally

```bash
npm ci
npm run build:apk    # prebuild + gradlew assembleRelease (debug-signed)
```

To sign locally with the real key:

```bash
npm run prebuild
cd android && ./gradlew assembleRelease \
  -PUPANDE_STORE_FILE="$PWD/../upande-sensors-upload.keystore" \
  -PUPANDE_STORE_PASSWORD=... \
  -PUPANDE_KEY_ALIAS=upande-sensors \
  -PUPANDE_KEY_PASSWORD=...
```

Requires JDK 17 and the Android SDK.

> `expo prebuild` rewrites the `android`/`ios` npm scripts to `expo run:*` once a
> native directory exists. The app is otherwise used through Expo Go, so if you
> prebuild locally, discard that change (`git checkout -- package.json`) and
> delete `android/` when you're done. CI does exactly this before committing.

## Adding OTA updates later

This pipeline ships whole APKs. If you later want JS-only changes to reach
devices without a reinstall, add `expo-updates` and an EAS project ID and run
`eas update` as an extra job — the rest of the pipeline is unaffected.
