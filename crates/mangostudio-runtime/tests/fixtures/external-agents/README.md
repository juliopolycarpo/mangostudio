# Discovery probe fixture

`claude-help-2.1.270.txt` is an unmodified copy of the SDK's
[recorded Claude help](https://github.com/juliopolycarpo/mango-external-agents/blob/589394e3e95fdea1283c35e51893fa7910e90f90/fixtures/claude/help/2.1.270.txt).

The private adapter test inserts an overlong line before `--permission-prompts` and supplies a
smaller line-reader bound. This forces a controlled read cut-off while later required flags remain
in the complete fixture. It exercises the published Claude harness's inconclusive-probe verdict
before mapping it to the product descriptor. Update the capture by copying its recorded source;
never edit vendor output by hand.
