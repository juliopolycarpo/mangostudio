# Versioning

Three numbers live in this repository and they move for different reasons.

## Wire version

`protocol.major` and `protocol.minor` in `hello`. The wire version says what frames and members
two peers may exchange.

- **Major** changes when a peer on the old major could misread a frame from the new one:
  a member changes meaning or type, a frame type is removed, a rule in the spec is reversed.
  A new major gets a new spec document and a new `spec/schema/<major>/` directory. Peers on
  different majors refuse each other with close code `4426`.
- **Minor** changes when something is added: a member (always optional), a frame type, a
  reserved error code, a rule that only constrains the sender. Each peer announces the highest
  minor it implements; the session runs at the lower of the two. Anything added in a minor is
  behind that number, never behind a capability flag, and decoders ignore what they do not know.
- There is no wire patch number. A clarification that changes no bytes is an erratum to the
  spec text.

`spec/mango-protocol-1.md` describes wire major 1 and carries the table of what each minor
added. The minors so far:

| Minor | Added                                       | Shipped in |
| ----- | ------------------------------------------- | ---------- |
| `1.0` | The wire as first published.                | `0.1.0`    |
| `1.1` | `hello.limits.maxInFlight`, `rpc.discover`. | `0.2.0`    |

A minor is announced, never negotiated away: both peers send the highest they implement and the
session runs at the lower. There is nothing to turn on.

## Package version

`@mangostudio/protocol` on npm and `mango-protocol` on crates.io share one semantic version,
released together from one git tag `v<version>`. The package version says which SDK build you
have; it is independent of the wire version it speaks, except that a package's changelog
states the highest wire minor it implements.

- `0.x`: the wire may still change in a minor package release; the changelog says so.
- `1.0.0`: the wire is frozen at major 1 and package majors follow SemVer for the SDK API.

`bun run release:prepare <version>` moves both manifests in lockstep; CI refuses a tag whose
manifests disagree.

## Schema files

`spec/schema/<major>/protocol.json` and `catalog.json` carry a `$id` under
`https://mangostudio.dev/protocol/schema/<major>/` and are attached to every GitHub release.
Their content changes only with a wire change, so a schema file is versioned by the wire major
it describes and by the release that published it. An editorial fix to a schema (a description,
a tightened pattern that no valid frame violated) ships in a package release without a wire bump.

## What counts as breaking

| Change                                              | Wire  | Package                           |
| --------------------------------------------------- | ----- | --------------------------------- |
| New optional member on a frame                      | minor | minor                             |
| New frame type                                      | minor | minor                             |
| New reserved error code                             | minor | minor                             |
| A member becomes required, changes type or meaning  | major | major                             |
| Frame type removed                                  | major | major                             |
| Transport framing changes (chunk header, delimiter) | major | major                             |
| SDK function signature changes, no wire change      | —     | major (after 1.0), minor (before) |
| New transport in the SDK                            | —     | minor                             |
