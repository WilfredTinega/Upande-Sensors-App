# Upande Sensors

An Android client for an ERPNext/Frappe instance running the [`upande_sensors`](https://github.com/upande) app.

It gives field and ops staff a phone-sized view of the same data the desk UI exposes:

- **Live** — latest values per sensor, grouped by site, with staleness flagged.
- **Reading** — per-sensor rollups (min / max / average / trend) for a window.
- **Dashboards** — time series for a sensor type over a date range, with daily/hourly bucketing.
  The list icon in the header opens the tab sidebar, driven by Sensor Settings.

Authentication is a plain ERPNext username + password session login. The session cookie is
held by the app and persisted with `expo-secure-store`, so a cold start restores the session
rather than forcing a re-login.

### Biometric sign-in

After the first password login the app offers to enable fingerprint / face unlock (also
toggleable under **Account → Security**). It is an *unlock*, not a second login: it releases the
credential already in the keystore. Consequences worth knowing:

- Enabling requires passing the prompt first, so nobody holding an already-unlocked phone can
  set a lock the owner can't pass.
- With it on, a cold start stops at the lock screen instead of walking into the app — that is
  the point of it.
- Signing out deletes the stored credential **and** the toggle, because an unlock with nothing
  behind it would be theatre.
- If the user removes their enrolled fingerprint at OS level, the app falls back to a normal
  restore rather than pretending it is still gated.

## Prerequisites

- Node.js 20 or newer, and npm.
- **Expo Go 54.x** on the test device. This project targets **Expo SDK 54** (React Native
  0.81.5) because each modern Expo Go build supports exactly one SDK. If Expo Go reports
  *"Project is incompatible with this version of Expo Go"*, the two are out of step — check the
  version shown in Expo Go and either update it or re-pin this project to match.
- An [Expo account](https://expo.dev/signup) and the EAS CLI (`npm install -g eas-cli`) if you
  intend to produce installable builds.
- A user account on the target ERPNext site with read access to the `upande_sensors` doctypes.

No local Android SDK or JDK is required — all native builds run in the EAS cloud.

## Running in development

```bash
npm install
npx expo start
```

Scan the QR code with **Expo Go** on an Android device on the same network, or press `a` to
open it on a connected device/emulator. Everything in the app is JavaScript plus modules that
Expo Go already bundles, so no custom development client is needed for day-to-day work.

If you do want a development build (for native debugging or a module Expo Go lacks):

```bash
eas build -p android --profile development
```

## Building an installable APK

```bash
eas build -p android --profile preview
```

The `preview` profile produces a plain `.apk` with internal distribution — EAS returns a
download link you can open directly on the phone and install (enable "install from unknown
sources" for your browser the first time). Use this for testers and field devices.

For Play Store submission, `eas build -p android --profile production` produces an `.aab`
(Android App Bundle) instead, and auto-increments `versionCode`.

## Pointing at a different ERPNext site

There is no built-in site. A fresh install has no server address at all, and the login screen
asks for one before it will accept a username — a plain site address, for example:

```
your-site.example.com
```

The scheme is optional (`https://` is assumed) and a trailing slash is stripped. The address is
stored on the device and reused on every later launch, so this is asked exactly once per install.

This is deliberate: a compiled-in default means every fresh install points at whichever customer
happened to be first, and an installer who forgets to change it signs the wrong farm's staff into
the wrong instance.

Changing sites afterwards does not need a rebuild, but doing it in-app requires the **System Manager**
role on the currently connected instance. Sign in, open **Account → Change server**, enter the
new URL (the scheme is optional; `https://` is assumed and a trailing slash is stripped) and
confirm. A Frappe session belongs to one site, so switching signs you out; log in again against
the new server. The chosen URL is stored on the device and reused on the next launch.

Once a site is set the server field disappears — a field user should not be able to repoint the
app at another instance by accident. There is a deliberate escape hatch for installers:
**long-press the logo** on the login screen to reveal the server address again.

Nobody is authenticated at that point, so no role can be checked — the long press itself is the
only thing between a field user and a wrong server, which is why it is not a plain button.
Changing the address there clears any saved credential, because a stored password belongs to the
site that issued it and must never be replayed against a different one.

Roles are read from the `Has Role` child table (Frappe's own `frappe.get_roles` is not
whitelisted). If that lookup fails for any reason the app treats the account as unprivileged
and hides the control, so it is never offered and then refused.

The long press is also how you reach an instance that no existing System Manager account can log
into — there is no build-time constant to edit any more.

## Server timezone — check this when you change sites

Frappe returns naive timestamps (`2026-08-09 14:32:00`) in the **site's** timezone, with
nothing in the payload identifying which timezone that is. The app resolves it at runtime, best
source first:

1. **Server** — System Settings `time_zone`. Only System Managers may read it, so most accounts
   never get this.
2. **Phone** — the device's own zone. Correct whenever user and site are in the same country.
3. **Manual** — an explicit UTC offset, set under **Account → Time zone**.

This is not cosmetic. It decides whether a reading is judged **stale**, and getting it wrong
biases in the dangerous direction: assume a zone behind the server's and every reading looks
newer than it is, so a sensor that stopped reporting hours ago is presented as live.

As a backstop, any timestamp that lands more than ten minutes in the *future* is reported as
`clock mismatch` and treated as stale rather than fresh — so a wrong value here shows up as a
visible anomaly instead of silent false confidence.


## Project layout

```
App.js                  root component (auth gate + navigation)
src/api/client.js       Frappe HTTP client: login, session cookie, error typing
src/api/endpoints.js    wrappers over the upande_sensors whitelisted methods
src/context/            auth state and persisted session
src/navigation/         bottom-tab navigator
src/screens/            Live, Readings, Dashboard, Login, Account, RouteHistory
src/components/         chart and shared UI primitives
src/theme.js            light + dark palettes (Account > Appearance; defaults to light)
```

## License

See [LICENSE](LICENSE).
