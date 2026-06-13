#!/usr/bin/env bash
set -euo pipefail

REPO="juliopolycarpo/mangostudio"
GITHUB_BASE="https://github.com/${REPO}"
LOCAL_ARCHIVE=""

usage() {
  cat <<'USAGE'
Usage: install.sh [--local archive.tar.gz]

Installs MangoStudio into ~/.mango/dist/<version>/ and links ~/.local/bin/mangostudio.

Environment:
  MANGOSTUDIO_VERSION      Install a specific version instead of latest
  MANGOSTUDIO_INSTALL_DIR  Override the versioned install root
  MANGOSTUDIO_BIN_DIR      Override the user bin directory
USAGE
}

log() {
  printf '%s\n' "$1"
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

normalize_version() {
  local version="$1"
  version="${version#v}"
  [ -n "$version" ] || fail 'version is empty'
  printf '%s\n' "$version"
}

is_musl_linux() {
  [ "$(uname -s)" = 'Linux' ] || return 1
  [ -f /etc/alpine-release ] && return 0

  if command -v ldd >/dev/null 2>&1; then
    local ldd_output
    ldd_output="$(ldd --version 2>&1 || true)"
    case "$ldd_output" in
      *musl* | *Musl*) return 0 ;;
    esac
  fi

  return 1
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x64\n' ;;
    arm64 | aarch64) printf 'arm64\n' ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
}

detect_platform() {
  local os arch suffix
  arch="$(detect_arch)"
  suffix=""

  case "$(uname -s)" in
    Linux) os='linux' ;;
    Darwin) os='darwin' ;;
    *) fail "unsupported OS: $(uname -s)" ;;
  esac

  if [ "$os" = 'linux' ] && is_musl_linux; then
    suffix='-musl'
  fi

  printf '%s-%s%s\n' "$os" "$arch" "$suffix"
}

curl_download() {
  local url="$1"
  local output="$2"
  curl --retry 3 --retry-delay 2 -fL "$url" -o "$output"
}

resolve_latest_version() {
  local effective_url tag
  effective_url="$(curl --retry 3 --retry-delay 2 -fsSLI -o /dev/null -w '%{url_effective}' "${GITHUB_BASE}/releases/latest")"
  tag="${effective_url##*/}"
  normalize_version "$tag"
}

version_from_local_archive() {
  local archive="$1"
  local platform="$2"
  local name value suffix
  name="${archive##*/}"
  suffix="-${platform}.tar.gz"

  [[ "$name" == mangostudio-*"$suffix" ]] || fail "local archive does not match ${platform}: ${name}"
  value="${name#mangostudio-}"
  normalize_version "${value%$suffix}"
}

resolve_version() {
  local platform="$1"
  if [ -n "${MANGOSTUDIO_VERSION:-}" ]; then
    normalize_version "$MANGOSTUDIO_VERSION"
    return
  fi

  if [ -n "$LOCAL_ARCHIVE" ]; then
    version_from_local_archive "$LOCAL_ARCHIVE" "$platform"
    return
  fi

  resolve_latest_version
}

find_checksum() {
  local manifest="$1"
  local asset_name="$2"
  local checksum filename rest

  # Keep in lockstep with archive-assets.ts, verify-checksum.ts, cargo-shim,
  # and install.ps1; see scripts/tests/support/SHA256SUMS.sample.
  while read -r checksum filename rest || [ -n "${checksum:-}" ]; do
    filename="${filename#\*}"
    if [ "$filename" = "$asset_name" ]; then
      printf '%s\n' "$checksum" | tr '[:upper:]' '[:lower:]'
      return 0
    fi
  done < "$manifest"

  fail "SHA256SUMS does not contain ${asset_name}"
}

calculate_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | cut -d ' ' -f 1
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | cut -d ' ' -f 1
    return
  fi

  fail 'sha256sum or shasum is required to verify downloads'
}

verify_checksum() {
  local manifest="$1"
  local archive="$2"
  local asset_name="$3"
  local expected actual
  expected="$(find_checksum "$manifest" "$asset_name")"
  actual="$(calculate_sha256 "$archive")"

  [ "$expected" = "$actual" ] || fail "checksum mismatch for ${asset_name}"
  log "Checksum verified: ${asset_name}"
}

install_archive() {
  local archive="$1"
  local version="$2"
  local install_root="$3"
  local install_dir tmp_install
  install_dir="${install_root}/${version}"
  tmp_install="${install_root}/.install-${version}.$$"

  mkdir -p "$install_root"
  rm -rf "$tmp_install"
  mkdir -p "$tmp_install"
  tar -xzf "$archive" -C "$tmp_install"

  [ -f "${tmp_install}/mangostudio" ] || fail 'archive is missing mangostudio'
  [ -f "${tmp_install}/public/index.html" ] || fail 'archive is missing public/index.html'
  chmod +x "${tmp_install}/mangostudio"

  rm -rf "$install_dir"
  mv "$tmp_install" "$install_dir"
  printf '%s\n' "$install_dir"
}

link_binary() {
  local install_dir="$1"
  local bin_dir="$2"
  local target link tmp_link
  target="${install_dir}/mangostudio"
  link="${bin_dir}/mangostudio"
  tmp_link="${bin_dir}/.mangostudio.$$"

  mkdir -p "$bin_dir"
  rm -f "$tmp_link"

  if ln -s "$target" "$tmp_link" 2>/dev/null; then
    mv -f "$tmp_link" "$link"
    return
  fi

  printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "$target" > "$tmp_link"
  chmod +x "$tmp_link"
  mv -f "$tmp_link" "$link"
}

print_path_hint() {
  local bin_dir="$1"
  case ":${PATH:-}:" in
    *":${bin_dir}:"*) return ;;
  esac

  log "Add ${bin_dir} to your PATH to run mangostudio from any shell."
}

main() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --local)
        shift
        [ "$#" -gt 0 ] || fail '--local requires an archive path'
        LOCAL_ARCHIVE="$1"
        ;;
      --help | -h)
        usage
        exit 0
        ;;
      *) fail "unknown argument: $1" ;;
    esac
    shift
  done

  PLATFORM="$(detect_platform)"
  VERSION="$(resolve_version "$PLATFORM")"
  ASSET_NAME="mangostudio-${VERSION}-${PLATFORM}.tar.gz"
  INSTALL_ROOT="${MANGOSTUDIO_INSTALL_DIR:-${HOME}/.mango/dist}"
  BIN_DIR="${MANGOSTUDIO_BIN_DIR:-${HOME}/.local/bin}"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  if [ -n "$LOCAL_ARCHIVE" ]; then
    ARCHIVE_PATH="$LOCAL_ARCHIVE"
    log "Installing MangoStudio ${VERSION} from ${LOCAL_ARCHIVE}"
  else
    ARCHIVE_PATH="${TMP_DIR}/${ASSET_NAME}"
    CHECKSUM_PATH="${TMP_DIR}/SHA256SUMS"
    log "Downloading MangoStudio ${VERSION} for ${PLATFORM}"
    curl_download "${GITHUB_BASE}/releases/download/v${VERSION}/${ASSET_NAME}" "$ARCHIVE_PATH"
    curl_download "${GITHUB_BASE}/releases/download/v${VERSION}/SHA256SUMS" "$CHECKSUM_PATH"
    verify_checksum "$CHECKSUM_PATH" "$ARCHIVE_PATH" "$ASSET_NAME"
  fi

  INSTALL_DIR="$(install_archive "$ARCHIVE_PATH" "$VERSION" "$INSTALL_ROOT")"
  link_binary "$INSTALL_DIR" "$BIN_DIR"
  log "Installed MangoStudio ${VERSION} to ${INSTALL_DIR}"
  log "Linked ${BIN_DIR}/mangostudio"
  print_path_hint "$BIN_DIR"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
