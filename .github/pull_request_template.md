## What changed

<!-- One or two sentences. -->

## Why

<!-- The problem this solves. -->

## Release impact

Merging advances the version by one odometer step — patch rolls over at 100,
minor at 50 (`1.0.99` → `1.1.0`, `1.49.99` → `2.0.0`). The **Version gate** job
posts the exact version this PR will release.

Commit subjects must be conventional commits (`feat:`, `fix:`, `chore:`, …) —
CI enforces it, and it's what groups the release notes. See
[docs/RELEASING.md](../docs/RELEASING.md).

## Testing

<!-- How you verified it. The PR Checks workflow attaches a debug APK you can install. -->

- [ ] Tested on a device
