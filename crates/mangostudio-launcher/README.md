# mangostudio (launcher crate)

[MangoStudio](https://mangostudio.dev) is an AI-powered image generation and
chat studio. This crate is a thin launcher that installs the product through the Rust toolchain.
Building it requires Rust 1.100.0 or newer:

```bash
cargo install mangostudio
mangostudio serve           # first run downloads the app, then starts http://localhost:3001
```

`cargo install mangostudio` builds this launcher. On first run it downloads the
prebuilt platform archive matching the crate version (the Bun-compiled
`mangostudio` binary with the frontend embedded) from the GitHub release,
verifies it against the release `SHA256SUMS`, and unpacks it into
`~/.mango/dist/<version>/` — the same shared layout the shell installer uses.
Every later run execs the real binary directly with your arguments and
environment untouched, except for two markers — `MANGOSTUDIO_LAUNCHER` and
`MANGOSTUDIO_LAUNCHER_PATH` — that let the binary tell a cargo install apart
from any other. A release never changes under its version, so a complete
install starts with no network request. The launcher resolves its own exact
version, canary versions (`*-canary`) included, never the newest canary release.
See the [historical Cargo canary receipt](../../docs/reference/releasing.md#historical-cargo-canary-receipt)
for the pre-2026-09-16 publication record.

An install counts as complete when the binary exists and, for trees the
launcher unpacked, the files listed in its `.launcher-record` still have the
recorded sizes, which catches a binary truncated by a power loss. Trees made by
the install scripts or an older launcher have no record and start as they are.
When an install is needed:

- Launchers installing the same version take turns on a lock file in the
  install root, waiting up to 15 minutes with a one-line message. If the file
  system refuses locks, an existing install still starts; with none, the
  install proceeds without the lock.
- The archive is unpacked into a `.launcher-staging-<version>.*` directory and
  renamed into place. An existing tree is moved aside to
  `.launcher-rollback-<version>.*` first and deleted after the new one is in
  place, so a running hub keeps its files. If the tree cannot be replaced (a
  Windows hub holds its files) the launcher checks that before downloading,
  warns, and starts the installed build.
- A start under the lock restores a tree left in a rollback directory by an
  interrupted update and removes scratch directories of dead launchers.

`cargo binstall mangostudio` installs the prebuilt app binary directly from the
matching GitHub release archive instead of building the launcher. The installed
binary is pinned to that crate version and does not use the launcher cache, but
it reports the same `mangostudio --version`. Installing a prebuilt archive does not need a local
Rust compiler. If binstall falls back to compiling the launcher, it requires Rust 1.100.0 or newer.

For current two-binary releases, binstall extracts only the hub and omits
`mangostudio-runtime`, so stdio environments cannot start. Use `cargo install`
or [extract the entire archive manually](../../docs/operations/deployment.md#manual-binary-deploy)
to install both binaries together.

## Environment overrides

| Variable                  | Effect                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `MANGOSTUDIO_INSTALL_DIR` | Override the versioned install root (default `~/.mango/dist`)                                 |
| `MANGOSTUDIO_DIST_URL`    | Base URL serving the release assets (`<asset>.tar.gz`/`.zip` + `SHA256SUMS`) — testing/mirror |

## Notes

- Downloads make three total attempts (two retries) with backoff, each request is bounded by a deadline (30 s for `SHA256SUMS`, 10 minutes for the archive), and an archive that fails checksum verification is never run.
- musl is detected at **compile** time (`target_env = "musl"`). A glibc-built launcher on Alpine
  picks the glibc archive. On Alpine, manually extract the matching `linux-x64-musl` or
  `linux-arm64-musl` release archive and install `libstdc++` (`apk add libstdc++`), or build
  this crate with a musl toolchain. See the
  [manual deployment guide](../../docs/operations/deployment.md#manual-binary-deploy);
  stable `v0.1.1` has no installer-script assets.
- `cargo binstall` uses the release archive for the matching platform and
  extracts `mangostudio` (or `mangostudio.exe`) directly. If no matching release
  archive exists, binstall can still fall back to compiling this launcher.
