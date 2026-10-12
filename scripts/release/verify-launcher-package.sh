#!/usr/bin/env bash
# Verify the launcher consumers receive: package it, check its normalized MSRV,
# then install it without access to the checkout's workspace or Cargo config.
# Usage: bash scripts/release/verify-launcher-package.sh

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
expected_msrv="$(sed -n 's/^rust-version = "\([^"]*\)"$/\1/p' "$repository_root/Cargo.toml")"
if [[ ! "$expected_msrv" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid workspace rust-version '${expected_msrv:-<missing>}'; expected a major.minor.patch version in Cargo.toml" >&2
  exit 1
fi

# An explicit override survives leaving the checkout, where rustup would
# otherwise fall back to the runner's default toolchain.
export RUSTUP_TOOLCHAIN="$expected_msrv"
temporary_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
workdir="$(mktemp -d "$temporary_root/mangostudio-launcher-package.XXXXXX")"
trap 'rm -rf "$workdir"' EXIT
workdir="$(cd "$workdir" && pwd -P)"
if [[ "$workdir" == "$repository_root/"* ]]; then
  echo "Invalid package verification directory '$workdir'; expected a temporary directory outside '$repository_root'" >&2
  exit 1
fi

cd "$repository_root"
cargo package --locked --no-verify --manifest-path crates/mangostudio-launcher/Cargo.toml \
  --target-dir "$workdir/package-target"

shopt -s nullglob
archives=("$workdir/package-target/package"/mangostudio-*.crate)
if [ "${#archives[@]}" -ne 1 ]; then
  echo "Invalid launcher package count '${#archives[@]}'; expected one mangostudio-*.crate archive" >&2
  exit 1
fi

mkdir "$workdir/source"
tar -xzf "${archives[0]}" -C "$workdir/source"
manifests=("$workdir/source"/mangostudio-*/Cargo.toml)
if [ "${#manifests[@]}" -ne 1 ]; then
  echo "Invalid packaged manifest count '${#manifests[@]}'; expected one mangostudio-*/Cargo.toml" >&2
  exit 1
fi
manifest="${manifests[0]}"
actual_msrv="$(sed -n 's/^rust-version = "\([^"]*\)"$/\1/p' "$manifest")"
if [ "$actual_msrv" != "$expected_msrv" ]; then
  echo "Invalid packaged launcher rust-version '${actual_msrv:-<missing>}'; expected '$expected_msrv'" >&2
  exit 1
fi

cd "$workdir"
cargo install --path "$(dirname "$manifest")" --locked \
  --root "$workdir/install" --target-dir "$workdir/install-target"
echo "Verified packaged launcher rust-version=$actual_msrv and isolated cargo install with Rust $RUSTUP_TOOLCHAIN"
