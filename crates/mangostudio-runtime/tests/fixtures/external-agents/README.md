# Discovery probe fixture

`claude-help-2.1.270.txt` is an unmodified copy of the SDK's
[recorded Claude help](https://github.com/juliopolycarpo/mango-external-agents/blob/589394e3e95fdea1283c35e51893fa7910e90f90/fixtures/claude/help/2.1.270.txt).

The private adapter test inserts an overlong line before `--permission-prompts` and supplies a
smaller line-reader bound. This forces a controlled read cut-off while later required flags remain
in the complete fixture. It exercises the published Claude harness's inconclusive-probe verdict
before mapping it to the product descriptor. Update the capture by copying its recorded source;
never edit vendor output by hand.

`discover-result-before-state.json` is the unmodified `external-agent.discover` result schema from
[the released Hub catalog](https://github.com/juliopolycarpo/mangostudio/blob/fab4323b71809753961104d0bc0ad819928318b8/apps/shared/src/runtime-contract/generated/catalog.json),
released as
[v0.1.1-canary.fab4323](https://github.com/juliopolycarpo/mangostudio/releases/tag/v0.1.1-canary.fab4323).
The result object is closed; its runtime descriptor projection accepts additional properties. The
compatibility test validates replies from the current registered handler against this historical
schema, rather than assuming that every nested object inherits the outer object's closedness.
