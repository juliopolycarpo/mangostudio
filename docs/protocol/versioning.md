# Versioning for consumers

`spec/versioning.md` defines the rules. This page says what they mean for an application that
depends on the SDK.

## Two numbers

- The **wire version** is what two peers negotiate in `hello`: `{ major, minor }`. Both SDKs
  export it as `PROTOCOL_VERSION`. Wire 1.2 is the current one; `spec/versioning.md` lists what
  each minor added.
- The **package version** is what you pin in `package.json` or `Cargo.toml`. Both packages
  share it and release together. Its changelog names the highest wire minor each release
  implements.

An application never spells the wire version itself; the session sends the version its SDK
build implements and negotiates the lower minor with the peer.

## What happens on a mismatch

- Same major, different minors: the session runs at the lower minor. Members added in a later
  minor are optional, so the older peer ignores them and the newer peer must not require them.
  `session.remote.effectiveMinor` says which minor was negotiated.
- A behaviour a minor added is only yours to rely on at that minor. From 1.2, for instance, a
  handler's events arrive ahead of its answer (spec §6.2); below 1.2 a responder may write the
  answer first, so a caller that needs every event keeps listening briefly past the answer.
- Different majors: both peers close with `4426 PROTOCOL_MISMATCH`, `ready` rejects with an
  error of code `PROTOCOL_MISMATCH`, and the client should not redial with the same build.
  A peer that receives a `hello` its schema refuses (for instance a frame from a protocol that
  predates this one) answers `4426` too.

## Pinning

Pin the package with a caret requirement (`^0.2.0`, `mango-protocol = "0.2"`). Before `1.0.0`
a minor package release may still change the wire, and the changelog says so under a
"Breaking" heading; read it before upgrading one side of a deployment without the other.

A hub and a runtime built from different package versions interoperate as long as they share
the wire major. Deploy order does not matter within a major.

## Application contracts

The method catalog an application defines with `defineContract` has its own `version` string,
independent of both numbers above. Announce it in `hello.capabilities` so the peer can refuse a
catalog it does not understand with `DENIED` or degrade gracefully. The protocol does not
interpret it.
