# Light runtime profile: LTO trial

## Result

On 2026-11-13, switching the pull-request `light` runtime profile from thin LTO
to `lto=off` (16 codegen units kept) cut the warm local rebuild of
`mangostudio-runtime` on linux-x64 from about 156 s to about 69 s (-56%) with an
unchanged binary size (35.5 MB, within 0.3%). Only Linux x64 was measured;
Windows and macOS timings are known only from the first hosted run.

## Why

Hosted PR runs with a warm dependency cache still recompile the three workspace
crates, and most of that time is the ThinLTO step over the whole dependency graph.
Run 43188565460 spent 127 s (linux-x64), 298 s (windows-x64) and 86 s
(darwin-arm64) in `Build runtime`.

## Method

`taskset -c 0-3 cargo build -j4 --release --locked -p mangostudio-runtime
--target x86_64-unknown-linux-gnu` with `CARGO_INCREMENTAL=0`, dependencies
already built, and the three workspace crates cleaned before each timed warm
build. The cold column builds everything from an empty target directory. The
`lto=false` row is cargo's thin-local mode, shown for comparison.

| LTO                | Codegen units | Warm rebuild   | Cold build | Binary size (bytes) |
| ------------------ | ------------: | -------------- | ---------: | ------------------: |
| thin (before)      |            16 | 157 s, 155 s   |      237 s |          35,540,928 |
| off (now)          |            16 | 67 s, 70 s     |      184 s |          35,452,688 |
| false (thin-local) |            16 | 87 s (one run) |      229 s |          34,778,080 |

## Limits

- The local thin warm rebuild (156 s) is close to the hosted linux-x64 step
  (127 s), so the proxy is reasonable, but it is a proxy.
- Warm rebuild runs are two samples each (one for `lto=false`).
- Startup time and throughput were not measured. PR light binaries are only
  smoked; nothing publishes them (the distribution manifest records the profile
  name and Release requires `shipping`).
- The `CARGO_*` environment hash in the rust-cache key changes with the profile,
  so the first PR builds after the change run cold until a main push seeds the
  new key.
