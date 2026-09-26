/**
 * Reads a runtime home the Rust runtime wrote, through the hub's own slot probe.
 *
 * `crates/mangostudio-runtime/tests/fixtures/rust-home` is committed output of
 * `cargo test -p mangostudio-runtime --test generate_rust_fixture -- --ignored`,
 * and `cargo-shim.yml`'s fixture freshness job fails when the Rust writer no
 * longer produces it byte for byte. The hub is the one TypeScript reader left
 * for `runtime.json` (doctor reports it), so this is where a Rust-side shape
 * change the hub cannot read turns red.
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { probeRuntimeSlots, type RuntimeSlotProbe } from '../../../src/cli/runtime-slot-probe';

const RUST_HOME = join(
  import.meta.dir,
  '../../../../../crates/mangostudio-runtime/tests/fixtures/rust-home'
);

async function probeBySlot(): Promise<Record<string, RuntimeSlotProbe>> {
  const probes = await probeRuntimeSlots(RUST_HOME);
  return Object.fromEntries(probes.map((probe) => [probe.slot, probe]));
}

describe('probeRuntimeSlots on a Rust-written runtime home', () => {
  it('finds every slot the Rust fixture writes, each without an error', async () => {
    const probes = await probeRuntimeSlots(RUST_HOME);

    expect(probes.map((probe) => ({ slot: probe.slot, error: probe.error }))).toEqual([
      { slot: 'host', error: null },
      { slot: 'wsl', error: null },
      { slot: 'remote', error: null },
    ]);
  });

  it('reads the host slot the Rust install provisioned', async () => {
    const { host } = await probeBySlot();

    expect(host?.config).toMatchObject({
      source: 'provisioned',
      version: '0.2.0-rust-fixture',
      digest: `sha256:${'b'.repeat(64)}`,
      setup: { state: 'configured', by: 'install' },
      audit: { enabled: false },
    });
    expect(host?.config.allow.shell).toBe(true);
  });

  it('reads the wsl slot consent the Rust setup narrowed', async () => {
    const { wsl } = await probeBySlot();

    expect(wsl?.config.setup).toMatchObject({ state: 'configured', by: 'cli' });
    expect(wsl?.config.allow).toMatchObject({ fsRead: true, fsWrite: false, shell: false });
  });

  it('reads the remote slot hub URL', async () => {
    const { remote } = await probeBySlot();

    expect(remote?.config.hubUrl).toBe('wss://hub.rust-fixture.test/api/runtime');
  });
});
