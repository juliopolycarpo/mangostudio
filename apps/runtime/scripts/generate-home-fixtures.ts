/**
 * Writes a real runtime home with the TypeScript implementation, for the
 * Rust `mangostudio-runtime` crate to prove compatibility against.
 *
 * `crates/mangostudio-runtime/tests/ts_compat.rs` reads what this script
 * writes. A Rust test that only round-trips its own format proves nothing
 * about reading a home a TypeScript runtime actually produced — this is the
 * other half of that proof. See `apps/runtime/tests/unit/runtime-home.test.ts`
 * for the shapes this mirrors.
 *
 * Regenerate with `bun run --filter @mangostudio/runtime fixtures:home`.
 * The output is committed, not built on the fly, so the Rust gate never
 * depends on Bun being present.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import {
  runtimeSlotDir,
  writePairingToken,
  writeRuntimeSlotConfig,
  writeServeToken,
} from '../src/runtime-home';

/** `runtimeSlotDir(slot, env)/runtime.json`, without pulling in the path helper's own private constant. */
function configPath(slot: 'host' | 'wsl' | 'remote', env: Record<string, string>): string {
  return join(runtimeSlotDir(slot, env), 'runtime.json');
}

const FIXTURE_HOME = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'crates',
  'mangostudio-runtime',
  'tests',
  'fixtures',
  'ts-home'
);
const env = { MANGO_HOME: FIXTURE_HOME };

async function main(): Promise<void> {
  await rm(FIXTURE_HOME, { recursive: true, force: true });

  // `host`: a locally installed, fully consented slot — the common case,
  // and the one whose absence-default (`full`) a corrupt-file test on the
  // Rust side has to fall back to correctly.
  await writeRuntimeSlotConfig(
    'host',
    {
      source: 'bundled',
      version: '0.9.0',
      binaryPath: '/opt/mangostudio/mangostudio-runtime',
      digest: `sha256:${'a'.repeat(64)}`,
      allow: RUNTIME_CONSENT_PRESETS.full,
      setup: { state: 'configured', at: '2026-01-01T00:00:00.000Z', by: 'launch' },
      installedBy: {
        hubVersion: '0.9.0',
        host: 'ts-fixture-host',
        transport: 'stdio',
        at: '2026-01-01T00:00:00.000Z',
      },
      audit: { enabled: false },
    },
    env
  );
  await writeServeToken('host', 'mrt_fixture_host_serve_token', env);

  // `wsl`: a narrowed slot, plus a field a hypothetical later TypeScript
  // release wrote that this Rust crate's contract does not know about yet —
  // the forward-compatibility case (`unrelated_fields_a_newer_runtime_wrote_are_ignored_not_fatal`
  // on the Rust side, mirrored here against a file TypeScript itself wrote).
  await writeRuntimeSlotConfig(
    'wsl',
    {
      source: 'provisioned',
      version: '0.9.1',
      allow: RUNTIME_CONSENT_PRESETS.readonly,
      setup: { state: 'configured', at: '2026-01-02T00:00:00.000Z', by: 'cli' },
    },
    env
  );
  // Not expressible through `writeRuntimeSlotConfig`'s typed `update` (it is
  // typed to the schema this contract already knows), so this is the one
  // raw file edit in the fixture — standing in for a field a release ahead
  // of this contract wrote.
  const wslConfigPath = configPath('wsl', env);
  const wslConfig = await Bun.file(wslConfigPath).json();
  wslConfig.somethingANewerRuntimeWrote = 'from a release this contract predates';
  await Bun.write(wslConfigPath, `${JSON.stringify(wslConfig, null, 2)}\n`);
  await writePairingToken('wsl', 'mrt_fixture_wsl_pairing_token', env);

  // `remote`: placed by somebody's hub, still pending consent — the slot
  // whose absence-default (`pending`/`none`) differs from `host` and `wsl`,
  // and the one credential rotation (both tokens, then one rotated) that
  // exercises the credentials merge on a TypeScript-written file.
  await writeRuntimeSlotConfig('remote', { hubUrl: 'wss://hub.fixture.test/api/runtime' }, env);
  await writePairingToken('remote', 'mrt_fixture_remote_pairing_token', env);
  await writeServeToken('remote', 'mrt_fixture_remote_serve_token', env);
  await writePairingToken('remote', 'mrt_fixture_remote_pairing_token_rotated', env);

  // The lock body shape (`{ pid, host }`), exactly as `withSlotLock` writes
  // it — not a per-slot file, so it lives at the fixture root. The Rust
  // lock protocol test suite parses this into its own `LockOwner` to prove
  // the two sides agree on field names, independent of any slot.
  await Bun.write(
    join(FIXTURE_HOME, 'lock-body.json'),
    JSON.stringify({ pid: 4242, host: 'ts-fixture-host' })
  );
}

await main();
