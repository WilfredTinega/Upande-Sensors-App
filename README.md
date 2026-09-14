# Upande Sensors

An Android client for an ERPNext/Frappe instance running the [`upande_sensors`](https://github.com/upande) app.

It gives field and ops staff a phone-sized view of the same data the desk UI exposes:

- **Home** — the selected site at a glance (live / stale / total, newest reading, recent limit
  breaches), the dashboards grid from Sensor Settings, quick links and the support contact.
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

The "stale after" window itself comes from **Sensor Settings → `stale_after_minutes`** on the
server, applied app-wide when the config loads; the compiled default of 120 minutes is used
when the server does not say (an older `upande_sensors`, or a blank field).

## Push notifications

When a reading crosses a limit configured on its monitoring, the server sends a push to every
phone registered for that site (Android channel `alerts`). Tapping it selects the site and opens
**Live**. The **Home** tab also lists the last 7 days' breaches for the selected site in a
"Recent alerts" card, which works with no push setup at all — it reads the server directly.

Push itself needs one-time setup that the repository does not yet carry. Until it is done the app
runs with push disabled, **Account → Notifications** reads "Alerts not configured on this build",
and nothing else is affected:

1. **An Expo account and project.** Run `npx eas init` in the repo; it writes
   `expo.extra.eas.projectId` into `app.json`. Expo push tokens are minted per project, so
   without this id there is nothing to register.
2. **A Firebase project.** Download its `google-services.json`, place it at the repo root and
   reference it from `app.json` → `android.googleServicesFile`. Android push is FCM underneath.
3. **The FCM V1 service-account key, uploaded to Expo** (`eas credentials`, or the Expo
   dashboard → project → Credentials → FCM V1). Expo's push service cannot deliver to Android
   without it.

Registration happens after sign-in and on a restored session, and the token is unregistered on
sign-out. It is skipped — and says so on the Account row — in Expo Go (which dropped remote push
in SDK 53), in development bundles, on emulators, and against a server whose `upande_sensors`
predates the push endpoints. Denying the permission is remembered by Android; **Turn on** on the
Account row re-runs registration and, on a second denial, opens the system settings page.

Server side, the `expo_push_access_token` key in site config is optional: Expo's push API works
unauthenticated for ordinary volumes, and the token only raises the rate limits.

## Device register

The app tells the server which phones it is installed on, so **App activity → Devices** (System
Manager only) can answer "how many devices run this, and which build is each person on".

What is sent: a random install id (a UUID minted once and kept in the keystore — it survives
sign-out and changes only on reinstall), platform, phone brand / model / device name, OS version,
app and runtime version, whether it is a physical device, and the reason for the report. **Not**
sent: IP, location, phone number, or any hardware or advertising id. The IP shown in the register
is observed by the server from the request.

When: on every successful sign-in (password, biometric unlock, or the stored-credential re-login
on cold start) — that is the event that pairs an account with a device, and on a shared phone
each person who signs in gets their own record. A cold start that walks straight back into a live
session sends a `launch` report instead, throttled to once an hour per account. Everything is
fire-and-forget: a server without the endpoint, no network, or a refusal changes nothing on screen.

## Project layout

```
App.js                  root component (auth gate + navigation)
src/api/client.js       Frappe HTTP client: login, session cookie, error typing
src/api/endpoints.js    the app's API, tried as upande_sensors.api.mobile.* → Server Script
                        upande_sensors_app.* → legacy call, falling through only on a
                        missing endpoint (see server/README.md)
src/api/push.js         push registration + notification taps (limit alerts)
src/context/            auth state and persisted session
src/navigation/         bottom-tab navigator
src/screens/            Home, Live, Readings, Dashboard, Login, Account, RouteHistory
src/components/         chart and shared UI primitives
src/theme.js            light + dark palettes (Account > Appearance; defaults to light)
```

## License

See [LICENSE](LICENSE).
