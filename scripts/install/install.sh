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
  --version <x.y.z>  Install a specific version (stable or pre-release, e.g. 0.2.0-rc.1)
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
  MANGOSTUDIO_INSTALL_LOCK_TIMEOUT
                              Seconds to wait for another installer or launcher of the same
                              version before giving up (digits only, default 3600)
  GITHUB_TOKEN                Authenticates api.github.com requests (GH_TOKEN if unset); raises the
                              rate limit. Release downloads never receive it.
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
  effective_url="$(curl --retry 3 --retry-delay 2 -fsSLI -o /dev/null -w '%{url_effective}' "${GITHUB_BASE}/releases/latest")" \
    || fail "failed to fetch latest release from ${GITHUB_BASE}/releases/latest"
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

  # Keep in lockstep with archive-assets.ts, verify-checksum.ts, the Cargo launcher,
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

# Canary cuts one release per green commit, tagged `v<version>` with the sha the
# build carries (`g`-prefixed when the short sha is an illegal semver numeric
# identifier). The suffix is optional only so the frozen pre-2026-09 rolling tag
# still resolves for an older install; GitHub lists newest first, so the first
# match is the newest build either way.
extract_canary_tag() {
  local releases_json="$1" tag
  # `head -n 1`, not `grep -m1`: the whole payload is one line, so -m1 stops
  # after that line and -o still prints every match on it. With one release per
  # commit there are many, and only the first (newest) is wanted.
  tag="$(printf '%s' "$releases_json" \
    | grep -oE '"tag_name": *"v[0-9][^"]*-canary(\.g?[0-9a-f]{7,40})?"' \
    | head -n 1 \
    | sed -E 's/.*"(v[^"]+)"$/\1/')" || true
  printf '%s\n' "$tag"
}

parse_manifest_field() {
  local file="$1" key="$2" value
  value="$(grep -m1 -o "\"${key}\": *\"[^\"]*\"" "$file" | sed -E 's/.*"([^"]*)"$/\1/')" || true
  printf '%s\n' "$value"
}

# Token for api.github.com requests, set by load_github_api_token and read by
# github_api_curl and describe_github_api_failure. Empty means anonymous. A
# global rather than a command substitution so a refused token exits the script
# itself instead of only a subshell.
GITHUB_API_TOKEN=''

# GITHUB_TOKEN, else GH_TOKEN. An empty value counts as unset, because CI
# systems export an empty GITHUB_TOKEN when no secret is wired.
load_github_api_token() {
  GITHUB_API_TOKEN="${GITHUB_TOKEN:-}"
  [ -n "$GITHUB_API_TOKEN" ] || GITHUB_API_TOKEN="${GH_TOKEN:-}"
  # The token goes inside a quoted curl-config value (see github_api_curl): a
  # quote, a backslash or whitespace would end it early or add a config line.
  # Real GitHub tokens are [A-Za-z0-9_]; refuse anything else without echoing it.
  case "$GITHUB_API_TOKEN" in
    *[![:graph:]]* | *'"'* | *\\*)
      GITHUB_API_TOKEN=''
      fail 'GITHUB_TOKEN/GH_TOKEN contains whitespace, control characters, a quote or a backslash; refusing to send it'
      ;;
  esac
}

# curl for an api.github.com URL, authenticated when load_github_api_token
# found a token. The Authorization header goes in through a curl config on
# stdin, not `-H`, because argv is readable by every local user in `ps`; printf
# is a shell builtin, so the token never lands in an argv either. Only call this
# for api.github.com: the release asset downloads (curl_download) stay
# anonymous. curl itself drops a custom Authorization header when `--location`
# follows a redirect to another host, so an API redirect off api.github.com
# cannot leak it.
github_api_curl() {
  if [ -z "$GITHUB_API_TOKEN" ]; then
    curl "$@"
    return
  fi
  printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_API_TOKEN" | curl --config - "$@"
}

# One response header (case-insensitive name) from a `curl -D` dump. Redirects
# leave several header blocks in the file; the last one is the final response.
# Prints nothing when the header is absent.
response_header() {
  local headers_file="$1" name="$2" value
  value="$(tr -d '\r' < "$headers_file" \
    | grep -i "^${name}:" \
    | tail -n 1 \
    | sed -E 's/^[^:]*:[[:space:]]*//')" || true
  printf '%s\n' "$value"
}

# Epoch seconds as UTC ISO-8601. GNU date reads `-d @N`, BSD/macOS date `-r N`.
format_epoch_utc() {
  local epoch="$1" formatted
  case "$epoch" in
    '' | *[!0-9]*) return 1 ;;
  esac
  formatted="$(date -u -d "@${epoch}" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
    || date -u -r "${epoch}" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || return 1
  printf '%s\n' "$formatted"
}

# The error for a non-2xx api.github.com answer. GitHub signals a rate limit as
# 429, or as 403 with x-ratelimit-remaining 0 (primary limit) or a retry-after
# header (secondary limit); any other refusal keeps its plain status.
describe_github_api_failure() {
  local status="$1" headers_file="$2" url="$3"
  local remaining retry_after reset reset_utc message
  remaining="$(response_header "$headers_file" 'x-ratelimit-remaining')"
  retry_after="$(response_header "$headers_file" 'retry-after')"

  if [ "$status" = 429 ] \
    || { [ "$status" = 403 ] && { [ "$remaining" = 0 ] || [ -n "$retry_after" ]; }; }; then
    reset="$(response_header "$headers_file" 'x-ratelimit-reset')"
    message="GitHub API rate limit exceeded (HTTP ${status})"
    if reset_utc="$(format_epoch_utc "$reset")"; then
      message="${message}; the limit resets at ${reset_utc} (X-RateLimit-Reset: ${reset})"
    elif [ -n "$retry_after" ]; then
      message="${message}; Retry-After: ${retry_after}"
    fi
    # An anonymous request shares the caller's IP quota; a token raises it. When
    # one was already sent, the suggestion would be wrong, so it is left out.
    if [ -z "$GITHUB_API_TOKEN" ]; then
      printf '%s. Wait for it to reset and run the installer again, or set GITHUB_TOKEN to raise the limit.\n' "$message"
    else
      printf '%s. Wait for it to reset, then run the installer again.\n' "$message"
    fi
    return
  fi

  printf 'GitHub API request failed (HTTP %s) for %s\n' "$status" "$url"
}

# Reads the status and headers itself (no `curl -f`) so a refused request is
# reported as such instead of being mistaken for an empty release list.
resolve_canary_tag() {
  local url="${GITHUB_API}/releases?per_page=30"
  local scratch status releases_json message tag
  load_github_api_token
  scratch="$(mktemp -d)" || fail 'failed to create a scratch directory'
  status="$(github_api_curl --retry 3 --retry-delay 2 -sSL -D "${scratch}/headers" -o "${scratch}/body" -w '%{http_code}' "$url")" \
    || { rm -rf "$scratch"; fail "failed to fetch canary releases from ${url}"; }
  case "$status" in
    2??)
      releases_json="$(cat "${scratch}/body")"
      ;;
    *)
      message="$(describe_github_api_failure "$status" "${scratch}/headers" "$url")"
      rm -rf "$scratch"
      fail "$message"
      ;;
  esac
  rm -rf "$scratch"
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
  local old_source='' prune_csv='' previous_version="$old_version"

  ORIGIN_EXTRA_LINES=()
  if [ -f "$file" ]; then
    old_source="$(origin_field "$file" source)"
    local -a prune_arr=()
    local prune_line
    while IFS= read -r prune_line; do prune_arr+=("$prune_line"); done < <(origin_array_field "$file" prunePending)
    prune_csv="$(join_json_array "${prune_arr[@]+"${prune_arr[@]}"}")"
    local extra_line
    while IFS= read -r extra_line; do ORIGIN_EXTRA_LINES+=("$extra_line"); done < <(origin_unknown_lines "$file")

    # A repair install, a retried upgrade, or `--use <current>` reports
    # old_version == new_version: the pointer never actually moved. Keep the
    # rollback anchor pointing at whatever it already recorded instead of
    # collapsing previousVersion onto the version that is not changing.
    if [ "$new_version" = "$old_version" ]; then
      previous_version="$(origin_field "$file" previousVersion)"
    fi
  fi

  local source_val="${source_kind:-$old_source}"
  local channel
  channel="$(version_channel "$new_version")"
  local installed_at
  installed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  write_origin_record "$file" "$origin_kind" "$channel" "$new_version" "$previous_version" \
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
# Replace the `current` symlink in one step. `mv -f tmp current` on its own
# stats the destination, sees a directory through the existing link, and moves
# the new link *inside* the version directory it points at — so the old
# rm-then-mv had to blank `current` first, leaving a window where another
# process (a second CLI, the hub's own prune) reads no pointer at all, and
# losing the race left a stray `.current.<pid>` inside a version directory.
# `-T` (GNU) and `-h` (BSD/macOS) both mean "the destination is the link
# itself"; where neither is understood, fall back to the old two-step.
swap_current() {
  local root="$1" version="$2" tmp="${1}/.current.$$"
  rm -f "$tmp"
  ln -s "$version" "$tmp"
  if mv -Tf "$tmp" "${root}/current" 2>/dev/null; then return; fi
  if mv -hf "$tmp" "${root}/current" 2>/dev/null; then return; fi
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

# --- Version lock --------------------------------------------------------
#
# The Cargo launcher (crates/mangostudio-launcher) serializes every install of
# one version on an exclusive advisory lock on "<install root>/.launcher-<version>.lock"
# (flock(2) on Unix, LockFileEx on Windows, where install.ps1 takes it). Replacing
# "<install root>/<version>" here without that lock lets a launcher's move land between
# this script's rm and mv, or lets this rm delete the tree the launcher just moved in.
# So the swap, and a prune's removal of a version, hold the same lock on the same file.
#
# The lock is on file descriptor 200, which stays open in this shell until
# release_version_lock (or exit) and is inherited by the helper that takes it.
# A launcher or script that dies drops the lock with its descriptors.

# Seconds to wait for another installer of the same version before giving up.
# The launcher's own ceiling is an hour; the variable exists for tests.
INSTALL_LOCK_TIMEOUT="${MANGOSTUDIO_INSTALL_LOCK_TIMEOUT:-3600}"
INSTALL_LOCK_TIMEOUT_DEFAULT=3600
INSTALL_LOCK_NOTICE_EVERY=30

# A value that is not a plain count of seconds ("10s", "-1", "1.5") would make
# the `[ -ge ]` comparison in acquire_version_lock fail on every pass and the
# wait never end, so it is replaced with the default, as install.ps1 does. At
# most 9 digits, so the comparison stays inside a shell's integer range.
validate_install_lock_timeout() {
  case "$INSTALL_LOCK_TIMEOUT" in
    '' | *[!0-9]* | ??????????*)
      printf 'Warning: MANGOSTUDIO_INSTALL_LOCK_TIMEOUT=%s is not a whole number of seconds; using %s\n' \
        "$INSTALL_LOCK_TIMEOUT" "$INSTALL_LOCK_TIMEOUT_DEFAULT" >&2
      INSTALL_LOCK_TIMEOUT="$INSTALL_LOCK_TIMEOUT_DEFAULT"
      ;;
  esac
}

have_command() {
  command -v "$1" >/dev/null 2>&1
}

# One non-blocking attempt at the lock on descriptor 200. Returns 0 when it is
# taken, 1 when another process holds it, 2 when this host cannot lock at all
# (no tool, or a file system without locking).
# flock(1) is util-linux and busybox; macOS has neither, but always has perl,
# whose flock is the same flock(2) call and acts on the descriptor it inherits.
# util-linux exits 1 for a held lock and another code for any other failure.
# busybox exits 1 for both (flock.c returns EXIT_FAILURE on EWOULDBLOCK and
# dies with its default status 1 on any other errno, such as ENOLCK), but only
# the second prints a message, so exit 1 with output is "cannot lock".
try_lock_fd() {
  local status=0 complaint=''
  if have_command flock; then
    complaint="$(flock -n 200 2>&1)" || status=$?
    case "$status" in
      0) return 0 ;;
      1)
        if [ -z "$complaint" ]; then return 1; fi
        return 2
        ;;
      *) return 2 ;;
    esac
  fi
  if have_command perl; then
    perl -MFcntl=:flock -e 'open(my $lock, ">&=", 200) or exit 2; flock($lock, LOCK_EX | LOCK_NB) and exit 0; exit($!{EWOULDBLOCK} ? 1 : 2)' || status=$?
    case "$status" in
      0 | 1) return "$status" ;;
      *) return 2 ;;
    esac
  fi
  return 2
}

# Take the lock of <version>, waiting for another holder. Returns 1 (after
# saying why) only when the holder outlasts INSTALL_LOCK_TIMEOUT. A host that
# cannot lock is warned about and let through: that is how installs ran before
# this lock existed, and failing there would turn a hardening into an outage.
acquire_version_lock() {
  local root="$1" version="$2" lock status waited=0 next_notice=0
  lock="${root}/.launcher-${version}.lock"

  mkdir -p "$root"
  if ! { exec 200>>"$lock"; } 2>/dev/null; then
    printf 'Warning: cannot open %s; continuing without the install lock\n' "$lock" >&2
    return 0
  fi

  while true; do
    status=0
    try_lock_fd || status=$?
    case "$status" in
      0) return 0 ;;
      1) ;;
      *)
        exec 200>&-
        printf 'Warning: cannot lock %s (needs flock or perl, and a file system with locking); continuing without the install lock\n' "$lock" >&2
        return 0
        ;;
    esac

    if [ "$waited" -ge "$INSTALL_LOCK_TIMEOUT" ]; then
      exec 200>&-
      printf 'Error: another installer is still using %s after %ss (lock %s); not waiting longer. Run the command again once it finishes.\n' \
        "$version" "$waited" "$lock" >&2
      return 1
    fi
    if [ "$waited" -ge "$next_notice" ]; then
      log "Waiting for another installer to finish with ${version} (${waited}s so far)..."
      next_notice=$((waited + INSTALL_LOCK_NOTICE_EVERY))
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

# Drop the lock taken by acquire_version_lock. A no-op when none is held.
release_version_lock() {
  exec 200>&-
}

# The scratch directory this process extracts <version> into. $$ is the main
# shell's pid even inside a command substitution, so finish_install can name the
# directory (for the exit trap) before extract_archive creates it.
install_scratch_path() {
  printf '%s\n' "${1}/.install-${2}.$$"
}

# Extract into a scratch directory and return its path. Never touches
# "<install_root>/<version>" — that swap only happens once finish_install has
# smoke-checked these bytes, so a corrupt re-install of an already-installed
# version can never destroy the good directory it is trying to replace.
# strip=1 for an npm tarball, whose members live under package/.
extract_archive() {
  local archive="$1" version="$2" install_root="$3" strip="${4:-0}"
  local tmp_install
  tmp_install="$(install_scratch_path "$install_root" "$version")"

  mkdir -p "$install_root"
  rm -rf "$tmp_install"
  mkdir -p "$tmp_install"
  if [ "$strip" = '1' ]; then
    tar -xzf "$archive" -C "$tmp_install" --strip-components=1 || {
      rm -rf "$tmp_install"
      fail 'failed to extract archive'
    }
  else
    tar -xzf "$archive" -C "$tmp_install" || {
      rm -rf "$tmp_install"
      fail 'failed to extract archive'
    }
  fi

  if [ ! -f "${tmp_install}/mangostudio" ]; then
    rm -rf "$tmp_install"
    fail 'archive is missing mangostudio'
  fi
  chmod +x "${tmp_install}/mangostudio"

  # The execution host for out-of-process environments. MangoStudio resolves it
  # as a sibling of its own executable, so it stays in the install directory and
  # is never linked onto PATH.
  if [ -f "${tmp_install}/mangostudio-runtime" ]; then
    chmod +x "${tmp_install}/mangostudio-runtime"
  fi

  printf '%s\n' "$tmp_install"
}

# The one-line remedy for a hub the musl loader could not start, or nothing.
# Keyed on musl's own loader message ("Error loading shared library <lib>: No
# such file or directory"), so a glibc host or an unrelated failure gets no
# apk advice. $1 is the probe's stderr.
missing_library_hint() {
  local line lib='' package
  while IFS= read -r line; do
    case "$line" in
      *'Error loading shared library '*': No such file or directory'*)
        lib="${line#*Error loading shared library }"
        lib="${lib%%:*}"
        break
        ;;
    esac
  done <<EOF
$1
EOF
  [ -n "$lib" ] || return 0

  case "$lib" in
    libstdc++*) package='libstdc++' ;;
    libgcc_s*) package='libgcc' ;;
    *) package='' ;;
  esac

  if [ -n "$package" ]; then
    printf 'hint: %s is not installed; on Alpine run: apk add %s\n' "$lib" "$package"
  else
    printf 'hint: %s is not installed; install the package that provides it\n' "$lib"
  fi
}

# Run "<dir>/mangostudio --version" and compare to what we meant to install,
# before the pointer moves. remove_on_failure=1 for a directory this run just
# created (fresh install/local/canary); 0 for --use/--rollback, which reuse a
# directory that predates this run. A probe that exits non-zero or writes to
# stderr has its status and stderr appended to the error, so the reason the
# hub did not run (a missing shared library, say) reaches the user.
smoke_or_fail() {
  local dir="$1" expected="$2" remove_on_failure="$3" actual status
  local scratch stderr_text message hint
  scratch="$(mktemp -d)"
  printf '0\n' >"${scratch}/status"
  # stderr goes through a pipe, never to disk: the reader keeps the first ten
  # lines and drains the rest, so a hub that floods stderr cannot fill /tmp.
  stderr_text="$(
    { "${dir}/mangostudio" --version 2>&1 >"${scratch}/stdout" ||
      printf '%s\n' "$?" >"${scratch}/status"; } | { head -n 10; cat >/dev/null; }
  )"
  status="$(cat "${scratch}/status")"
  actual="$(cat "${scratch}/stdout")"
  rm -rf "$scratch"
  [ "$status" -ne 0 ] && actual=''
  [ "$actual" = "$expected" ] && return 0

  [ "$remove_on_failure" = '1' ] && rm -rf "$dir"
  message="expected version: ${expected} | received: ${actual:-<none>}"
  if [ "$status" -ne 0 ]; then
    message="${message}
  probe: ${dir}/mangostudio --version | expected: exit status: 0 | received: exit status: ${status}"
  fi
  if [ -n "$stderr_text" ]; then
    # Continuation lines line up under the first so the block reads as one.
    stderr_text="$(printf '%s\n' "$stderr_text" | sed '2,$s/^/          /')"
    message="${message}
  stderr: ${stderr_text}"
  fi
  hint="$(missing_library_hint "$stderr_text")"
  if [ -n "$hint" ]; then
    message="${message}
  ${hint}"
  fi
  fail "$message"
}

# --- Actions -------------------------------------------------------------

finish_install() {
  local archive="$1" version="$2" source_kind="$3" source_sha="$4"
  local strip=0
  [ "$source_kind" = 'npm-registry' ] && strip=1

  local tmp_install install_dir="${INSTALL_ROOT}/${version}"
  # Registered for the exit trap before it exists and until the mv below, so an
  # interrupt (Ctrl-C during the up-to-an-hour lock wait, a SIGTERM) or any
  # failure on the way removes it instead of leaving `.install-<version>.<pid>`.
  INSTALL_SCRATCH="$(install_scratch_path "$INSTALL_ROOT" "$version")"
  tmp_install="$(extract_archive "$archive" "$version" "$INSTALL_ROOT" "$strip")"
  smoke_or_fail "$tmp_install" "$version" 1

  # The smoke check ran on the scratch copy, so the lock is held only for the
  # swap itself: no launcher or second installer can move a tree in between
  # the rm and the mv.
  acquire_version_lock "$INSTALL_ROOT" "$version" || exit 1
  rm -rf "$install_dir"
  mv "$tmp_install" "$install_dir"
  INSTALL_SCRATCH=''
  release_version_lock

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

    # A launcher installing this version holds its lock while it moves a tree
    # in; a prune that outwaits it leaves the version for the next run.
    if ! acquire_version_lock "$INSTALL_ROOT" "$name"; then
      log "Could not remove ${name} (another installer holds its lock; run again once it finishes)"
      remaining+=("$name")
      continue
    fi
    if rm -rf "$dir" 2>/dev/null; then
      release_version_lock
      log "Removed ${name}"
    else
      release_version_lock
      log "Could not remove ${name} (close editors or stop the process, then run again)"
      remaining+=("$name")
    fi
  done

  # Leftover scratch directories from an install/upgrade that failed before
  # the swap (extract_archive) or was interrupted mid-flight. They never
  # match the version glob above, so a plain prune leaves them to accumulate
  # forever; sweep them explicitly.
  for dir in "$INSTALL_ROOT"/.install-*/ "$INSTALL_ROOT"/.staging-*/ "$INSTALL_ROOT"/.rollback-*/; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    if rm -rf "$dir" 2>/dev/null; then
      log "Removed ${name}"
    else
      log "Could not remove ${name} (close editors or stop the process, then run again)"
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
#
# It also removes INSTALL_SCRATCH, the `.install-<version>.<pid>` tree of an
# install that has not been moved into place yet.
cleanup_tmp_dir() {
  rc=$?
  rm -rf "$TMP_DIR"
  if [ -n "${INSTALL_SCRATCH:-}" ]; then
    rm -rf "$INSTALL_SCRATCH"
  fi
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
  validate_install_lock_timeout
  INSTALL_ROOT="${MANGOSTUDIO_INSTALL_DIR:-${HOME}/.mango/dist}"
  BIN_DIR="${MANGOSTUDIO_BIN_DIR:-${HOME}/.local/bin}"
  BIN_LINK="${BIN_DIR}/mangostudio"
  ORIGIN_KIND='installer'
  [ "${MANGOSTUDIO_INSTALL_ORIGIN:-}" = 'upgrade' ] && ORIGIN_KIND='upgrade'

  INSTALL_SCRATCH=''
  TMP_DIR="$(mktemp -d)"
  trap cleanup_tmp_dir EXIT
  # Without these, a Ctrl-C that lands while bash forks a child (the lock
  # wait's `sleep` and `flock` every second) is swallowed: the child shrugs the
  # signal off before it execs, exits normally, and bash then carries on. A trap
  # makes the interrupt always end the script, through the EXIT trap above.
  trap 'exit 130' INT
  trap 'exit 143' TERM

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
