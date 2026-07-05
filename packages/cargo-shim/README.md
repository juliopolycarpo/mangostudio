# mangostudio (launcher crate)

[MangoStudio](https://mangostudio.dev) is an AI-powered image generation and
chat studio. This crate is **not the application source** — it is a thin launcher so the Rust
toolchain can install the product:

```bash
cargo install mangostudio   # or: cargo binstall mangostudio
mangostudio serve           # first run downloads the app, then starts http://localhost:3001
```

On first run the launcher downloads the prebuilt platform archive matching the crate version (the
Bun-compiled `mangostudio` binary with the frontend embedded) from the GitHub release,
verifies it against the release `SHA256SUMS`, and unpacks it into `~/.mango/dist/<version>/` — the
same shared layout the shell installer uses. Every later run execs the real binary directly with
your arguments and environment untouched. Canary launcher versions (`*-canary`) refresh that
versioned install before every run so they track the rolling canary release assets.

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
- `cargo binstall` prebuilt strategies are intentionally disabled: binstall's
  binary-only extraction would omit the Cursor SDK sidecar and other archive
  members. binstall falls back to compiling this launcher, which installs the
  complete archive instead.
