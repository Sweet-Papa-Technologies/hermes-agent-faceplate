#!/usr/bin/env sh
#
# HermesAgent Faceplate — one-line installer (macOS + Linux).
#
# Usage:
#   curl -fsSL https://get.hermesagent.app/install.sh | sh
#
# Inspect-first variant (recommended for first-time installs):
#   curl -fsSL https://get.hermesagent.app/install.sh -o hermes-install.sh
#   less hermes-install.sh
#   sh hermes-install.sh
#
# What this script does:
#   1. Detects OS + arch via `uname` and (on Linux) glibc/musl via `ldd`.
#   2. Fetches the release manifest from $HERMES_CHANNEL_URL.
#   3. Downloads the matching packaged Electron build to $HERMES_PREFIX/app.
#   4. Verifies the SHA-256 against the manifest.
#   5. Installs OS integration (Applications symlink on macOS, .desktop file
#      on Linux).
#   6. Writes a `hermes` CLI shim and adds it to $HOME/.local/bin (or wraps
#      the install path in a shellrc block on macOS).
#   7. Prints next steps + the path to install.log.
#
# Everything lives under one prefix ($HERMES_PREFIX, default ~/.hermes-app)
# so uninstall is a single `rm -rf` + rc-block delete.
#
# Re-running the script is safe — it compares the on-disk version against
# the latest manifest and no-ops if equal, upgrades in place if newer. For
# routine updates the packaged app uses electron-updater; this shell
# installer is the bootstrap + disaster-recovery path.
#
# References:
#   - docs/v1/research/phase5-installer.md (research brief)
#   - rustup-init.sh, pnpm install.sh, mise.run, Homebrew install.sh

set -eu

# ─── config (overridable via env) ───────────────────────────────────────
HERMES_CHANNEL_URL="${HERMES_CHANNEL_URL:-https://get.hermesagent.app/channels/stable.json}"
HERMES_PREFIX="${HERMES_PREFIX:-${HOME}/.hermes-app}"
HERMES_BIN_DIR="${HERMES_BIN_DIR:-${HOME}/.local/bin}"

# Wrap everything in main() so a truncated download (network drop mid-pipe)
# can't execute partial logic — same pattern as rustup-init.sh.
main() {
    init_logging
    require_tools curl mktemp uname tar
    detect_platform
    log "OS=${HERMES_OS} ARCH=${HERMES_ARCH} libc=${HERMES_LIBC:-n/a}"

    manifest="$(fetch_manifest)"
    target_version="$(json_field "$manifest" version)"
    log "Latest version on channel: ${target_version}"

    if has_existing_install; then
        cur_version="$(cat "${HERMES_PREFIX}/version" 2>/dev/null || echo "?")"
        log "Existing install at ${HERMES_PREFIX} (version ${cur_version})"
        if [ "${cur_version}" = "${target_version}" ]; then
            log "Already at ${target_version}. Nothing to do."
            print_postinstall_hint
            exit 0
        fi
        log "Upgrading ${cur_version} → ${target_version}"
    fi

    download_url="$(asset_url "$manifest")"
    expected_sha="$(asset_sha256 "$manifest")"
    [ -z "${download_url}" ] && fatal "No asset URL for ${HERMES_OS}/${HERMES_ARCH} in manifest."
    [ -z "${expected_sha}" ] && fatal "No SHA-256 in manifest for selected asset."

    tmpdir="$(mktemp -d)"
    trap 'rm -rf "${tmpdir}"' EXIT INT TERM

    log "Downloading ${download_url}"
    curl -fsSL "${download_url}" -o "${tmpdir}/payload"
    verify_sha256 "${tmpdir}/payload" "${expected_sha}"

    install_payload "${tmpdir}/payload" "${target_version}"
    install_os_integration
    install_cli_shim
    print_postinstall_hint
}

# ─── helpers ─────────────────────────────────────────────────────────────
init_logging() {
    mkdir -p "${HERMES_PREFIX}"
    HERMES_LOG="${HERMES_PREFIX}/install.log"
    : > "${HERMES_LOG}"
    log "HermesAgent Faceplate installer starting $(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

log() {
    msg="$1"
    printf '%s\n' "${msg}"
    [ -n "${HERMES_LOG:-}" ] && printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${msg}" >> "${HERMES_LOG}"
}

fatal() {
    log "ERROR: $1"
    log "See ${HERMES_LOG:-(no log)} for details."
    exit 1
}

require_tools() {
    for t in "$@"; do
        command -v "$t" >/dev/null 2>&1 || fatal "Required tool '$t' not found in PATH."
    done
}

detect_platform() {
    raw_os="$(uname -s)"
    raw_arch="$(uname -m)"
    case "${raw_os}" in
        Darwin)  HERMES_OS=macos   ;;
        Linux)   HERMES_OS=linux   ;;
        *)       fatal "Unsupported OS: ${raw_os}. Windows users: use install.ps1 instead." ;;
    esac
    case "${raw_arch}" in
        x86_64|amd64) HERMES_ARCH=x64 ;;
        arm64|aarch64) HERMES_ARCH=arm64 ;;
        *) fatal "Unsupported arch: ${raw_arch}" ;;
    esac
    HERMES_LIBC=""
    if [ "${HERMES_OS}" = linux ] && command -v ldd >/dev/null 2>&1; then
        if ldd --version 2>&1 | grep -qi musl; then
            HERMES_LIBC=musl
        else
            HERMES_LIBC=glibc
        fi
    fi
}

fetch_manifest() {
    out="$(mktemp)"
    curl -fsSL "${HERMES_CHANNEL_URL}" -o "${out}" || fatal "Failed to fetch manifest: ${HERMES_CHANNEL_URL}"
    cat "${out}"
    rm -f "${out}"
}

# Minimal JSON field extractor — handles flat top-level fields only.
# For nested asset lookups we use json_path below. Avoids the python/jq
# dependency for a single bootstrap script.
json_field() {
    printf '%s' "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1
}

# Read assets.<os>_<arch>.{url,sha256} from the manifest.
asset_url() {
    json_extract "$1" "assets.${HERMES_OS}_${HERMES_ARCH}.url"
}
asset_sha256() {
    json_extract "$1" "assets.${HERMES_OS}_${HERMES_ARCH}.sha256"
}
# Hand-rolled tiny JSON dotted-path extractor. Manifest is small + well-
# formed so this stays robust enough for the bootstrap. For anything more
# complex we'd vendor a real parser, but this avoids a Python dep.
json_extract() {
    payload="$1"; path="$2"
    parts="$(printf '%s' "${path}" | tr '.' ' ')"
    cur="${payload}"
    for p in ${parts}; do
        # Strip everything outside the matching key's value.
        cur="$(printf '%s' "${cur}" | awk -v key="${p}" '
            BEGIN { depth=0; found=0; out="" }
            {
              line=$0
              for (i=1; i<=length(line); i++) {
                  c=substr(line, i, 1)
                  if (c=="{") depth++
                  if (c=="}") depth--
              }
              print line
            }
        ')"
        # Simple regex: "<p>"\s*:\s*("..."|{...}). Good enough for our
        # known-shape manifest.
        if printf '%s' "${cur}" | grep -q "\"${p}\"[[:space:]]*:[[:space:]]*\""; then
            cur="$(printf '%s' "${cur}" | sed -n 's/.*"'"${p}"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
        elif printf '%s' "${cur}" | grep -q "\"${p}\"[[:space:]]*:[[:space:]]*{"; then
            cur="$(printf '%s' "${cur}" | awk -v key="${p}" '
                index($0, "\""key"\"") { capture=1 }
                capture { print }
            ')"
        else
            cur=""
            break
        fi
    done
    printf '%s' "${cur}"
}

verify_sha256() {
    file="$1"; expected="$2"
    if command -v shasum >/dev/null 2>&1; then
        actual="$(shasum -a 256 "${file}" | awk '{print $1}')"
    elif command -v sha256sum >/dev/null 2>&1; then
        actual="$(sha256sum "${file}" | awk '{print $1}')"
    else
        fatal "Neither shasum nor sha256sum available; cannot verify download integrity."
    fi
    if [ "${actual}" != "${expected}" ]; then
        fatal "SHA-256 mismatch: expected ${expected}, got ${actual}"
    fi
    log "SHA-256 verified."
}

has_existing_install() {
    [ -f "${HERMES_PREFIX}/version" ]
}

install_payload() {
    payload="$1"; version="$2"
    log "Installing to ${HERMES_PREFIX}"
    mkdir -p "${HERMES_PREFIX}/app"
    # Atomic-ish: extract to a sibling dir, then swap. Failed extract
    # leaves the existing install intact.
    staging="${HERMES_PREFIX}/.staging.$$"
    mkdir -p "${staging}"
    case "${payload}" in
        *.tar.gz|*.tgz) tar -xzf "${payload}" -C "${staging}" ;;
        *.zip)
            command -v unzip >/dev/null 2>&1 || fatal "unzip required to extract .zip"
            unzip -q "${payload}" -d "${staging}"
            ;;
        *.dmg) fatal ".dmg install path is macOS-specific; should be handled by a separate flow. See installer/README.md." ;;
        *) fatal "Unknown payload format: ${payload}" ;;
    esac
    if [ -d "${HERMES_PREFIX}/app" ]; then
        rm -rf "${HERMES_PREFIX}/app.old" 2>/dev/null || true
        mv "${HERMES_PREFIX}/app" "${HERMES_PREFIX}/app.old"
    fi
    mv "${staging}" "${HERMES_PREFIX}/app"
    rm -rf "${HERMES_PREFIX}/app.old" 2>/dev/null || true
    printf '%s\n' "${version}" > "${HERMES_PREFIX}/version"
}

install_os_integration() {
    case "${HERMES_OS}" in
        macos)
            # macOS: drop a symlink in /Applications if the user can write
            # there. Otherwise just leave the .app inside HERMES_PREFIX
            # and let the user drag it.
            app_path="$(find "${HERMES_PREFIX}/app" -maxdepth 2 -name '*.app' -print -quit 2>/dev/null || true)"
            [ -n "${app_path}" ] || return 0
            if [ -w /Applications ]; then
                ln -sfn "${app_path}" "/Applications/$(basename "${app_path}")"
                log "Linked $(basename "${app_path}") into /Applications"
            else
                log "Skipped /Applications symlink (no write access). Launch with: open '${app_path}'"
            fi
            ;;
        linux)
            # Linux: drop a .desktop file in ~/.local/share/applications/
            desk_dir="${HOME}/.local/share/applications"
            mkdir -p "${desk_dir}"
            bin_path="$(find "${HERMES_PREFIX}/app" -maxdepth 2 -type f -name 'hermes-faceplate' -print -quit 2>/dev/null || true)"
            [ -n "${bin_path}" ] || bin_path="${HERMES_PREFIX}/app/hermes-faceplate"
            cat > "${desk_dir}/hermes-faceplate.desktop" <<EOF
[Desktop Entry]
Name=HermesAgent Faceplate
Exec="${bin_path}" %U
Icon=hermes-faceplate
Type=Application
Categories=Utility;
StartupNotify=true
EOF
            log "Wrote ${desk_dir}/hermes-faceplate.desktop"
            ;;
    esac
}

install_cli_shim() {
    mkdir -p "${HERMES_BIN_DIR}"
    shim="${HERMES_BIN_DIR}/hermes-faceplate"
    cat > "${shim}" <<EOF
#!/usr/bin/env sh
exec "${HERMES_PREFIX}/app/hermes-faceplate" "\$@"
EOF
    chmod +x "${shim}"
    case ":${PATH}:" in
        *:"${HERMES_BIN_DIR}":*) : ;;
        *)
            log "Note: ${HERMES_BIN_DIR} is not on your PATH. Add: export PATH=\"${HERMES_BIN_DIR}:\$PATH\""
            ;;
    esac
}

print_postinstall_hint() {
    cat <<EOF

Installed to: ${HERMES_PREFIX}
Run with:     hermes-faceplate    (if ${HERMES_BIN_DIR} is on your PATH)
Log:          ${HERMES_LOG:-${HERMES_PREFIX}/install.log}

Next steps:
  1. Launch the app and complete the onboarding wizard.
  2. Point it at your Hermes gateway URL + API key.
  3. (Optional) Run Kokoro TTS for higher-quality voices:
     docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest

Uninstall:
  curl -fsSL https://get.hermesagent.app/uninstall.sh | sh
EOF
}

main "$@"
