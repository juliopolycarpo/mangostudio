# TypeScript Runtime Retirement

The TypeScript runtime package (`apps/runtime`, `@mangostudio/runtime`) has been retired in favour
of the compiled Rust runtime (`crates/mangostudio-runtime`) and is deleted. This page records what
the hub's test suite used to prove *through* the TypeScript runtime, where each responsibility
lives now, the last result of the differential suites that compared the two runtimes before their
TypeScript halves were removed, and the fixtures that still stand for what the TypeScript runtime
wrote.

## The hub no longer imports or spawns the TypeScript runtime

The runtime package and the in-process seam that built a TypeScript host for Local
(`apps/api/src/services/runtime-client/connect-in-process-runtime.ts`) are deleted. Local spawns
the Rust binary. `tests/unit/services/runtime-client/runtime-module-allow-list.test.ts` asserts
that no file under `apps/api/src` or `apps/api/tests` imports either of them, and that no test
spawns the TypeScript runtime by a `runtime/src/` path literal. The three tests that used to spawn
it by its source path (`integration/services/spawn-runtime-child.integration.test.ts`,
`integration/services/connect-ssh-runtime.integration.test.ts` and
`unit/lib/runtime-paths.test.ts`) were migrated in the Local cut-over (#1161).

Tests replace the TypeScript host in one of two ways:

- **(a) Fake host.** Use this when a test only needs protocol behaviour or the hub's own
  behaviour. `tests/support/fake-runtime-host.ts` serves a test's handlers through
  `RUNTIME_CONTRACT.serve` over `@mangostudio/protocol/in-process`, with `validateFrames: true`.
  Every frame is re-encoded and schema-checked. Parameters and results are validated against the
  contract. The host applies a consent gate that returns the same `DENIED` details a real
  runtime sends, and a thrown `RuntimeServiceError` keeps its `kind` on the wire.
  `tests/unit/support/fake-runtime-host.test.ts` pins each of these properties.
  `connectTestRuntime` (`tests/support/runtime-fixture.ts`) is built on the fake host, and
  `FakeHostileRuntimePeer` is still the peer that puts malformed frames on the wire.
- **(b) Rust binary.** Use this when a test asserts real runtime behaviour. The test drives
  `target/debug/mangostudio-runtime` (or `MANGOSTUDIO_RUNTIME_BINARY`) over stdio or `serve`, and
  is guarded with `it.skipIf(skipWithoutRustBinary(binary, suite))`
  (`tests/support/rust-runtime-binary.ts`), which prints the skipped suite and how to build the
  binary when it is missing. The ordinary lane has no binary; `cargo-shim.yml`'s
  `real-binary-qualification` job runs these cases on Linux, macOS and Windows.

| File                                                                                                          | Strategy                                                                | Why                                                                                                           |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `support/runtime-fixture.ts`, `support/mocks/fake-hostile-runtime-peer.ts`                                    | (a)                                                                     | Handler fakes; the hostile peer only drops its dependency on the runtime fixture's doc                        |
| `unit/services/runtime-client/hub-identity.test.ts`                                                           | (a)                                                                     | Only what the hub announced in its `hello` is asserted                                                        |
| `integration/routes/runtime-socket.integration.test.ts`                                                       | (a) over the WebSocket port                                             | Pairing and socket admission; `serveFakeRuntime` replaces `createRuntimeSession`                              |
| `integration/routes/environment-entities.integration.test.ts`                                                 | (a) routes, staging, locks, supervised restart; (b) `serve` live update | Rust cases: bytes published into the slot and the runtime's own digest refusal                                |
| `integration/routes/terminal-socket.integration.test.ts`                                                      | (b) stdio                                                               | Needs a real PTY and shell                                                                                    |
| `integration/modules/generation/capability-inspector.integration.test.ts`                                     | (a)                                                                     | Reads only `manifest.features`; no method is called                                                           |
| `integration/services/hub-isolation-claim.integration.test.ts`                                                | (b) `serve`, plus (a) twins for the hub-side withholding                | What a dialled runtime attests under the hub's claim                                                          |
| `integration/services/connect-http-runtime.integration.test.ts`                                               | (b) `serve`, plus (a) behind a loopback WebSocket                       | The fake covers the external-agent round-trip and the hub's pre-open refusal wording                          |
| `unit/modules/library/library-apply-transport.test.ts`                                                        | (a)                                                                     | The real-engine 404 case moved to `integration/modules/library/library-undo-missing-backup` (b)               |
| `unit/modules/environments/ssh-failure.test.ts`                                                               | none                                                                    | Builds the Rust setup-pending sentence from the shared signature                                              |
| `support/fixtures/mcp/turn-mcp-fixture.ts` (was `in-memory-mcp.ts`) and its MCP consumers                     | Production Local via a stdio relay                                      | The SDK servers stay in the test process and the runtime spawns `mcp-stdio-relay.ts`, so either runtime works |
| `integration/services/mcp/{http-transport,wrapper-contract}.integration.test.ts`                              | Production Local                                                        | SSE fallback and the wrapper contract are observed on the wire, not imported                                  |
| File-tool tests, `tool-registry-harness.ts`, file-checkpoint suites                                           | Production Local                                                        | `clearFileFreshness` is gone; each case's mkdtemp directory keeps freshness keys apart                        |
| `unit/services/runtime-client/unenforced-containment.test.ts`, `unit/services/tools/containment-wire.test.ts` | (a)                                                                     | The hub's reaction to a manifest and what it put on the wire                                                  |
| `unit/services/tools/support/target-home.ts` (the `~` cases)                                                  | (b) stdio with scratch `HOME`/`USERPROFILE`, plus (a) wire twins        | The file under the announced home is really read or written                                                   |
| `integration/services/rust-*-compat`, `rust-runtime-external-agents-qualification`                            | (b), Rust-only                                                          | See below                                                                                                     |

### Cases that run only against the binary

These run in `real-binary-qualification` and skip, loudly, everywhere else. Where the assertion
is the hub's own logic, a fake-host twin in the same file keeps the ordinary lane covering it.

| File                                                                          | Binary-only case                                                                                         | Fake-host twin in the ordinary lane                                                    |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `integration/routes/terminal-socket.integration.test.ts`                      | relays a real PTY through the terminal socket                                                            | none (runtime behaviour); the other terminal cases already use a fake                  |
| `integration/routes/environment-entities.integration.test.ts`                 | updates a connected runtime over its protocol connection; keeps the old binary when an update is refused | the mid-transfer update case pins the platform id the asset loader receives            |
| `integration/services/hub-isolation-claim.integration.test.ts`                | no claim, single-user claim, withdrawn claim (3)                                                         | the same three manifest outcomes, including withholding after `withdrawn`              |
| `integration/services/connect-http-runtime.integration.test.ts`               | round-trip, token rotation, 4401 refusal (3)                                                             | 4401 refusal after the upgrade; 401 refusal before it; external-agent round-trip       |
| `integration/services/environment-install-execution.integration.test.ts`      | streams a direct command over a fresh stdio connection, every line ahead of the answer                   | the same success case through the production Local runtime (the Rust binary)           |
| `integration/modules/library/library-undo-missing-backup.integration.test.ts` | the runtime reports a missing backup set as a 404                                                        | `unit/modules/library/library-apply-transport.test.ts` keys the 404 on the wire `kind` |
| `unit/services/tools/{read-file,write-file,list-directory,glob}-tool.test.ts` | `~` reads, writes, lists or matches under the home the binary reports (4)                                | `~` expanded against the announced `homeDir`, asserted on the wire (4)                 |

## Differential suites

Before the TypeScript halves were removed, the full differential suite was run once on
`e1dc7f7316966f3a4a02962a05256cd9900fcff1` on 2026-09-25 (Linux x64, Bun 1.4.2, debug Rust
binary):

```
MANGOSTUDIO_RUNTIME_BINARY=target/debug/mangostudio-runtime bun test --timeout 30000 \
  tests/integration/services/{rust-command-compat,rust-filesystem-search-compat,rust-snapshot-compat,rust-runtime-external-agents-qualification}.integration.test.ts
34 pass, 3 skip, 0 fail (37 tests, 4 files)
```

The three skips are Cursor-turn cases that need a vendor CLI; they were not differential. Every
comparison now checks the Rust answer against the TypeScript answer recorded from that run. Paths
are normalised to `<ROOT>` and `<HOME>`, and `durationMs` is dropped as before. Test names are
unchanged.
Two values are Windows-only: a BOM written as `?text`, and a timed-out PowerShell ending with exit
code 1 and no signal. They are the Rust runtime's received output on the Windows leg of this
change's first qualification run (commit 8928178b), which failed on them. They stand for the
TypeScript answer because the baseline's Windows leg on e1dc7f73 was green asserting Rust equal
to TypeScript for the same calls, and `crates/` had not changed between the two.

| Suite                                        | `it` (count)                                                                                                                        | Compared                                   | Last result | Now                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------- | ---------------------------------------------------------------------------------- |
| `rust-command-compat`                        | shell output, exit and byte cap (4); timed-out result; completed capture after timeout; descendant holds pipes (3); env deny policy | `shell.run`                                | pass        | Recorded literals                                                                  |
| `rust-command-compat`                        | direct Git argv and accepted nonzero exits                                                                                          | `git.exec`                                 | pass        | Recorded literal; on Windows, git's own direct output                              |
| `rust-command-compat`                        | gh reads and mutation-method help                                                                                                   | `gh.exec`, `gh.mutate`                     | pass        | Equal to what the installed `gh` prints directly (version-dependent)               |
| `rust-command-compat`                        | unsupported gh operations at the typed boundary                                                                                     | error type on both                         | pass        | Rust-only `ToolArgumentError`                                                      |
| `rust-filesystem-search-compat`              | glob braces, recursive paths, dots, caps                                                                                            | 114 `fs.glob` answers                      | pass        | `support/fixtures/rust-filesystem-search-recorded.ts`; order compared as a set     |
| `rust-filesystem-search-compat`              | dot rules and grep filters; ECMAScript regex semantics                                                                              | 6 + 18 `fs.grep` answers                   | pass        | Same fixture; line order kept within each file                                     |
| `rust-filesystem-search-compat`              | typed pattern and inaccessible-root errors                                                                                          | error type on both                         | pass        | Rust-only                                                                          |
| `rust-snapshot-compat`                       | exact bytes through an in-root link; byte-limit error; symlink/junction escapes                                                     | capture, hash, `RemoteError` equality      | pass        | Recorded literals, plus a new file-size-unchanged check                            |
| `rust-snapshot-compat`                       | 9 revert cases (create/restore/move, cross-device, collisions, base64, replay)                                                      | same literal checks on both                | pass        | Rust half only; checks unchanged                                                   |
| `rust-runtime-external-agents-qualification` | attests the credential home Local attests                                                                                           | Rust fingerprint vs TS Local's attestation | pass        | Local's derivation is recorded in the test; the hub's collision check is unchanged |

Loosened or dropped:

- Glob and grep result order is not compared, because it follows the filesystem's listing
  order. A capped glob must return `maxResults` distinct members of the uncapped answer.
- `gh` output is compared with the installed CLI rather than with a TypeScript answer.
- The `method === 'single-user-host'` check on the recorded Local attestation was dropped, since
  a recorded value can only pass it.

Other assertions that changed outside the differential suites:

- An exact platform id, version or slot path became "whatever the Rust binary reports". This
  affects `environment-entities`, `hub-isolation-claim` and `connect-http-runtime`.
- A rejected token on Rust `serve` closes with 4401 after the upgrade, where the TypeScript
  listener refused with 401 before it. The 401 wording case moved to the fake listener, and a new
  Rust case asserts the 4401 close on every OS.
- The direct `assertFresh` probes became behavioural. A file recreated at a moved-from path is
  refused as not read, and a moved-to path can be written without a re-read.
- MCP row timeouts for the forced-timeout cases went from 75 and 150 ms to 1 s. The Rust runtime
  counts spawn and initialize against the row timeout.

## Frozen compatibility fixtures

Two fixture sets record what the TypeScript runtime wrote and answered. Rust keeps replaying them
so it goes on reading the runtime homes and library backup sets that runtime left on operators'
machines. Their generators were deleted with it, so they are frozen rather than regenerated:

- `crates/mangostudio-runtime/tests/fixtures/ts-home`, a runtime home as the TypeScript runtime
  wrote it, read by `crates/mangostudio-runtime/tests/ts_compat.rs`.
- `crates/mangostudio-runtime/tests/fixtures/ts-library/corpus.json`, the TypeScript library
  readers' answers for a fixed corpus, read by `src/library/ts_compat_tests.rs` and
  `src/library/mutation/ts_backup_compat_tests.rs`.

`cargo-shim.yml`'s `runtime-home-fixture-freshness` job pins each directory's git tree
(`ts-home` at `814a421cef442f2dd6c24b13a70fcea00e45576b`, `ts-library` at
`5ecbf15d46a87ac2c2e8c24dc9d14a47a76b209e`) and fails when either changes, so an edit has to
update the pin on purpose. The same job still regenerates `rust-home` with
`cargo test -p mangostudio-runtime --test generate_rust_fixture -- --ignored` and fails on any
diff. The hub reads that fixture through `probeRuntimeSlots` in
`apps/api/tests/unit/cli/runtime-slot-probe-rust-home.test.ts`.

Two other things left with the TypeScript runtime:

- The recorded vendor contract captures and the tooling that recorded and drift-checked them now
  live in the external-agents SDK repository
  ([juliopolycarpo/mango-external-agents](https://github.com/juliopolycarpo/mango-external-agents)),
  whose CI runs the vendor contract drift workflow.
- The `runtime-slot-windows` job in `test.yml` is gone. Its Windows slot coverage is the Rust
  `#[cfg(windows)]` tests in `crates/mangostudio-runtime/src/slot_publish.rs` and
  `src/cli/native_operation.rs`, which `cargo-shim.yml`'s `workspace` matrix runs on
  `windows-latest`.

## Appendix: deleted test files and their replacements

One row per test file deleted with the TypeScript runtime and the shared code only it used. Each
row cites one or two representative tests that now carry that file's responsibilities: paths
under `src/` and `tests/` are in `crates/mangostudio-runtime`, and `SDK` names a test in the
External Agents SDK crates this repository depends on. The per-responsibility audit behind this
table (which assertion went where, and which were moot because the Rust design has no analogue)
was done before the deletion; this table is its file-level summary.

| Deleted test file                                             | Representative replacement tests                                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/tests/unit/modules/library/resource-writer.test.ts` | `crates/mangostudio-runtime/src/library/mutation/apply_tests.rs::backs_up_prior_content_before_replacing_a_directory`; `crates/mangostudio-runtime/src/library/mutation/apply_tests.rs::restores_the_original_directory_when_the_staged_swap_fails`                |
| `audit-log.test.ts`                                           | `src/audit/redact.rs::masks_a_long_flag_style_password`; `src/audit/redact.rs::masks_a_bearer_token`                                                                                                                                                               |
| `cli.test.ts`                                                 | `src/cli.rs::stdio_is_accepted_under_both_spellings`; `src/cli.rs::version_and_help_still_exit_zero`; the 1.0.1-hello refusal moved to hub `apps/api/tests/integration/services/spawn-runtime-child.integration.test.ts`                                           |
| `config.test.ts`                                              | `src/result_check.rs::a_missing_required_property_names_the_property_in_the_path`; `tests/audit_isolation.rs::a_schema_invalid_result_is_never_recorded_as_ok`                                                                                                     |
| `connect.test.ts`                                             | `tests/transport_connect.rs::a_transient_refusal_is_retried_until_the_hub_accepts`; `src/transport/mod.rs::hello_announces_the_embedded_runtime_contract_version`                                                                                                  |
| `consent-gate.test.ts`                                        | `tests/consent.rs::denying_authorization_refuses_a_capability_bearing_method_and_records_it`; `tests/consent.rs::partially_granting_authorization_names_only_the_ungranted_capability`                                                                             |
| `consent-source.test.ts`                                      | `src/consent/source.rs::an_absent_file_takes_the_slots_default`; `src/consent/source.rs::a_change_is_picked_up_without_reconnecting`                                                                                                                               |
| `dispatch.test.ts`                                            | `tests/consent.rs::denying_authorization_refuses_a_capability_bearing_method_and_records_it`; `tests/audit_isolation.rs::a_successful_call_records_outcome_ok`                                                                                                     |
| `manifest.test.ts`                                            | `src/manifest.rs::a_capability_with_every_backing_method_implemented_and_allowed_turns_on`; `src/health.rs::a_preconsented_host_with_terminal_handlers_announces_pty_support`                                                                                      |
| `runtime-credentials-validation.test.ts`                      | `src/runtime_home.rs::stored_string_reads_only_a_top_level_string`; `src/runtime_home.rs::reading_a_schema_invalid_config_reports_a_typed_error`                                                                                                                   |
| `runtime-home-rust-compat.test.ts`                            | hub `apps/api/tests/unit/cli/runtime-slot-probe-rust-home.test.ts` (reads `rust-home` through `probeRuntimeSlots`); the TS credential and audit-log readers it also exercised are deleted                                                                          |
| `runtime-home.test.ts`                                        | `src/runtime_home.rs::anchors_each_slot_under_runtime_beneath_the_home`; `src/runtime_home.rs::reading_an_absent_config_reports_no_error_and_nothing_stored`                                                                                                       |
| `runtime-update-protocol.test.ts`                             | `src/ports/exclusivity.rs::an_effect_keeps_its_claim_after_the_request_is_released`; `tests/update_exclusivity.rs::an_ordinary_call_refuses_while_an_update_call_is_genuinely_in_flight`                                                                           |
| `serve.test.ts`                                               | `src/cli.rs::a_bare_port_binds_loopback`; `src/cli.rs::a_host_port_pair_resolves_the_host`                                                                                                                                                                         |
| `services/cancellation.test.ts`                               | `src/filesystem/service.rs::run_locked_reports_cancellation_before_work_runs`; `src/filesystem/service.rs::cancellation_and_policy_refuse_before_creation`                                                                                                         |
| `services/claude-adapter-lifecycle.test.ts`                   | `src/external_agents/map_tests.rs::claude_missing_surface_names_the_version_to_upgrade_to`; `src/external_agents/map_tests.rs::claude_refuses_a_mode_the_build_does_not_list`                                                                                      |
| `services/claude-adapter.test.ts`                             | `src/external_agents/map_tests.rs::claude_signed_in_subscription_descriptor`; `src/external_agents/map_tests.rs::claude_refuses_auto_with_the_reason_the_account_gives`                                                                                            |
| `services/claude-cli-vocabulary.test.ts`                      | SDK `mango-agent-claude::reads_the_aliases_the_vendor_advertises`; SDK `mango-agent-claude::does_not_mistake_the_apostrophe_in_models_for_a_quoted_alias`                                                                                                          |
| `services/claude-reducer.test.ts`                             | SDK `mango-agent-claude::reports_the_vendors_session_handle_through_init_rather_than_a_turn_event`; SDK `mango-agent-claude::folds_the_vendors_session_handle_into_run_init_rather_than_a_turn_event`                                                              |
| `services/codex-adapter.test.ts`                              | `src/external_agents/map_tests.rs::codex_signed_in_descriptor`; `src/external_agents/map_tests.rs::codex_account_labels_never_carry_an_identity`                                                                                                                   |
| `services/codex-protocol.test.ts`                             | SDK `mango-agent-codex::structured_sandbox_policies_bound_writes_and_network`; SDK `mango-agent-codex::omitted_permission_axes_are_not_filled_in`                                                                                                                  |
| `services/codex-rate-limits.test.ts`                          | `src/external_agents/map_tests.rs::account_limits_carry_windows_plan_and_the_observation_time`; SDK `mango-agent-codex::both_windows_travel_with_their_labels_and_their_reset_times`                                                                               |
| `services/codex-reducer.test.ts`                              | `src/external_agents/map_events_tests.rs::thread_usage_maps_one_to_one`; SDK `mango-agent-codex::a_recorded_turn_replays_as_a_turn_that_ends_exactly_once`                                                                                                         |
| `services/cursor-adapter.test.ts`                             | `src/external_agents/map_tests.rs::cursor_current_descriptor_refuses_auto_review_and_full_access`; `src/external_agents/map_tests.rs::cursor_too_old_names_the_version_and_keeps_its_login_command`                                                                |
| `services/cursor-approvals.test.ts`                           | SDK `mango-agent-acp::unsupported_session_messages_are_consumed_without_sdk_retry_storage`; SDK `mango-external-agents::a_request_with_no_options_or_too_many_is_refused_on_its_own`                                                                               |
| `services/cursor-reducer.test.ts`                             | `src/external_agents/map_events_tests.rs::an_uncut_detail_is_not_marked_truncated`; `src/external_agents/map_events_tests.rs::output_renders_as_its_text_and_is_cut_at_the_detail_cap`                                                                             |
| `services/external-agent-isolation.test.ts`                   | `src/external_agents/isolation.rs::single_user_host_fingerprints_the_home_without_exposing_it`; `src/external_agents/isolation.rs::single_user_host_degrades_when_the_home_is_unreadable`                                                                          |
| `services/external-agent-jsonrpc.test.ts`                     | SDK `mango-external-agents::an_id_the_peer_numbered_is_echoed_as_a_number`; SDK `mango-external-agents::a_call_whose_write_never_lands_fails_without_orphaning_itself`                                                                                             |
| `services/external-agent-normalization.test.ts`               | `src/external_agents/map_events_tests.rs::reasoning_events_map_one_to_one`; SDK `mango-external-agents::drops_command_names_containing_whitespace`                                                                                                                 |
| `services/external-agent-process.test.ts`                     | `src/external_agents/launcher_tests.rs::the_child_sees_exactly_the_given_argv_cwd_and_env`; `src/external_agents/launcher_tests.rs::the_stderr_tail_is_bounded_and_redacted`                                                                                       |
| `services/external-agent-runtime.test.ts`                     | `src/external_agents/supervisor/tests.rs::the_hub_session_ending_shuts_every_session_down`                                                                                                                                                                         |
| `services/external-agent-supervisor.test.ts`                  | `src/external_agents/map_tests.rs::the_registry_exposes_exactly_the_three_product_targets`; `src/result_check.rs::a_missing_required_property_names_the_property_in_the_path`                                                                                      |
| `services/file-freshness.test.ts`                             | `src/filesystem/freshness.rs::digest_methods_record_the_same_entries_as_the_byte_methods`; `src/filesystem/io.rs::sha256_hex_matches_known_digests`                                                                                                                |
| `services/fs-utils.test.ts`                                   | `src/filesystem/io.rs::descriptor_read_bounds_observed_bytes_and_checks_cancellation`; `src/filesystem/io.rs::cancellable_hash_checks_after_its_final_read`                                                                                                        |
| `services/fs.test.ts`                                         | `src/filesystem/service.rs::basic_file_cycle_returns_catalog_valid_results_and_snapshots`; `src/filesystem/search.rs::search_roots_must_be_authorized_before_the_walk_starts`                                                                                      |
| `services/fs/read-file-bytes.test.ts`                         | `src/filesystem/text.rs::line_counts_do_not_invent_a_line_after_the_final_newline`; `src/filesystem/text.rs::binary_sniff_stops_at_the_ts_boundary`                                                                                                                |
| `services/gh.test.ts`                                         | `src/commands/service/tests.rs::cli_launch_preserves_argv_cwd_and_bounded_environment`; `src/commands/environment.rs::fixed_cli_environments_preserve_configuration_but_not_tokens`                                                                                |
| `services/git.test.ts`                                        | `src/commands/service/tests.rs::cli_launch_preserves_argv_cwd_and_bounded_environment`; `src/commands/environment.rs::fixed_cli_environments_preserve_configuration_but_not_tokens`                                                                                |
| `services/grep-budget.test.ts`                                | `src/filesystem/search.rs::regexp_interrupts_a_single_catastrophic_match`; `src/filesystem/search.rs::unfinished_file_discards_its_partial_matches_but_keeps_earlier_files`                                                                                        |
| `services/grep-scanner-pool.test.ts`                          | none: it tested the Bun Worker pool behind grep, which the Rust runtime does not have (it compiles one regex per call)                                                                                                                                             |
| `services/hidden-window.test.ts`                              | `src/external_agents/launcher_tests.rs::the_child_sees_exactly_the_given_argv_cwd_and_env`                                                                                                                                                                         |
| `services/install.test.ts`                                    | `src/install/environment.rs::passes_only_allowlisted_keys_plus_constant_recipe_overrides`; `src/install/environment.rs::accepts_codex_non_interactive_and_fnm_dir_recipe_overrides`                                                                                |
| `services/library/library-service.test.ts`                    | `src/library/service_tests.rs::read_containment_follows_the_location_not_the_request`; `src/library/ts_compat_tests.rs::bounded_reads_match_read_library_content`                                                                                                  |
| `services/mcp/elicitation-schema.test.ts`                     | `src/mcp/elicitation_schema.rs::flattens_string_enum_multi_enum_number_and_boolean_fields`; `src/mcp/elicitation_schema.rs::returns_an_empty_list_for_non_object_schemas`                                                                                          |
| `services/mcp/service.test.ts`                                | `src/mcp/service.rs::a_request_for_a_server_it_never_connected_is_refused_as_missing`; `src/mcp/service.rs::an_elicitation_event_carries_the_hub_minted_tool_call_id_and_the_answer_returns`                                                                       |
| `services/mcp/stdio-env.test.ts`                              | `src/mcp/stdio.rs::secret_bearing_process_variables_never_reach_the_child`; `src/mcp/stdio.rs::row_env_then_secret_env_override_inherited_values`                                                                                                                  |
| `services/owner-only.test.ts`                                 | `src/runtime_home/owner_only/unix.rs::restricts_an_existing_file_to_owner_only`; `src/runtime_home/owner_only/unix.rs::reports_false_rather_than_erroring_for_a_missing_file`                                                                                      |
| `services/probing/agent-clis.test.ts`                         | `src/probing/detection/agent_cli_definitions.rs::parses_claude_version_with_and_without_the_claude_code_suffix`; `src/probing/detection/agent_cli_definitions.rs::parses_codex_version_dropping_a_prerelease_suffix`                                               |
| `services/probing/host-env.test.ts`                           | `src/probing/host.rs::with_canonical_path_key_folds_a_differently_cased_key`; `src/probing/host.rs::build_runtime_path_env_reports_this_hosts_real_platform`                                                                                                       |
| `services/probing/toolchains.test.ts`                         | `src/probing/methods.rs::probe_runtimes_finds_a_real_fake_bun_on_a_synthetic_path`; `src/probing/detection/binary_scan.rs::an_explicit_probe_timeout_overrides_the_platform_default`                                                                               |
| `services/process-tree.test.ts`                               | `src/subprocess.rs::a_backgrounded_descendant_that_never_touches_the_pipe_is_still_killed`; `src/subprocess/supervisor.rs::deadline_drain_forces_descendants_and_finalizes_the_guardian`                                                                           |
| `services/runtime-service.test.ts`                            | `src/cli/user_service.rs::systemd_unit_names_current_and_thirty_second_stop_cap`; `src/cli/user_service.rs::install_requires_answered_consent_and_publishes_a_current_unit`                                                                                        |
| `services/runtime-update.test.ts`                             | `src/update.rs::commits_verified_bytes_without_touching_pairing`; `src/slot_publish.rs::binary_is_immutable_and_pointer_can_roll_back`                                                                                                                             |
| `services/shell-exec.test.ts`                                 | `src/health.rs::detect_shells_finds_a_shell_present_on_a_synthetic_path`; `src/subprocess.rs::a_quick_child_returns_its_output_within_budget`                                                                                                                      |
| `services/slot-publish.test.ts`                               | `src/slot_publish.rs::refuses_external_or_directory_current_pointer`; `src/slot_publish.rs::rejects_corrupt_or_stale_shim_without_following_it`                                                                                                                    |
| `services/slot-publish.windows.test.ts`                       | `src/slot_publish.rs::publishes_immutable_binary_and_activates_a_stable_shim`; `src/slot_publish.rs::activation_failure_restores_previous_shim_and_prune_keeps_previous_binary`                                                                                    |
| `services/slot-update-lock.test.ts`                           | `src/slot_update_lock.rs::heartbeat_renews_only_the_original_lock_inode`; `src/slot_update_lock.rs::dead_local_holder_is_reclaimed_and_old_token_cannot_release_replacement`                                                                                       |
| `services/snapshot.test.ts`                                   | `src/filesystem/snapshot.rs::capture_enforces_the_eight_mebibyte_limit_and_preflights_its_frame`; `src/filesystem/service.rs::oversized_snapshot_responses_refuse_every_mutation_before_commit`                                                                    |
| `services/spawn-env.test.ts`                                  | `src/probing/host.rs::with_canonical_path_key_folds_a_differently_cased_key`; `src/probing/host.rs::with_canonical_path_key_leaves_an_exact_path_key_untouched`                                                                                                    |
| `services/terminal/buffer.test.ts`                            | `src/terminal/flow.rs::ring_keeps_last_bytes_and_counts_each_displacement`                                                                                                                                                                                         |
| `services/terminal/pty.test.ts`                               | `src/terminal/pty.rs::unix_pty_resize_changes_the_childs_reported_size`; `src/terminal/pty.rs::unix_pty_has_controlling_tty_and_reports_native_exit`                                                                                                               |
| `services/terminal/service.pty.test.ts`                       | `src/terminal/pty.rs::conpty_runs_inside_an_owned_job_and_reports_output_and_exit`                                                                                                                                                                                 |
| `services/terminal/service.test.ts`                           | `src/terminal/service/tests.rs::fake_pty_covers_open_attach_write_resize_ack_detach_and_close`; `src/terminal/service/tests.rs::default_shell_prefers_login_shell_only_when_present`                                                                               |
| `services/terminal/session.test.ts`                           | `src/terminal/flow.rs::absent_viewer_gets_no_events_and_reconnect_gets_bounded_replay`; `src/terminal/service/tests.rs::fake_pty_covers_open_attach_write_resize_ack_detach_and_close`                                                                             |
| `services/turn-channel.test.ts`                               | `src/external_agents/turns.rs::concurrent_emitters_never_reorder_or_skip_a_sequence`; `src/external_agents/supervisor/tests.rs::a_turn_streams_ordered_events_and_an_approval_round_trips`                                                                         |
| `services/vendor-contracts.test.ts`                           | SDK `mango-agent-acp::an_agent_answering_another_protocol_version_is_refused`; SDK `mango-agent-claude::every_flag_every_turn_passes_is_present_on_both_captured_builds`                                                                                           |
| `services/workdir-validation.test.ts`                         | `src/workspace_methods.rs::validate_reports_ok_true_for_a_real_directory`; `src/workspace_methods.rs::validate_returns_the_canonical_directory_of_a_symlinked_path`                                                                                                |
| `services/workspace-browse.test.ts`                           | `src/workspace_methods.rs::browse_lists_directories_only_and_flags_hidden_names`; `src/workspace_methods.rs::compares_case_insensitively_then_falls_back_to_case_sensitive_order`                                                                                  |
| `services/workspace-resolve-contained.test.ts`                | `src/workspace_methods.rs::resolve_contained_reports_the_relative_path_for_a_path_inside_root`; `src/workspace.rs::a_nested_path_with_backslash_separators_resolves_to_its_relative_form`                                                                          |
| `session.test.ts`                                             | `tests/audit_isolation.rs::a_schema_invalid_result_is_never_recorded_as_ok`; `src/result_check.rs::a_missing_required_property_names_the_property_in_the_path`                                                                                                     |
| `setup.test.ts`                                               | `src/setup.rs::parse_allow_overrides_parses_multiple_comma_separated_pairs`; `src/setup.rs::parse_boolean_accepts_the_documented_synonyms_case_insensitively`                                                                                                      |
| `slot-install.test.ts`                                        | `src/cli/native_operation.rs::self_install_publishes_and_reinstall_is_unchanged`; `tests/cli.rs::doctor_reports_a_stale_slot_pointer_and_reinstall_recovers_without_reconfiguring`                                                                                 |
| `apps/shared/tests/unit/library/machine/apply-writes.test.ts` | `crates/mangostudio-runtime/src/library/mutation/apply_tests.rs::writes_through_the_injected_backup_root_and_supports_undo`; `crates/mangostudio-runtime/src/library/mutation/apply_tests.rs::refuses_a_write_whose_destination_is_not_the_one_the_preview_showed` |
| `apps/shared/tests/unit/library/machine/write-queue.test.ts`  | `crates/mangostudio-runtime/src/library/mutation/service_tests.rs::a_queued_write_rechecks_consent_under_the_owner`; `crates/mangostudio-runtime/src/library/mutation/service_tests.rs::cancel_versus_commit_retains_the_owner_until_the_boundary`                 |
| `scripts/tests/vendor-contracts.unit.test.ts`                 | none here: the captures and their checks moved to the external-agents SDK repository with the adapters                                                                                                                                                             |
| `scripts/tests/vendor-drift-issue.unit.test.ts`               | none here: the drift workflow and its issue renderer live in the external-agents SDK repository                                                                                                                                                                    |
