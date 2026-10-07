# Host Bun peer metadata

`bun-plugin-tailwind@0.1.2` declares `bun >=1.0.0` as a required peer. The plugin uses the host's global
`Bun` API, and the frontend build runs with the toolchain pinned by `.bun-version` and root
`packageManager`. Bun otherwise installs the registry `bun` package and its platform binaries to
satisfy that peer.

The root `overrides.bun` points to this private package. It contains metadata only, exports nothing,
and has no commands, scripts, or dependencies. Runtime imports of `bun` use the host's built-in module.
Other peers keep Bun's default automatic installation.

Keep this version aligned with the toolchain pins. Remove the override and this directory once the
published plugin makes its Bun peer optional.

The alternatives were qualified with Bun 1.4.2. `install.peer = false` skips peer installation but
retains registry Bun in the lockfile and also skips required library peers. A `bun patch` adding
`peerDependenciesMeta.bun.optional` changes installed metadata, while dependency resolution still
uses the registry's required peer declaration.

See [Bun peer installation](https://bun.com/docs/pm/cli/install#peer-dependencies) and
[peer overrides](https://bun.com/docs/pm/overrides).
