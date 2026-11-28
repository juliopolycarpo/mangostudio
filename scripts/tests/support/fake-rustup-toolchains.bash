#!/usr/bin/env bash
# Named fake for the rust-cache composite's `prune` step. Materialize this file as `rustup` in a
# fake PATH (scripts/tests/rust-cache-action.unit.test.ts does). It keeps a toolchain list in the
# file named by FAKE_RUSTUP_STATE (one name per line) and logs every call to FAKE_RUSTUP_LOG, so
# nothing touches the real rustup.
#
# It answers the calls the step may make:
#   toolchain install            adds FAKE_RUSTUP_PINNED when it is missing (the active toolchain)
#   show active-toolchain        prints FAKE_RUSTUP_PINNED the way rustup does, with its reason;
#                                with FAKE_RUSTUP_NO_ACTIVE set it fails the way rustup does
#   toolchain list --quiet       prints the list
#   toolchain uninstall NAME...  removes each name; a name that is not installed exits 1
#   default NAME                 logged only
# With FAKE_RUSTUP_CRLF set, output ends its lines with CRLF, as rustup does on Windows.
# Any other call exits 64 and says what it received.
set -euo pipefail

call="$*"
printf '%s\n' "$call" >>"${FAKE_RUSTUP_LOG:?expected FAKE_RUSTUP_LOG}"
state=${FAKE_RUSTUP_STATE:?expected FAKE_RUSTUP_STATE}
pinned=${FAKE_RUSTUP_PINNED:?expected FAKE_RUSTUP_PINNED}
eol=''
if [ -n "${FAKE_RUSTUP_CRLF:-}" ]; then eol=$'\r'; fi

case "$call" in
'toolchain install')
  grep -qxF "$pinned" "$state" || printf '%s\n' "$pinned" >>"$state"
  ;;
'show active-toolchain')
  if [ -n "${FAKE_RUSTUP_NO_ACTIVE:-}" ]; then
    echo 'error: no active toolchain' >&2
    exit 1
  fi
  printf "%s (overridden by '/checkout/rust-toolchain.toml')%s\n" "$pinned" "$eol"
  ;;
'toolchain list --quiet')
  while IFS= read -r name; do
    printf '%s%s\n' "$name" "$eol"
  done <"$state"
  ;;
'toolchain uninstall '*)
  shift 2
  for name in "$@"; do
    if ! grep -qxF "$name" "$state"; then
      echo "fake rustup: expected an installed toolchain to uninstall | received: $name" >&2
      exit 1
    fi
    grep -vxF "$name" "$state" >"$state.next" || true
    mv "$state.next" "$state"
  done
  ;;
'default '*) ;;
*)
  echo "fake rustup: expected 'toolchain install', 'show active-toolchain', 'toolchain list --quiet', 'toolchain uninstall <name>...' or 'default <name>' | received: $call" >&2
  exit 64
  ;;
esac
