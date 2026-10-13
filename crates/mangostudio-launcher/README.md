# mangostudio (launcher crate)

[MangoStudio](https://mangostudio.dev) is an AI-powered image generation and
chat studio. This crate is a thin launcher that installs the product through the Rust toolchain.
Building it requires Rust 1.99.0 or newer:

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
from any other. Canary launcher versions (`*-canary`) re-download and re-verify
that versioned install on every run. `canary.yml` publishes no crate, so the
only `*-canary` launcher on crates.io is the one published by hand; it resolves
the frozen `v<root>-canary` GitHub pre-release from before 2026-09-16, whose
assets are immutable, so the per-run refresh finds the same bytes every time.

`cargo binstall mangostudio` installs the prebuilt app binary directly from the
matching GitHub release archive instead of building the launcher. The installed
binary is pinned to that crate version and does not use the launcher cache, but
it reports the same `mangostudio --version`. Installing a prebuilt archive does not need a local
Rust compiler. If binstall falls back to compiling the launcher, it requires Rust 1.99.0 or newer.

## Environment overrides

| Variable                  | Effect                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `MANGOSTUDIO_INSTALL_DIR` | Override the versioned install root (default `~/.mango/dist`)                                 |
| `MANGOSTUDIO_DIST_URL`    | Base URL serving the release assets (`<asset>.tar.gz`/`.zip` + `SHA256SUMS`) — testing/mirror |

## Notes

- Downloads retry 3 times with backoff and never run an archive that fails checksum verification.
- musl is detected at **compile** time (`target_env = "musl"`). A glibc-built launcher on Alpine
  picks the glibc archive; Alpine users should prefer the shell installer (runtime musl detection)
  or build this crate with a musl toolchain.
- `cargo binstall` uses the release archive for the matching platform and
  extracts `mangostudio` (or `mangostudio.exe`) directly. If no matching release
  archive exists, binstall can still fall back to compiling this launcher.
