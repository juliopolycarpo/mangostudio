/**
 * Regression tests for #1060: `credentials.json` was spread over a default
 * without validating it against `RuntimeSlotCredentialsSchema`, so a wrong-shaped
 * token type read as if it were a string, and a file naming a newer
 * `schemaVersion` than this build understands could be silently downgraded by
 * the next write. See `apps/runtime/src/runtime-home.ts`'s
 * `readRuntimeSlotCredentialsState` and `requireReplaceableCredentials`.
 *
 * Fixture bytes live in `../fixtures/runtime-credentials.ts`, named so a
 * second implementation of this layer can drive the same cases.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPairingToken,
  readRuntimeSlotCredentialsState,
  readServeToken,
  runtimeSlotDir,
  writePairingToken,
  writeServeToken,
} from '../../src/runtime-home';
import {
  EMPTY_CREDENTIALS_JSON,
  FUTURE_SCHEMA_CREDENTIALS_JSON,
  INVALID_JSON_CREDENTIALS,
  MALFORMED_SIBLING_CREDENTIALS_JSON,
  NUMERIC_TOKEN_CREDENTIALS_JSON,
  OBJECT_TOKEN_CREDENTIALS_JSON,
  RUNTIME_CREDENTIALS_FIXTURES,
  VALID_CREDENTIALS_JSON,
} from '../fixtures/runtime-credentials';

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function isolatedEnv(): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), 'mango-runtime-credentials-'));
  homes.push(home);
  return { MANGO_HOME: home };
}

async function writeRawCredentials(
  slot: 'host' | 'wsl' | 'remote',
  contents: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const directory = runtimeSlotDir(slot, env);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'credentials.json'), contents);
}

async function readRawCredentials(
  slot: 'host' | 'wsl' | 'remote',
  env: NodeJS.ProcessEnv
): Promise<unknown> {
  return JSON.parse(
    await Bun.file(join(runtimeSlotDir(slot, env), 'credentials.json')).text()
  ) as unknown;
}

describe('runtime credentials validation', () => {
  it('never returns a numeric pairing token as if it were a string', async () => {
    const env = await isolatedEnv();
    await writeRawCredentials('remote', NUMERIC_TOKEN_CREDENTIALS_JSON, env);

    expect(await readPairingToken('remote', env)).toBeNull();
  });

  it('never returns an object serve token as if it were a string', async () => {
    const env = await isolatedEnv();
    await writeRawCredentials('remote', OBJECT_TOKEN_CREDENTIALS_JSON, env);

    expect(await readServeToken('remote', env)).toBeNull();
  });

  it('never carries a malformed sibling forward when rotating the other token', async () => {
    const env = await isolatedEnv();
    // On disk: a valid pairing token beside a serve token that fails the
    // schema. Rotating the pairing token must not re-persist the malformed
    // serve token as if it had validated.
    await writeRawCredentials('remote', MALFORMED_SIBLING_CREDENTIALS_JSON, env);

    await writePairingToken('remote', 'mrt_selector.rotated', env);

    expect(await readPairingToken('remote', env)).toBe('mrt_selector.rotated');
    expect(await readServeToken('remote', env)).toBeNull();
    const raw = await readRawCredentials('remote', env);
    expect(raw).not.toHaveProperty('serveToken', 12345);
  });

  it('refuses to replace a credentials file from a schema version it does not understand', async () => {
    const env = await isolatedEnv();
    await writeRawCredentials('remote', FUTURE_SCHEMA_CREDENTIALS_JSON, env);

    await expect(writeServeToken('remote', 'srv_selector.new', env)).rejects.toThrow(
      /schemaVersion 2/
    );

    // The file on disk must be untouched — not downgraded to schemaVersion 1.
    const raw = (await readRawCredentials('remote', env)) as { schemaVersion: unknown };
    expect(raw.schemaVersion).toBe(2);
  });

  it('never quotes a token value in the refusal for an unsupported schema version', async () => {
    const env = await isolatedEnv();
    await writeRawCredentials('remote', FUTURE_SCHEMA_CREDENTIALS_JSON, env);

    let message = '';
    try {
      await writePairingToken('remote', 'mrt_selector.new', env);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain('mrt_selector.future');
  });

  // Tolerant recovery must survive the fix: a corrupt or wrong-shaped file is
  // not a schema-version mismatch, so an ordinary rotation still repairs it
  // rather than requiring a person to intervene first.
  it('still lets an ordinary rotation repair a wrong-shaped file', async () => {
    const env = await isolatedEnv();
    await writeRawCredentials('remote', NUMERIC_TOKEN_CREDENTIALS_JSON, env);

    await writePairingToken('remote', 'mrt_selector.repaired', env);

    expect(await readPairingToken('remote', env)).toBe('mrt_selector.repaired');
  });

  it('still lets an ordinary rotation repair invalid JSON', async () => {
    const env = await isolatedEnv();
    await writeRawCredentials('remote', INVALID_JSON_CREDENTIALS, env);

    await writePairingToken('remote', 'mrt_selector.repaired', env);

    expect(await readPairingToken('remote', env)).toBe('mrt_selector.repaired');
  });

  it('reads an empty file as absent tokens, not an error', async () => {
    const env = await isolatedEnv();
    await writeRawCredentials('remote', EMPTY_CREDENTIALS_JSON, env);

    expect(await readPairingToken('remote', env)).toBeNull();
    expect(await readServeToken('remote', env)).toBeNull();
  });

  it('round-trips a fully valid file unchanged', async () => {
    const env = await isolatedEnv();
    await writeRawCredentials('remote', VALID_CREDENTIALS_JSON, env);

    expect(await readPairingToken('remote', env)).toBe('mrt_selector.valid');
    expect(await readServeToken('remote', env)).toBe('srv_selector.valid');
  });

  // A directory where the file belongs fails the read with EISDIR, the
  // portable stand-in `runtime-home.test.ts` uses for the EACCES/EPERM/EIO
  // family: a file is there and this process cannot see what it says. Unlike
  // a missing file, this must refuse a write rather than replace it — this
  // process cannot rule out that what it could not read was a newer schema
  // version, which is exactly the case a silent replace must never touch.
  it('refuses to replace a file it could not read, rather than guessing it is safe to', async () => {
    const env = await isolatedEnv();
    await mkdir(join(runtimeSlotDir('remote', env), 'credentials.json'), { recursive: true });

    const state = await readRuntimeSlotCredentialsState('remote', env);
    expect(state.error).toContain('could not be read');
    expect(state.mayReplaceOnWrite).toBe(false);

    await expect(writePairingToken('remote', 'mrt_selector.new', env)).rejects.toThrow(
      /could not be read/
    );
  });
});

/**
 * The decision table `RUNTIME_CREDENTIALS_FIXTURES` settled, exercised
 * mechanically: every case reads the tokens the table says it must, and every
 * case is either replaceable by an ordinary rotation or refuses one — never
 * silently something in between.
 */
describe.each(Object.entries(RUNTIME_CREDENTIALS_FIXTURES))(
  'credentials fixture: %s',
  (_caseName, fixture) => {
    it('reads pairing and serve tokens as the table says', async () => {
      const env = await isolatedEnv();
      if (fixture.raw !== null) await writeRawCredentials('remote', fixture.raw, env);

      expect(await readPairingToken('remote', env)).toBe(fixture.readsPairingToken);
      expect(await readServeToken('remote', env)).toBe(fixture.readsServeToken);
    });

    it('reports the diagnostic the table says, and never a token value', async () => {
      const env = await isolatedEnv();
      if (fixture.raw !== null) await writeRawCredentials('remote', fixture.raw, env);

      const state = await readRuntimeSlotCredentialsState('remote', env);
      if (fixture.errorSubstring === null) {
        expect(state.error).toBeNull();
      } else {
        expect(state.error).toContain(fixture.errorSubstring);
      }
      // Every fixture's raw bytes carry a `mrt_`/`srv_`-prefixed token or a
      // bare number; neither belongs in a diagnostic.
      if (fixture.raw !== null) expect(state.error ?? '').not.toContain(fixture.raw);
    });

    it(
      fixture.mayReplaceOnWrite
        ? 'lets an ordinary rotation replace it'
        : 'refuses an ordinary rotation',
      async () => {
        const env = await isolatedEnv();
        if (fixture.raw !== null) await writeRawCredentials('remote', fixture.raw, env);

        const attempt = writePairingToken('remote', 'mrt_selector.attempt', env);
        if (fixture.mayReplaceOnWrite) {
          await attempt;
          expect(await readPairingToken('remote', env)).toBe('mrt_selector.attempt');
        } else {
          await expect(attempt).rejects.toThrow();
        }
      }
    );
  }
);
