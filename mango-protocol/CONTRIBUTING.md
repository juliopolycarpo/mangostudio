# Contributing

Thanks for helping. `AGENTS.md` is the working guide; this file adds the human-facing bits.

- Open an issue before a wire change. Additive changes stay on the current wire major;
  anything else is a new major and a new `spec/schema/<major>/` directory.
- Every change that touches the wire lands spec, schema, TypeScript, Rust, fixtures and docs
  together, in one pull request.
- Run `bun run check && bun run test` before opening a pull request.
- Commits follow Conventional Commits with a body and one concern per commit. The changelog is
  generated; do not edit it.
- Documentation is English only.
