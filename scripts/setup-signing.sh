#!/usr/bin/env bash
#
# One-time setup: generate the Android upload keystore and push it to GitHub as
# repository secrets, so the Release workflow can sign APKs.
#
#   ./scripts/setup-signing.sh
#
# Requires: keytool (any JDK) and the GitHub CLI (`gh auth login` first).
#
# KEEP THE GENERATED .keystore FILE. Android identifies an app by its signing
# key: lose it and existing installs can never be upgraded, only uninstalled and
# reinstalled. Back it up somewhere durable outside this repo.

set -euo pipefail

cd "$(dirname "$0")/.."

KEYSTORE_FILE="${KEYSTORE_FILE:-upande-sensors-upload.keystore}"
KEY_ALIAS="${KEY_ALIAS:-upande-sensors}"
VALIDITY_DAYS="${VALIDITY_DAYS:-10950}" # ~30 years; Play requires >= 25.
DNAME="${DNAME:-CN=Upande Sensors, OU=Upande, O=Upande, L=Nairobi, C=KE}"

command -v keytool >/dev/null || { echo "keytool not found — install a JDK (e.g. apt install default-jdk)." >&2; exit 1; }
command -v gh >/dev/null || { echo "gh not found — install the GitHub CLI: https://cli.github.com" >&2; exit 1; }

if [ -f "$KEYSTORE_FILE" ]; then
  echo "$KEYSTORE_FILE already exists. Refusing to overwrite an existing signing key."
  echo "Delete it deliberately, or set KEYSTORE_FILE=... to use a different path."
  exit 1
fi

# Generated rather than prompted, so the password never sits in shell history.
STORE_PASSWORD="$(openssl rand -base64 32 | tr -d '\n=+/' | cut -c1-32)"
KEY_PASSWORD="$STORE_PASSWORD"

echo "Generating $KEYSTORE_FILE (alias: $KEY_ALIAS)..."
keytool -genkeypair -v \
  -keystore "$KEYSTORE_FILE" \
  -alias "$KEY_ALIAS" \
  -keyalg RSA \
  -keysize 2048 \
  -validity "$VALIDITY_DAYS" \
  -storepass "$STORE_PASSWORD" \
  -keypass "$KEY_PASSWORD" \
  -dname "$DNAME"

echo "Uploading repository secrets..."
base64 -w0 "$KEYSTORE_FILE" | gh secret set ANDROID_KEYSTORE_BASE64
printf '%s' "$STORE_PASSWORD" | gh secret set ANDROID_KEYSTORE_PASSWORD
printf '%s' "$KEY_ALIAS"      | gh secret set ANDROID_KEY_ALIAS
printf '%s' "$KEY_PASSWORD"   | gh secret set ANDROID_KEY_PASSWORD

cat <<EOF

Done. Secrets set: ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD,
ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD.

  Keystore : $(pwd)/$KEYSTORE_FILE
  Alias    : $KEY_ALIAS
  Password : $STORE_PASSWORD

Store the file and password in your password manager NOW — this is the only
time the password is printed, and the key cannot be regenerated. The keystore
is gitignored; do not commit it.
EOF
