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

## Why a static host works

The Expo Updates protocol sends the runtime version as a **request header**, and
no static file server can vary a response on a header. That normally rules out
GitHub Pages.

The way round it: `updates.url` is baked into each build, and
`scripts/version.mjs` writes the runtime *into the URL*:

```
1.0.x builds ask for  …/ota/android/1.0/manifest.json
1.1.x builds ask for  …/ota/android/1.1/manifest.json
```

The gate moves from the server to the URL, where a static host can honour it —
and it becomes physically impossible to hand a 1.0 device a 1.1 bundle. Nothing
needs to inspect a header, because the address already carries the answer.

**Use GitHub Pages, not `raw.githubusercontent.com`.** Pages serves `.json` as
`application/json`; raw serves it as `text/plain`, which the client rejects.

## Publishing a patch

```sh
node scripts/version.mjs --apply     # 1.0.5 -> 1.0.6, updates runtimeVersion + url
npm run ota:build                    # writes ./ota/android/1.0/
```

Then publish `ota/` to the Pages branch. In CI, on a merge that produces a patch:

```yaml
- name: Build the JS update
  run: |
    node scripts/version.mjs --apply
    npm run ota:build
- name: Publish to Pages
  uses: peaceiris/actions-gh-pages@v4
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    publish_dir: ./ota
    destination_dir: ota
    keep_files: true      # other runtimes' manifests must survive
```

`keep_files: true` matters: devices on 1.0 keep asking for `/ota/android/1.0/`
long after 1.1 exists, and a publish that wiped the branch would strand them.

A merge that produces a **minor** bump keeps the existing APK job instead — the
runtime has moved, and no bundle published under the new runtime is reachable by
the old builds anyway.

## What the app does

`UpdateContext` tries the JS path first for a same-runtime release
(`Updates.checkForUpdateAsync` → `fetchUpdateAsync` → `reloadAsync`) and falls
back to the APK if it declines. It declines in three ordinary cases: development
and Expo Go (`Updates.isEnabled` is false), a runtime with nothing published
yet, and a release whose kind is `native`. Choosing the fast path can therefore
never cost anyone the update.

## Not done yet

- **Code signing.** `expo-updates` supports signed manifests and a static host
  can serve a signature as easily as a manifest, but the key has to be generated
  and stored as a secret first. Until then the trust boundary is HTTPS plus write
  access to the Pages branch.
- **First-run verification.** The manifest shape here follows the protocol, but
  no device has fetched one yet. Verify on a real build before relying on it: if
  the client rejects a plain-JSON manifest and insists on `multipart/mixed`, the
  fix is a small redirect worker in front of Pages, not a change to any of this.
