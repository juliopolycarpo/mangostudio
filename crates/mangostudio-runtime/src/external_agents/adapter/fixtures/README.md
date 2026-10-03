# ACP outbound prompt budget

The private adapter supplies a 55 MiB outbound allowance per ACP session. The SDK keeps incoming
messages and turn events at 8 MiB, lines at 1 MiB, four attachments per turn and 2 MiB per file.
Mango Protocol still caps a Hub-to-runtime frame at 16 MiB. Deadlines and cleanup policy are unchanged.

Text attachments become UTF-8 resource strings. A NUL byte occupies six JSON bytes, so four maximum
Text files need 48 MiB on the ACP wire. Images and binary resources use base64 and are smaller.

`prompt-limits.json` binds the Rust adapter tests to the shared schemas through
`scripts/external-agent-prompt-budget.test.ts`. The generation HTTP contract permits 200,000 UTF-16
units of input. The shared runtime turn contract permits 1,048,576 units. The larger contract drives
the allowance even though its most escaped input together with four maximum files exceeds the
Mango Protocol frame cap. The tests exercise an exactly 16 MiB wire-admitted turn separately.

The conservative direct adapter bound is:

| Part                                                 | Maximum encoded bytes |
| ---------------------------------------------------- | --------------------: |
| Four 2 MiB NUL Text attachments                      |            50,331,648 |
| 1 MiB NUL prompt                                     |             6,291,456 |
| Four attachment IDs, names and MIME values           |                24,552 |
| Successful product native session ID                 |                 1,536 |
| ACP envelope, resource URI literals and request UUID |         at most 1,024 |
| Total                                                |    at most 56,650,216 |
| 55 MiB allowance                                     |            57,671,680 |
| Remaining space                                      |    at least 1,021,464 |

Each metadata unit above allows six encoded bytes. The successful Hub open path validates the raw
runtime result against `ExternalAgentOpenResultSchema` in
`apps/api/src/services/runtime-client/hub-session.ts`, so native session IDs are at most 256 UTF-16
units. A raw SDK open can accept a larger ID. A separate control tests an ID near the incoming 1 MiB
line cap with the HTTP prompt shape, and an oversized reply still fails that line cap. It does not
claim that the larger raw ID is a successful product open.

The headroom covers small cancellation and approval controls. A test holds the maximum encoded
prompt's physical write, requests cancellation, then verifies the real cancellation frame and
settlement. This does not promise room for every arbitrary vendor callback ID or unlimited controls.
The SDK's count and byte ceilings still refuse queue overflow. Four admitted sessions can each hold
the allowance. An encoded-byte ceiling is not a hard heap-memory cap.

## Linux memory receipts

The ignored `prompt_budget_memory_*` tests are non-gating probes. Run each in a fresh process for
one or four sessions, with maximum Image or escaped Text attachments. They report Linux `VmHWM`
in KiB, actual physical frame byte counts, accepted and refused outcomes, and live child counts.

```sh
cargo test -p mangostudio-runtime --lib --locked \
  external_agents::adapter::backend::prompt_budget_tests::prompt_budget_memory_four_texts \
  -- --ignored --exact --nocapture
```

Image probes use the HTTP prompt limit. Text probes use the larger shared runtime input limit as
direct adapter stress; that most escaped turn exceeds the Hub-to-runtime wire cap. The named
non-retaining launcher uses the SDK fake process control and small
handshake replies, but replaces the recording stdin. It parses only a request header and retains
scalar frame sizes. Large frames remain owned by the SDK while four physical writes are held.
The test asserts that the SDK fake's written-frame log is empty. Scalar observations and small
request headers remain in the fixture; zero retained large frame bodies does not mean zero fixture
allocation. Both acceptance and baseline refusal must permit a small next send on the same session,
and every fake child must be closed. These synthetic Linux receipts
include SDK serialization and fake-process overhead; they do not measure a live vendor child or
native Windows or macOS memory. A missing `VmHWM` is an error, never a zero measurement.

Compare exact Base and Head source and binary identities with repeated raw samples. A baseline
that refuses the input is a different outcome, not a speedup. The measured table will accompany
the qualified change after the selected registry release is available.
