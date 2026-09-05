#!/usr/bin/env bash
# Canonical MangoStudio installer for POSIX shells (Linux, macOS). Published as
# a release asset on both channels and hosted at
# https://github.com/juliopolycarpo/mangostudio/releases/latest/download/install.sh.
# The hub binary also embeds this file verbatim (see
# apps/api/src/modules/updates/infrastructure/embedded-installers.ts) and runs
# it locally for `--use`, `--prune`, and `--uninstall`.
#
# This script is the only thing that writes the install layout under
# MANGOSTUDIO_INSTALL_DIR. Forward-compatibility rule: an older binary's
# embedded copy of this script may install a release newer than itself, so a
# script must never delete or rewrite anything it does not recognise in the
# root — unknown files stay untouched, and rewriting install-origin.json
# carries over every line whose key this script does not know, verbatim.
set -euo pipefail

REPO="juliopolycarpo/mangostudio"
GITHUB_BASE="https://github.com/${REPO}"
GITHUB_API="https://api.github.com/repos/${REPO}"

# Keys install-origin.json may carry. Anything else found on disk is an
# unknown line and is carried over verbatim by record_origin/record_prune.
ORIGIN_KNOWN_KEYS='origin|channel|version|previousVersion|sourceSha|installedAt|source|binDir|prunePending'

# Populated by record_origin/record_prune from the previous install-origin.json
# before it is rewritten; consumed by write_origin_record. A single global
# rather than a return value because bash has no structured return, and every
# caller of write_origin_record already flows through one of those two
# functions.
ORIGIN_EXTRA_LINES=()

usage() {
  cat <<'USAGE'
Usage: install.sh [flags]

Installs MangoStudio into ~/.mango/dist/<version>/ and links ~/.local/bin/mangostudio.

Flags:
  --version <x.y.z>  Install a specific stable version
  --canary           Install the rolling canary pre-release
  --local <archive>  Install from a local archive (.tar.gz release archive or .tgz npm tarball)
  --use <version>    Point at an already installed version without downloading
  --rollback         Point at the version that was current before the last switch
  --prune            Remove installed versions other than current and previous
  --uninstall        Remove the install root and the linked binary
  --help             Show this help message

Environment:
  MANGOSTUDIO_VERSION         Install a specific version instead of latest (the --version flag wins)
  MANGOSTUDIO_INSTALL_DIR     Override the versioned install root
  MANGOSTUDIO_BIN_DIR         Override the user bin directory
  MANGOSTUDIO_INSTALL_ORIGIN  Set to "upgrade" when the hub itself runs this script
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
  normalize_version "${value%"$suffix"}"
}

find_checksum() {
  local manifest="$1"
  local asset_name="$2"
  local checksum filename rest

  # Keep in lockstep with archive-assets.ts, verify-checksum.ts, cargo-shim,
  # and dry-run-checksums.ts; see scripts/tests/support/SHA256SUMS.sample.
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

# --- Canary tag/manifest parsing -------------------------------------------
# Pure text-in, text-out so tests exercise them without a network call.

extract_canary_tag() {
  local releases_json="$1" tag
  tag="$(printf '%s' "$releases_json" \
    | grep -m1 -o '"tag_name": *"v[0-9][^"]*-canary"' \
    | sed -E 's/.*"(v[0-9][^"]*-canary)"$/\1/')" || true
  printf '%s\n' "$tag"
}

parse_manifest_field() {
  local file="$1" key="$2" value
  value="$(grep -m1 -o "\"${key}\": *\"[^\"]*\"" "$file" | sed -E 's/.*"([^"]*)"$/\1/')" || true
  printf '%s\n' "$value"
}

resolve_canary_tag() {
  local releases_json tag
  releases_json="$(curl --retry 3 --retry-delay 2 -fsSL "${GITHUB_API}/releases?per_page=30")"
  tag="$(extract_canary_tag "$releases_json")"
  [ -n "$tag" ] || fail 'no canary release found'
  printf '%s\n' "$tag"
}

# --- install-origin.json -----------------------------------------------
# One key per line by construction, so it can be read and rewritten with
# sed/grep instead of a JSON parser. See the format contract in the task
# that introduced this file (apps/api/src/modules/updates/domain/install-origin.ts).

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

origin_field() {
  local file="$1" key="$2" value
  [ -f "$file" ] || return 0
  value="$(sed -n -E "s/^[[:space:]]*\"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/p" "$file")" || true
  printf '%s\n' "$value"
}

origin_array_field() {
  local file="$1" key="$2" line
  [ -f "$file" ] || return 0
  line="$(sed -n -E "s/^[[:space:]]*\"${key}\"[[:space:]]*:[[:space:]]*\[([^]]*)\].*/\1/p" "$file")" || true
  [ -n "$line" ] || return 0
  printf '%s' "$line" | tr ',' '\n' | sed -E 's/^[[:space:]]*"//; s/"[[:space:]]*$//'
}

# Lines this build does not recognise, comma stripped so write_origin_record
# can re-add it in the right place. Assumes the file was written by this same
# format (opening/closing brace on their own line) — the format every version
# of this script has ever produced.
origin_unknown_lines() {
  local file="$1"
  [ -f "$file" ] || return 0
  sed -e '1d' -e '$d' "$file" \
    | grep -Ev "^[[:space:]]*\"(${ORIGIN_KNOWN_KEYS})\"[[:space:]]*:" \
    | sed -E 's/,[[:space:]]*$//' || true
}

join_json_array() {
  local first=1 item
  for item in "$@"; do
    if [ "$first" -eq 1 ]; then
      first=0
    else
      printf ', '
    fi
    printf '"%s"' "$item"
  done
}

version_channel() {
  case "$1" in
    *-canary*) printf 'canary\n' ;;
    *) printf 'stable\n' ;;
  esac
}

# Write install-origin.json from scratch: known fields (empty ones omitted)
# plus whatever ORIGIN_EXTRA_LINES the caller carried over. Every caller goes
# through record_origin or record_prune, which populate that array.
write_origin_record() {
  local file="$1" origin="$2" channel="$3" version="$4" previous_version="$5" \
    source_sha="$6" installed_at="$7" source_kind="$8" bin_dir="$9" prune_csv="${10}"
  local tmp="${file}.tmp.$$"
  local -a lines=()

  lines+=("  \"origin\": \"${origin}\"")
  lines+=("  \"channel\": \"${channel}\"")
  lines+=("  \"version\": \"${version}\"")
  [ -n "$previous_version" ] && lines+=("  \"previousVersion\": \"${previous_version}\"")
  [ -n "$source_sha" ] && lines+=("  \"sourceSha\": \"${source_sha}\"")
  [ -n "$installed_at" ] && lines+=("  \"installedAt\": \"${installed_at}\"")
  [ -n "$source_kind" ] && lines+=("  \"source\": \"${source_kind}\"")
  [ -n "$bin_dir" ] && lines+=("  \"binDir\": \"$(json_escape "$bin_dir")\"")
  [ -n "$prune_csv" ] && lines+=("  \"prunePending\": [${prune_csv}]")

  local extra
  for extra in "${ORIGIN_EXTRA_LINES[@]+"${ORIGIN_EXTRA_LINES[@]}"}"; do
    [ -n "$extra" ] && lines+=("$extra")
  done

  {
    printf '{\n'
    local count="${#lines[@]}" i=0 line
    for line in "${lines[@]}"; do
      i=$((i + 1))
      if [ "$i" -lt "$count" ]; then
        printf '%s,\n' "$line"
      else
        printf '%s\n' "$line"
      fi
    done
    printf '}\n'
  } > "$tmp"
  mv -f "$tmp" "$file"
}

# Record a pointer swap (fresh install, --use, --rollback). source_kind empty
# carries over the previous record's source (a pointer-only republish did not
# download anything new); source_sha empty drops the field (only a canary
# install that actually resolved a manifest knows its own source commit).
record_origin() {
  local root="$1" origin_kind="$2" new_version="$3" old_version="$4" source_kind="$5" source_sha="$6"
  local file="${root}/install-origin.json"
  local old_source='' prune_csv=''

  ORIGIN_EXTRA_LINES=()
  if [ -f "$file" ]; then
    old_source="$(origin_field "$file" source)"
    local -a prune_arr=()
    local prune_line
    while IFS= read -r prune_line; do prune_arr+=("$prune_line"); done < <(origin_array_field "$file" prunePending)
    prune_csv="$(join_json_array "${prune_arr[@]+"${prune_arr[@]}"}")"
    local extra_line
    while IFS= read -r extra_line; do ORIGIN_EXTRA_LINES+=("$extra_line"); done < <(origin_unknown_lines "$file")
  fi

  local source_val="${source_kind:-$old_source}"
  local channel
  channel="$(version_channel "$new_version")"
  local installed_at
  installed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  write_origin_record "$file" "$origin_kind" "$channel" "$new_version" "$old_version" \
    "$source_sha" "$installed_at" "$source_val" "$BIN_DIR" "$prune_csv"
}

# Record a prune: only prunePending changes, everything else carries over
# unchanged — a prune neither installs nor moves the pointer.
record_prune() {
  local root="$1"
  shift
  local file="${root}/install-origin.json"
  [ -f "$file" ] || return 0

  local origin channel version previous_version source_sha installed_at source_val bin_dir
  origin="$(origin_field "$file" origin)"
  channel="$(origin_field "$file" channel)"
  version="$(origin_field "$file" version)"
  previous_version="$(origin_field "$file" previousVersion)"
  source_sha="$(origin_field "$file" sourceSha)"
  installed_at="$(origin_field "$file" installedAt)"
  source_val="$(origin_field "$file" source)"
  bin_dir="$(origin_field "$file" binDir)"

  ORIGIN_EXTRA_LINES=()
  local extra_line
  while IFS= read -r extra_line; do ORIGIN_EXTRA_LINES+=("$extra_line"); done < <(origin_unknown_lines "$file")

  local prune_csv
  prune_csv="$(join_json_array "$@")"

  write_origin_record "$file" "$origin" "$channel" "$version" "$previous_version" \
    "$source_sha" "$installed_at" "$source_val" "$bin_dir" "$prune_csv"
}

# --- Install layout ----------------------------------------------------

# The version `current` points at (POSIX: a relative symlink, so its target is
# the bare version), falling back to install-origin.json's own record, falling
# back to a legacy bin link/wrapper pointing straight at a version directory.
# Empty output (and failure) means there is no predecessor at all.
current_version() {
  local root="$1"
  if [ -L "${root}/current" ]; then
    readlink "${root}/current"
    return 0
  fi
  return 1
}

# A pre-`current` install: the bin link (or the no-symlink wrapper) points
# straight at "<root>/<version>/mangostudio".
legacy_target_version() {
  local root="$1" bin_link="$2" target='' version
  if [ -L "$bin_link" ]; then
    target="$(readlink "$bin_link")"
  elif [ -f "$bin_link" ]; then
    target="$(sed -n -E 's/^exec "([^"]+)".*/\1/p' "$bin_link")" || true
  fi
  [ -n "$target" ] || return 1

  case "$target" in
    "${root}"/*/mangostudio)
      version="${target#"${root}"/}"
      version="${version%/mangostudio}"
      case "$version" in
        [0-9]*.[0-9]*.[0-9]*)
          printf '%s\n' "$version"
          return 0
          ;;
      esac
      ;;
  esac
  return 1
}

resolve_current_version_or_legacy() {
  local root="$1" version
  if version="$(current_version "$root")" && [ -n "$version" ]; then
    printf '%s\n' "$version"
    return 0
  fi
  if [ -f "${root}/install-origin.json" ]; then
    version="$(origin_field "${root}/install-origin.json" version)"
    if [ -n "$version" ]; then
      printf '%s\n' "$version"
      return 0
    fi
  fi
  if version="$(legacy_target_version "$root" "${BIN_DIR}/mangostudio")" && [ -n "$version" ]; then
    printf '%s\n' "$version"
    return 0
  fi
  return 1
}

# Swap "<root>/current" to point at <version>. Relative symlink so the install
# root stays relocatable. The temp-link-and-rename pattern is not enough on its
# own here: "current" resolves to a directory, and `mv` onto an existing
# symlink-to-a-directory moves the source *into* that directory instead of
# replacing the link (unlike replacing a symlink-to-a-file, which every other
# swap in this script does). Unlinking first keeps the window where "current"
# does not exist as short as a single syscall.
swap_current() {
  local root="$1" version="$2" tmp="${1}/.current.$$"
  rm -f "$tmp"
  ln -s "$version" "$tmp"
  rm -f "${root}/current"
  mv -f "$tmp" "${root}/current"
}

link_binary() {
  local bin_dir="$1" target="$2"
  local link tmp_link
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

print_next_steps() {
  log 'Run: mangostudio serve'
  log 'Then open: http://localhost:3001'
}

# Extract into a scratch directory and return its path. Never touches
# "<install_root>/<version>" — that swap only happens once finish_install has
# smoke-checked these bytes, so a corrupt re-install of an already-installed
# version can never destroy the good directory it is trying to replace.
# strip=1 for an npm tarball, whose members live under package/.
extract_archive() {
  local archive="$1" version="$2" install_root="$3" strip="${4:-0}"
  local tmp_install="${install_root}/.install-${version}.$$"

  mkdir -p "$install_root"
  rm -rf "$tmp_install"
  mkdir -p "$tmp_install"
  if [ "$strip" = '1' ]; then
    tar -xzf "$archive" -C "$tmp_install" --strip-components=1
  else
    tar -xzf "$archive" -C "$tmp_install"
  fi

  [ -f "${tmp_install}/mangostudio" ] || fail 'archive is missing mangostudio'
  chmod +x "${tmp_install}/mangostudio"

  # The execution host for out-of-process environments. MangoStudio resolves it
  # as a sibling of its own executable, so it stays in the install directory and
  # is never linked onto PATH.
  if [ -f "${tmp_install}/mangostudio-runtime" ]; then
    chmod +x "${tmp_install}/mangostudio-runtime"
  fi

  printf '%s\n' "$tmp_install"
}

# Run "<dir>/mangostudio --version" and compare to what we meant to install,
# before the pointer moves. remove_on_failure=1 for a directory this run just
# created (fresh install/local/canary); 0 for --use/--rollback, which reuse a
# directory that predates this run.
smoke_or_fail() {
  local dir="$1" expected="$2" remove_on_failure="$3" actual
  actual="$("${dir}/mangostudio" --version 2>/dev/null)" || actual=''
  [ "$actual" = "$expected" ] && return 0

  [ "$remove_on_failure" = '1' ] && rm -rf "$dir"
  fail "expected version: ${expected} | received: ${actual:-<none>}"
}

# --- Actions -------------------------------------------------------------

finish_install() {
  local archive="$1" version="$2" source_kind="$3" source_sha="$4"
  local strip=0
  [ "$source_kind" = 'npm-registry' ] && strip=1

  local tmp_install install_dir="${INSTALL_ROOT}/${version}"
  tmp_install="$(extract_archive "$archive" "$version" "$INSTALL_ROOT" "$strip")"
  smoke_or_fail "$tmp_install" "$version" 1

  rm -rf "$install_dir"
  mv "$tmp_install" "$install_dir"

  local old_version=''
  old_version="$(resolve_current_version_or_legacy "$INSTALL_ROOT")" || old_version=''

  swap_current "$INSTALL_ROOT" "$version"
  link_binary "$BIN_DIR" "${INSTALL_ROOT}/current/mangostudio"
  record_origin "$INSTALL_ROOT" "$ORIGIN_KIND" "$version" "$old_version" "$source_kind" "$source_sha"

  log "Installed MangoStudio ${version} to ${install_dir}"
  log "Linked ${BIN_DIR}/mangostudio"
  print_path_hint "$BIN_DIR"
  print_next_steps
}

install_from_release() {
  local version
  if [ -n "${VERSION_FLAG:-}" ]; then
    version="$(normalize_version "$VERSION_FLAG")"
  elif [ -n "${MANGOSTUDIO_VERSION:-}" ]; then
    version="$(normalize_version "$MANGOSTUDIO_VERSION")"
  else
    version="$(resolve_latest_version)"
  fi

  local asset_name="mangostudio-${version}-${PLATFORM}.tar.gz"
  local archive_path="${TMP_DIR}/${asset_name}"
  local checksum_path="${TMP_DIR}/SHA256SUMS"
  log "Downloading MangoStudio ${version} for ${PLATFORM}"
  curl_download "${GITHUB_BASE}/releases/download/v${version}/${asset_name}" "$archive_path"
  curl_download "${GITHUB_BASE}/releases/download/v${version}/SHA256SUMS" "$checksum_path"
  verify_checksum "$checksum_path" "$archive_path" "$asset_name"

  finish_install "$archive_path" "$version" 'github-release' ''
}

install_from_local() {
  local archive="$LOCAL_ARCHIVE" version source_kind
  case "$archive" in
    *.tgz)
      if [ -z "${VERSION_FLAG:-}${MANGOSTUDIO_VERSION:-}" ]; then
        fail 'npm archives do not carry a version in their name; pass --version or set MANGOSTUDIO_VERSION'
      fi
      version="$(normalize_version "${VERSION_FLAG:-${MANGOSTUDIO_VERSION}}")"
      source_kind='npm-registry'
      ;;
    *)
      if [ -n "${VERSION_FLAG:-}" ]; then
        version="$(normalize_version "$VERSION_FLAG")"
      elif [ -n "${MANGOSTUDIO_VERSION:-}" ]; then
        version="$(normalize_version "$MANGOSTUDIO_VERSION")"
      else
        version="$(version_from_local_archive "$archive" "$PLATFORM")"
      fi
      source_kind='local-archive'
      ;;
  esac

  log "Installing MangoStudio ${version} from ${archive}"
  finish_install "$archive" "$version" "$source_kind" ''
}

install_from_canary() {
  local tag tag_version asset_name sums_path manifest_path archive_path version source_sha
  tag="$(resolve_canary_tag)"
  tag_version="$(normalize_version "$tag")"
  asset_name="mangostudio-${tag_version}-${PLATFORM}.tar.gz"
  sums_path="${TMP_DIR}/SHA256SUMS"
  manifest_path="${TMP_DIR}/canary-manifest.json"
  archive_path="${TMP_DIR}/${asset_name}"

  log "Resolving canary release ${tag}"
  curl_download "${GITHUB_BASE}/releases/download/${tag}/SHA256SUMS" "$sums_path"

  version="$tag_version"
  source_sha=''
  if curl_download "${GITHUB_BASE}/releases/download/${tag}/canary-manifest.json" "$manifest_path" 2>/dev/null; then
    verify_checksum "$sums_path" "$manifest_path" 'canary-manifest.json'
    local manifest_version
    manifest_version="$(parse_manifest_field "$manifest_path" version)"
    [ -n "$manifest_version" ] && version="$manifest_version"
    source_sha="$(parse_manifest_field "$manifest_path" sourceSha)"
  fi

  log "Downloading MangoStudio ${version} (canary, ${tag}) for ${PLATFORM}"
  curl_download "${GITHUB_BASE}/releases/download/${tag}/${asset_name}" "$archive_path"
  verify_checksum "$sums_path" "$archive_path" "$asset_name"

  finish_install "$archive_path" "$version" 'github-release' "$source_sha"
}

do_install() {
  if [ -n "$LOCAL_ARCHIVE" ]; then
    install_from_local
    return
  fi
  if [ "$CANARY" = '1' ]; then
    install_from_canary
    return
  fi
  install_from_release
}

do_use() {
  local requested="$1" version_dir="${INSTALL_ROOT}/${1}"
  [ -d "$version_dir" ] || fail "version ${requested} is not installed at ${version_dir}"

  smoke_or_fail "$version_dir" "$requested" 0

  local old_version=''
  old_version="$(resolve_current_version_or_legacy "$INSTALL_ROOT")" || old_version=''

  swap_current "$INSTALL_ROOT" "$requested"
  link_binary "$BIN_DIR" "${INSTALL_ROOT}/current/mangostudio"
  record_origin "$INSTALL_ROOT" "$ORIGIN_KIND" "$requested" "$old_version" '' ''

  log "Now using MangoStudio ${requested}"
  print_next_steps
}

do_rollback() {
  local file="${INSTALL_ROOT}/install-origin.json"
  [ -f "$file" ] || fail 'no install-origin.json found; nothing to roll back to'
  local previous
  previous="$(origin_field "$file" previousVersion)"
  [ -n "$previous" ] || fail 'no previous version recorded to roll back to'
  do_use "$previous"
}

do_prune() {
  local current=''
  current="$(resolve_current_version_or_legacy "$INSTALL_ROOT")" || current=''
  [ -n "$current" ] || fail 'no current version recorded; nothing to prune against'

  local previous=''
  if [ -f "${INSTALL_ROOT}/install-origin.json" ]; then
    previous="$(origin_field "${INSTALL_ROOT}/install-origin.json" previousVersion)"
  fi

  local -a remaining=()
  local dir name
  for dir in "$INSTALL_ROOT"/*/; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    case "$name" in
      [0-9]*.[0-9]*.[0-9]*) : ;;
      *) continue ;;
    esac
    [ "$name" = "$current" ] && continue
    [ -n "$previous" ] && [ "$name" = "$previous" ] && continue

    if rm -rf "$dir" 2>/dev/null; then
      log "Removed ${name}"
    else
      log "Could not remove ${name} (close editors or stop the process, then run again)"
      remaining+=("$name")
    fi
  done

  record_prune "$INSTALL_ROOT" "${remaining[@]+"${remaining[@]}"}"
}

do_uninstall() {
  local -a removed=()

  if [ -L "$BIN_LINK" ]; then
    local target
    target="$(readlink "$BIN_LINK")"
    case "$target" in
      "${INSTALL_ROOT}"/*)
        rm -f "$BIN_LINK"
        removed+=("$BIN_LINK")
        ;;
    esac
  elif [ -f "$BIN_LINK" ] && grep -q "exec \"${INSTALL_ROOT}/" "$BIN_LINK" 2>/dev/null; then
    rm -f "$BIN_LINK"
    removed+=("$BIN_LINK")
  fi

  if [ -d "$INSTALL_ROOT" ]; then
    rm -rf "$INSTALL_ROOT"
    removed+=("$INSTALL_ROOT")
  fi

  if [ "${#removed[@]}" -eq 0 ]; then
    log 'Nothing to uninstall.'
    return
  fi

  local item
  for item in "${removed[@]}"; do
    log "Removed ${item}"
  done
}

# Clears TMP_DIR on the way out without letting the trap's own exit status
# stand in for the script's. A bare `trap 'rm -rf "$TMP_DIR"' EXIT` runs
# rm -rf as the last command in the trap; bash preserves an explicit `exit N`
# (fail()'s path) through that regardless, but a `set -u`/`set -e` abort that
# never calls `exit` does not carry a meaningful pending status into the trap
# at all — capturing and restoring $? here is the defensive habit for that
# class of abort in general, even though the specific "unbound variable"
# crash this script used to hit is what the empty-array guards above
# actually eliminate.
cleanup_tmp_dir() {
  rc=$?
  rm -rf "$TMP_DIR"
  exit "$rc"
}

main() {
  ACTION='install'
  VERSION_FLAG=''
  CANARY=0
  LOCAL_ARCHIVE=''
  USE_VERSION=''

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version)
        shift
        [ "$#" -gt 0 ] || fail '--version requires a value'
        VERSION_FLAG="$1"
        ;;
      --canary)
        CANARY=1
        ;;
      --local)
        shift
        [ "$#" -gt 0 ] || fail '--local requires an archive path'
        LOCAL_ARCHIVE="$1"
        ;;
      --use)
        shift
        [ "$#" -gt 0 ] || fail '--use requires a version'
        ACTION='use'
        USE_VERSION="$1"
        ;;
      --rollback)
        ACTION='rollback'
        ;;
      --prune)
        ACTION='prune'
        ;;
      --uninstall)
        ACTION='uninstall'
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
  INSTALL_ROOT="${MANGOSTUDIO_INSTALL_DIR:-${HOME}/.mango/dist}"
  BIN_DIR="${MANGOSTUDIO_BIN_DIR:-${HOME}/.local/bin}"
  BIN_LINK="${BIN_DIR}/mangostudio"
  ORIGIN_KIND='installer'
  [ "${MANGOSTUDIO_INSTALL_ORIGIN:-}" = 'upgrade' ] && ORIGIN_KIND='upgrade'

  TMP_DIR="$(mktemp -d)"
  trap cleanup_tmp_dir EXIT

  case "$ACTION" in
    install) do_install ;;
    use) do_use "$(normalize_version "$USE_VERSION")" ;;
    rollback) do_rollback ;;
    prune) do_prune ;;
    uninstall) do_uninstall ;;
  esac
}

# Run main unless the script is being sourced (e.g. by unit tests). Comparing
# BASH_SOURCE[0] to $0 would wrongly skip `curl ... | bash`, where the script is
# read from stdin and BASH_SOURCE[0] is unset; probing whether `return` is valid
# detects sourcing correctly across direct, piped, and sourced execution.
if ! (return 0 2>/dev/null); then
  main "$@"
fi
