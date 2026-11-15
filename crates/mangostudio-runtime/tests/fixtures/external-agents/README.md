# Historical catalog fixture

`discover-result-before-state.json` is the unmodified `external-agent.discover` result schema from
[the historical Hub catalog](https://github.com/juliopolycarpo/mangostudio/blob/fab4323b71809753961104d0bc0ad819928318b8/apps/shared/src/runtime-contract/generated/catalog.json),
at immutable [commit `fab4323b`](https://github.com/juliopolycarpo/mangostudio/commit/fab4323b71809753961104d0bc0ad819928318b8),
which recorded the `v0.1.1-canary.fab4323` build. The canary release tag was pruned;
the committed catalog above is the fixture source and version boundary.
The result object is closed; its runtime descriptor projection accepts additional properties. The
compatibility test validates replies from the current registered handler against this historical
schema, rather than assuming that every nested object inherits the outer object's closedness.
