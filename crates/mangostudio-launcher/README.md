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
launcher unpacked, every file listed in its `.launcher-record` still has the
recorded size. The record catches truncated or missing files, such as a binary
cut short by a power loss; it does not authenticate anything and has the same
trust as the binary it describes. Trees made by the install scripts or an older
launcher have no record and start as they are.

One rule decides every start that follows a failed repair (offline, lock
trouble, an install in use, a bad download): a binary or runtime whose size
differs from its record line is never started, and the launcher fails with the
reason. If the binaries match the record, or there is no record, the installed
build starts with a warning.

When an install is needed:

- Launchers installing the same version take turns on a lock file,
  `.launcher-<version>.lock`, in the install root. A waiting launcher prints a
  line every 30 seconds and gives up only after an hour, far past a healthy
  install. Nothing is installed without the lock: if it cannot be opened or
  taken (a read-only directory, a file system without locking), the launcher
  starts a build whose binaries match the record, and otherwise fails naming
  the lock file.
- Requests are bounded by silence rather than total time: 30 seconds each to
  resolve and to connect, and 60 seconds for any single read of the response, so
  a slow link that keeps sending finishes and a stalled one ends. Downloads make
  three attempts with backoff, and an archive that fails checksum verification
  is never run.
- The archive is unpacked into a `.launcher-staging-<version>.*` directory,
  recorded, flushed to disk (files and directory on Unix; on Windows the files
  only, since std cannot flush a directory there) and renamed into place. An
  incomplete tree is moved to `.launcher-trash-<version>.*` first and deleted
  after the new one is in, so a hub that holds its files on Windows blocks the
  move instead of being half deleted. The launcher checks that before
  downloading, and starts the installed build with a warning if its binaries
  are intact.
- A start that has to install first adopts a verified staging tree left by a
  launcher that died before the rename, with no download, then removes the
  other scratch directories of dead launchers. A start that needs no install
  removes them only when it can take the lock without waiting. These sweeps are
  safe only because every launcher creates scratch directories under the lock;
  the hub's `.staging-*` and the install scripts' `.install-*` directories are
  never touched.

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

- musl is detected at **compile** time (`target_env = "musl"`). A glibc-built launcher on Alpine
  picks the glibc archive. On Alpine, manually extract the matching `linux-x64-musl` or
  `linux-arm64-musl` release archive and install `libstdc++` (`apk add libstdc++`), or build
  this crate with a musl toolchain. See the
  [manual deployment guide](../../docs/operations/deployment.md#manual-binary-deploy);
  stable `v0.1.1` has no installer-script assets.
- `cargo binstall` uses the release archive for the matching platform and
  extracts `mangostudio` (or `mangostudio.exe`) directly. If no matching release
  archive exists, binstall can still fall back to compiling this launcher.
