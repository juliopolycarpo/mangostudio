import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { readPairingToken, readRuntimeSlotState, readServeToken } from '../../src/runtime-home';

/**
 * Reads a runtime home the `mangostudio-runtime` Rust crate wrote — the
 * other direction of the compatibility claim
 * `crates/mangostudio-runtime/tests/ts_compat.rs` proves for
 * TypeScript-written homes.
 *
 * Regenerate the fixture with:
 * `cargo test -p mangostudio-runtime --test generate_rust_fixture -- --ignored`
 * (see that file for why it is `#[ignore]`d rather than run on every gate).
 */
const FIXTURE_HOME = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'crates',
  'mangostudio-runtime',
  'tests',
  'fixtures',
  'rust-home'
);
const env = { MANGO_HOME: FIXTURE_HOME };

describe('a runtime home written by the Rust crate', () => {
  it('reads the host slot with no error', async () => {
    const state = await readRuntimeSlotState('host', env);
    expect(state.error).toBeNull();
    expect(state.stored?.source).toBe('provisioned');
    expect(state.stored?.version).toBe('0.2.0-rust-fixture');
    expect(state.stored?.digest).toBe(`sha256:${'b'.repeat(64)}`);
    expect(state.stored?.allow?.shell).toBe(true);
    expect(state.stored?.setup?.by).toBe('install');
    expect(state.stored?.audit?.enabled).toBe(false);
    expect(await readServeToken('host', env)).toBe('mrt_rust_fixture_host_serve_token');
  });

  it('reads the wsl slot with no error', async () => {
    const state = await readRuntimeSlotState('wsl', env);
    expect(state.error).toBeNull();
    expect(state.stored?.allow?.shell).toBe(false);
    expect(state.stored?.allow?.fsRead).toBe(true);
    expect(await readPairingToken('wsl', env)).toBe('mrt_rust_fixture_wsl_pairing_token');
  });

  it('reads the remote slot and both rotated credentials with no error', async () => {
    const state = await readRuntimeSlotState('remote', env);
    expect(state.error).toBeNull();
    expect(state.stored?.hubUrl).toBe('wss://hub.rust-fixture.test/api/runtime');
    expect(await readPairingToken('remote', env)).toBe('mrt_rust_fixture_remote_pairing_token');
    expect(await readServeToken('remote', env)).toBe('mrt_rust_fixture_remote_serve_token');
  });
});
