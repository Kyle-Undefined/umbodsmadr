#!/usr/bin/env bash
set -euo pipefail

REPO="kyle-undefined/umbodsmadr"
BINARY="umbod"
INSTALL_DIR="$HOME/.local/bin"
RELEASE_REF="${UMBOD_VERSION:-__UMBOD_RELEASE_REF__}"
TEMP_FILES=()

UMBOD_IS_RELEASE="__UMBOD_IS_RELEASE__"
if [ "$UMBOD_IS_RELEASE" != "true" ]; then
    echo "[umbod] install.sh is a release-installer template." >&2
    echo "[umbod] Run the release-hosted install.sh asset, or set UMBOD_VERSION explicitly." >&2
    exit 1
fi

cleanup() {
    if [ "${#TEMP_FILES[@]}" -eq 0 ]; then
        return
    fi
    rm -f "${TEMP_FILES[@]}"
}

trap cleanup EXIT

make_temp_path() {
    local stem="$1"
    mktemp "$INSTALL_DIR/.${stem}.XXXXXX"
}

move_into_place() {
    local source_path="$1"
    local target_path="$2"

    if ! mv -f "$source_path" "$target_path"; then
        echo "[umbod] Failed to replace $target_path"
        exit 1
    fi
}

# ─── Detect architecture ──────────────────────────────────────────────────────

ARCH="$(uname -m)"
case "$ARCH" in
    x86_64) ;;
    *)
        echo "[umbod] Unsupported architecture: $ARCH (only x86_64 is supported)"
        exit 1
        ;;
esac

# ─── Download binary ──────────────────────────────────────────────────────────

CHECKSUMS_PATH="$(mktemp)"
TEMP_FILES+=("$CHECKSUMS_PATH")

BASE_URL="https://github.com/${REPO}/releases/download/${RELEASE_REF}"
BINARY_URL="${BASE_URL}/umbod"
CHECKSUMS_URL="${BASE_URL}/umbod-checksums.txt"

echo "[umbod] Resolved release ${RELEASE_REF}"

echo "[umbod] Downloading checksums for ${RELEASE_REF}..."
curl -fsSL --connect-timeout 10 --max-time 60 "$CHECKSUMS_URL" -o "$CHECKSUMS_PATH"

echo "[umbod] Downloading umbod for ${RELEASE_REF}..."
mkdir -p "$INSTALL_DIR"
BINARY_TMP_PATH="$(make_temp_path "$BINARY")"
TEMP_FILES+=("$BINARY_TMP_PATH")

curl -fsSL --connect-timeout 10 --max-time 300 "$BINARY_URL" -o "$BINARY_TMP_PATH"

EXPECTED_SHA="$(awk '/ umbod$/ { print $1 }' "$CHECKSUMS_PATH")"
if [ -z "$EXPECTED_SHA" ]; then
    echo "[umbod] Failed to find checksum for umbod"
    exit 1
fi

if command -v sha256sum &>/dev/null; then
    ACTUAL_SHA="$(sha256sum "$BINARY_TMP_PATH" | awk '{ print $1 }')"
elif command -v shasum &>/dev/null; then
    ACTUAL_SHA="$(shasum -a 256 "$BINARY_TMP_PATH" | awk '{ print $1 }')"
else
    echo "[umbod] No SHA256 utility found (sha256sum or shasum required)"
    exit 1
fi
if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
    echo "[umbod] Checksum verification failed"
    exit 1
fi

chmod +x "$BINARY_TMP_PATH"
move_into_place "$BINARY_TMP_PATH" "$INSTALL_DIR/$BINARY"
echo "[umbod] Verified checksum for $INSTALL_DIR/$BINARY"

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "[umbod] Installed to $INSTALL_DIR/$BINARY. Run: umbod --help"
