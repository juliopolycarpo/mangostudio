# Discovery probe fixture

`claude-help-2.1.270.txt` is an unmodified copy of the SDK's
[recorded Claude help](https://github.com/juliopolycarpo/mango-external-agents/blob/589394e3e95fdea1283c35e51893fa7910e90f90/fixtures/claude/help/2.1.270.txt).

The private adapter test inserts an overlong line before `--permission-prompts` and supplies a
smaller line-reader bound. This forces a controlled read cut-off while later required flags remain
in the complete fixture. It exercises the published Claude harness's inconclusive-probe verdict
before mapping it to the product descriptor. Update the capture by copying its recorded source;
never edit vendor output by hand.

`discover-result-before-state.json` is the unmodified `external-agent.discover` result schema from
[the historical Hub catalog](https://github.com/juliopolycarpo/mangostudio/blob/fab4323b71809753961104d0bc0ad819928318b8/apps/shared/src/runtime-contract/generated/catalog.json),
at immutable [commit `fab4323b`](https://github.com/juliopolycarpo/mangostudio/commit/fab4323b71809753961104d0bc0ad819928318b8),
which recorded the `v0.1.1-canary.fab4323` build. The canary release tag was pruned;
the committed catalog above is the fixture source and version boundary.
The result object is closed; its runtime descriptor projection accepts additional properties. The
compatibility test validates replies from the current registered handler against this historical
schema, rather than assuming that every nested object inherits the outer object's closedness.
