# Fast updates

A patch release ships as a JavaScript bundle. A minor release ships as an APK.

| from → to | delivery | size | what the user does |
| --- | --- | --- | --- |
| 1.0.5 → 1.0.6 | JS bundle over the air | ~1 MB | nothing; the app restarts into it |
| 1.0.9 → 1.1.0 | full APK | ~74 MB | Android's installer, as before |

## Why the line is at `major.minor`

Because that is already what the odometer in `scripts/version.mjs` means: a
normal merge bumps the patch, and `--bump minor` is the deliberate signal that
something native changed — a new module, a new permission, an SDK bump. None of
those can travel in a JS bundle.

`major.minor` is written into `app.json` as **`runtimeVersion`**, which is
`expo-updates`' own compatibility gate. So the rule is not a convention the app
has to police; a bundle published for runtime `1.0` is *refused* by a `1.1`
build rather than half-applied.

`src/api/updates.js` reads the same rule client-side (`updateKind`,
`runtimeVersionOf`), and `tests/updateKind.test.js` pins the boundary.

## Why a static host alone does not work — and what serves the manifest

The first design put the whole update on GitHub Pages and worked around the
protocol's runtime **request header** by baking the runtime into each build's
`updates.url` (`…/ota/android/1.0/manifest.json`). The header problem was real
and that trick did solve it. A second requirement sank it:

> `expo-updates` refuses any manifest response that lacks an
> `expo-protocol-version` header. `UpdateFactory.kt` throws **"Legacy manifests
> are no longer supported"** when it is missing.

GitHub Pages cannot set response headers, so a device fetching the manifest from
Pages fails every time — `checkForUpdateAsync` *rejects* rather than resolving
`isAvailable: false`, and the app quietly never updates.

The split that works:

| what | served by | why |
| --- | --- | --- |
| `manifest.json` | the Frappe site: `GET /api/method/upande_sensors.api.ota.manifest` | can read the `expo-runtime-version` / `expo-platform` headers the client already sends, fetch `<otaBaseUrl>/<platform>/<runtime>/manifest.json` from Pages, and return it with `expo-protocol-version: 1` added |
| the bundle and assets | GitHub Pages, `https://wilfredtinega.github.io/Upande-Sensors-App/ota/android/<runtime>/…` | asset downloads need no special headers, and the manifest's URLs are absolute |

So `updates.url` is now **fixed** — `https://sensor.upande.com/api/method/upande_sensors.api.ota.manifest`
— and `scripts/version.mjs` no longer rewrites it. The runtime travels in the
header, as the protocol intends; the compatibility gate is the server reading
that header, plus `expo-updates` itself refusing a bundle whose `runtimeVersion`
does not match the build. `scripts/publish-ota.mjs` builds every asset URL from
`expo.extra.otaBaseUrl` + `android/<runtimeVersion>/`, not from `updates.url`.

**Use GitHub Pages, not `raw.githubusercontent.com`.** Pages serves the bundle
with a real content type; raw serves everything as `text/plain`.

## Publishing a patch

```sh
node scripts/version.mjs --apply     # 1.0.5 -> 1.0.6, updates runtimeVersion
npm run ota:build                    # writes ./ota/android/1.0/
```

`ota:build` runs `expo export`, copies the Hermes bundle
(`_expo/static/js/android/<hash>.hbc`) and `assets/` into the runtime folder,
and writes a manifest whose URLs point at Pages.

In CI this is automatic: `.github/workflows/release.yml` runs both steps after
the version bump and **before** the native prebuild, on every run whose bump is
a `patch` (a merge to `main`, or `workflow_dispatch` with `auto`/`patch`), and
publishes `./ota` to the `gh-pages` branch with `peaceiris/actions-gh-pages@v4`:

```yaml
publish_dir: ./ota
destination_dir: ota
keep_files: true      # other runtimes' bundles must survive
```

`keep_files: true` matters: devices on 1.0 keep asking for `/ota/android/1.0/`
long after 1.1 exists, and a publish that wiped the branch would strand them.
`ota/` and `.ota-export/` are removed before the release commit and are
gitignored.

A run that produces a **minor** or **major** bump skips the OTA steps — the
runtime has moved, and no device is on the new runtime yet to receive a bundle
for it. The APK is the update.

**GitHub Pages has to be switched on once**, by hand: repository *Settings →
Pages → Deploy from a branch → `gh-pages` / `(root)`*. The workflow writes the
branch but cannot enable serving it.

## What the app does

`app.json` has `checkAutomatically: "ON_LOAD"`, so the native side checks and
downloads at every launch on its own. `UpdateContext` then runs a loop that does
not depend on the GitHub Releases check at all:

- at mount, and on every return to the foreground (at most once in five
  minutes): `checkForUpdateAsync` → if available `fetchUpdateAsync` → apply;
- when `Updates.useUpdates().isUpdatePending` flips — the native ON_LOAD
  download finishing — the same apply path runs, so a fix is never one launch
  behind;
- **apply** means: inside the first 20 s after launch, `reloadAsync()` at once;
  later, a small non-blocking toast ("Updating to the latest version…",
  `src/components/OtaToast.js`) for ~2.5 s and then `reloadAsync()`, so the
  restart reads as an update and not as a crash.

Every error is swallowed and logged only under `__DEV__` — a dead manifest host,
an undeployed `upande_sensors`, a 404 — because none of it is the user's
problem. Nothing runs in development or Expo Go (`Updates.isEnabled` is false).

The GitHub Releases path is unchanged and still owns **minor** bumps: a release
whose `kind` is `native` downloads the APK and hands it to Android's installer.
A `js`-kind release still tries `applyJsUpdate` first when the user presses the
Account button, as before.

## Not done yet

- **Deploy `upande_sensors` with `api/ota.py`** on `sensor.upande.com`. Until it
  is there, `updates.url` answers with a Frappe error, `checkForUpdateAsync`
  rejects, and the app silently stays on its embedded bundle. Nothing breaks;
  nothing updates either.
- **A new APK.** `updates.url` and `checkAutomatically` are baked into the
  native build, as is the Expo SDK. Devices on the previous APK keep asking
  Pages for a manifest that fails the header check. The next release needs a
  **minor** bump (`workflow_dispatch` → `minor`) so they are offered the APK.
- **Code signing.** `expo-updates` supports signed manifests; the Frappe proxy
  could serve the signature header too, but the key has to be generated and
  stored as a secret first. Until then the trust boundary is HTTPS plus write
  access to the Pages branch and to the site.
- **First-run verification.** The manifest shape follows the protocol and the
  build script has been run end-to-end, but no device has completed a fetch
  through the proxy yet. Verify on a real build before relying on it.

## Build cost

`expo-updates` brought six more native modules with it, and the release build
tipped past Gradle's default heap:

```
The Daemon will expire after the build after running out of JVM Metaspace.
> Task :app:packageRelease FAILED
```

The template's default is `-Xmx512m -XX:MaxMetaspaceSize=256m`, and Metaspace —
class metadata — is the one that ran out. `plugins/withBuildTuning.js` raises
both on every prebuild, since `android/` is regenerated each CI run and cannot
just hold an edited `gradle.properties`.

### Real devices only

The template builds four architectures and each carries its own copy of every
native library — Hermes, the RN runtime, expo-modules-core, screens, svg. That is
what made the release APK 74MB.

`plugins/withBuildTuning.js` now pins:

```
reactNativeArchitectures=armeabi-v7a,arm64-v8a
```

`x86`/`x86_64` were emulator-only and no device in the field runs either, so they
were paying for themselves twice: once in every download and once in the build's
memory and wall-clock. `armeabi-v7a` stays — it is 32-bit ARM, which is what
older and cheaper handsets run, and this app goes to farms rather than to a fleet
of recent phones.

**The trade:** the APK no longer installs on an Android emulator. For that, lift
the filter for the one run:

```sh
npm run android:emulator      # expo run:android -- -PreactNativeArchitectures=x86_64
```

