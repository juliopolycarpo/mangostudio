/**
 * The paired-bootstrap sequence, driven by a fake ssh runner.
 *
 * What matters here is the ordering and the boundaries, not the shell: the
 * credential is minted only after the machine has consented, it travels on
 * stdin and never in argv, a failed `service install` still leaves a usable
 * machine, and every non-zero step is described with 013's classifier rather
 * than as "the command failed".
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { RuntimePairedBootstrapBody } from '@mangostudio/shared/environments';
import { runPairedBootstrap } from '../../../../src/modules/environments/application/runtime-lifecycle-service';
import type { RuntimePairingService } from '../../../../src/modules/environments/application/runtime-pairing-service';
import type {
  RuntimeCommandOptions,
  RuntimeCommandResult,
} from '../../../../src/modules/environments/domain/runtime-push';
import type { RuntimeConnectionManager } from '../../../../src/services/runtime-client/runtime-connection-manager';

const HOST = 'vps.example.test';
const ENDPOINT = 'wss://hub.example.com/api/runtime';
const TOKEN = 'mrt_selector.secret-value';
const VERSION = '9.9.9-test';

const BODY: RuntimePairedBootstrapBody = {
  ssh: { host: HOST },
  consent: { profile: 'full' },
};

interface RunnerCall {
  readonly script: string;
  readonly options: RuntimeCommandOptions | undefined;
}

function ok(stdout = ''): RuntimeCommandResult {
  return { stdout, stderr: '', exitCode: 0 };
}

/**
 * Answers every step successfully unless an override says otherwise. The
 * version probe reports the hub's own version so the push short-circuits on
 * 018's digest-gated no-op instead of downloading a release asset.
 */
function fakeRunner(
  calls: RunnerCall[],
  overrides: Partial<Record<'setup' | 'connect' | 'service', RuntimeCommandResult>> = {}
) {
  return (script: string, options?: RuntimeCommandOptions): Promise<RuntimeCommandResult> => {
    calls.push({ script, options });
    if (script.includes('--version')) return Promise.resolve(ok(VERSION));
    if (script.includes('setup --slot remote')) return Promise.resolve(overrides.setup ?? ok('{}'));
    if (script.includes('connect --hub')) return Promise.resolve(overrides.connect ?? ok());
    if (script.includes('service install')) return Promise.resolve(overrides.service ?? ok());
    throw new Error(`unexpected script: ${script}`);
  };
}

function fakePairing(issued: { count: number }): RuntimePairingService {
  return {
    issue: () => {
      issued.count += 1;
      return Promise.resolve({
        environmentId: 'vps',
        createdAt: 0,
        lastSeenAt: null,
        token: TOKEN,
      });
    },
  } as unknown as RuntimePairingService;
}

function fakeManager(state: 'connected' | 'disconnected'): RuntimeConnectionManager {
  return { getStatus: () => ({ state }) } as unknown as RuntimeConnectionManager;
}

function fakeStream(lines: string[]) {
  return {
    events: [],
    closed: false,
    publish: (event: { type: string; line?: string }) => {
      if (event.type === 'log' && event.line) lines.push(event.line);
    },
    close: () => undefined,
    subscribe: () => {
      throw new Error('not used in this test');
    },
  } as unknown as Parameters<typeof runPairedBootstrap>[0]['stream'];
}

function input(overrides: Partial<Parameters<typeof runPairedBootstrap>[0]>) {
  return {
    userId: 'user-1',
    environmentId: 'vps',
    body: BODY,
    endpoint: ENDPOINT,
    pairing: fakePairing({ count: 0 }),
    manager: fakeManager('connected'),
    stream: fakeStream([]),
    signal: new AbortController().signal,
    dialInTimeoutMs: 200,
    ...overrides,
  } as Parameters<typeof runPairedBootstrap>[0];
}

describe('runPairedBootstrap', () => {
  const originalVersion = process.env.VERSION;

  beforeEach(() => {
    process.env.VERSION = VERSION;
  });

  afterEach(() => {
    if (originalVersion === undefined) delete process.env.VERSION;
    else process.env.VERSION = originalVersion;
  });

  it('pushes, consents, pairs and supervises in that order', async () => {
    const calls: RunnerCall[] = [];
    const outcome = await runPairedBootstrap(input({ runner: fakeRunner(calls) }));

    expect(outcome).toBe('connected');
    expect(calls.map((call) => stepOf(call.script))).toEqual([
      'version',
      'setup',
      'connect',
      'service',
    ]);
  });

  it('sends the pairing token on stdin and never in argv', async () => {
    const calls: RunnerCall[] = [];
    await runPairedBootstrap(input({ runner: fakeRunner(calls) }));

    const connect = calls.find((call) => stepOf(call.script) === 'connect');
    const stdin = new TextDecoder().decode(connect?.options?.stdin ?? new Uint8Array());
    expect(stdin).toBe(TOKEN);
    for (const call of calls) {
      expect(call.options?.args ?? []).not.toContain(TOKEN);
      expect(call.script).not.toContain('secret-value');
    }
  });

  it('mints no credential when the machine never consented', async () => {
    const issued = { count: 0 };
    const calls: RunnerCall[] = [];
    const runner = fakeRunner(calls, {
      setup: { stdout: '', stderr: 'Permission denied (publickey).', exitCode: 255 },
    });

    // A live credential for a machine that refused to say what a hub may do
    // there is exactly the thing that must not be left lying around.
    await expect(
      runPairedBootstrap(input({ runner, pairing: fakePairing(issued) }))
    ).rejects.toThrow(/refused the credentials/);
    expect(issued.count).toBe(0);
    expect(calls.some((call) => stepOf(call.script) === 'connect')).toBe(false);
  });

  it('describes a failed step with the ssh classifier, not a generic error', async () => {
    const calls: RunnerCall[] = [];
    const runner = fakeRunner(calls, {
      connect: { stdout: '', stderr: 'Host key verification failed.', exitCode: 255 },
    });

    await expect(runPairedBootstrap(input({ runner }))).rejects.toThrow(/known_hosts/);
  });

  it('keeps a machine whose service could not be installed, and says what is left', async () => {
    const lines: string[] = [];
    const calls: RunnerCall[] = [];
    const runner = fakeRunner(calls, {
      service: {
        stdout: '',
        stderr: 'No D-Bus session bus for systemd user services.',
        exitCode: 1,
      },
    });

    const outcome = await runPairedBootstrap(
      input({ runner, stream: fakeStream(lines), manager: fakeManager('disconnected') })
    );

    expect(outcome).toBe('unsupervised');
    // The runtime's own typed refusal carries its fix; it is passed through
    // rather than restated.
    expect(lines).toContain('No D-Bus session bus for systemd user services.');
    expect(lines.some((line) => line.includes('provisioned, consented and paired'))).toBe(true);
  });

  it('reports a supervised machine that never dialed in as a failure', async () => {
    const lines: string[] = [];
    const calls: RunnerCall[] = [];

    const outcome = await runPairedBootstrap(
      input({
        runner: fakeRunner(calls),
        stream: fakeStream(lines),
        manager: fakeManager('disconnected'),
      })
    );

    expect(outcome).toBe('no-dial-in');
    expect(lines.some((line) => line.includes(ENDPOINT))).toBe(true);
  });
});

function stepOf(script: string): string {
  if (script.includes('--version')) return 'version';
  if (script.includes('setup --slot remote')) return 'setup';
  if (script.includes('connect --hub')) return 'connect';
  if (script.includes('service install')) return 'service';
  return 'unknown';
}
