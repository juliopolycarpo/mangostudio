import { describe, expect, it } from 'bun:test';
import { hostname, userInfo } from 'node:os';
import type { RuntimeAuditSink } from '@mangostudio/runtime';
import type { HubIdentity } from '@mangostudio/shared/runtime-contract';
import {
  type HubIdentitySource,
  resolveLocalHubIdentity,
} from '../../../../src/services/runtime-client/hub-identity';
import { connectTestRuntime } from '../../../support/runtime-fixture';

/**
 * A machine that answers whatever the test says, including by refusing.
 *
 * @example
 * new FakeHubIdentitySource({ hostname: 'workstation', username: 'ana' });
 */
class FakeHubIdentitySource implements HubIdentitySource {
  readonly #hostname: string | Error;
  readonly #username: string | Error;

  constructor(answers: {
    readonly hostname: string | Error;
    readonly username: string | Error;
  }) {
    this.#hostname = answers.hostname;
    this.#username = answers.username;
  }

  hostname(): string {
    return unwrap(this.#hostname);
  }

  username(): string {
    return unwrap(this.#username);
  }
}

function unwrap(answer: string | Error): string {
  if (answer instanceof Error) throw answer;
  return answer;
}

/**
 * A sink that keeps what the runtime side was told, and lets a test await the
 * hub announcement rather than guess how many microtasks the handshake takes.
 *
 * @example
 * const audit = new RecordingAuditSink();
 * expect(await audit.identifiedHub()).toEqual({ host: 'box', user: 'ana' });
 */
class RecordingAuditSink implements RuntimeAuditSink {
  readonly enabled = true;
  readonly path = '(memory)';
  readonly announced: (HubIdentity | null)[] = [];
  readonly #identified = Promise.withResolvers<HubIdentity>();

  lastError(): string | null {
    return null;
  }

  setHub(hub: HubIdentity | null): void {
    this.announced.push(hub);
    if (hub) this.#identified.resolve(hub);
  }

  record(): void {
    // The hub identity is all this fixture is asked about.
  }

  async flush(): Promise<void> {
    // Nothing is buffered.
  }

  async close(): Promise<void> {
    // Nothing is held open.
  }

  /** The first identified hub, or null when none arrives inside `timeoutMs`. */
  async identifiedHub(timeoutMs = 1_000): Promise<HubIdentity | null> {
    const expired = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    });
    return await Promise.race([this.#identified.promise, expired]);
  }
}

describe('hub identity on a runtime session', () => {
  it('announces the local host and user when the caller names no hub', async () => {
    const audit = new RecordingAuditSink();
    const runtime = await connectTestRuntime({ handlers: {}, audit });

    try {
      expect(await audit.identifiedHub()).toEqual({
        host: hostname().trim(),
        user: userInfo().username.trim(),
      });
    } finally {
      await runtime.close();
    }
  });
});

describe('resolveLocalHubIdentity', () => {
  it('trims what the machine answers', () => {
    const source = new FakeHubIdentitySource({ hostname: ' workstation \n', username: ' ana ' });

    expect(resolveLocalHubIdentity(source)).toEqual({ host: 'workstation', user: 'ana' });
  });

  it('answers nothing when either half is blank', () => {
    const blankHost = new FakeHubIdentitySource({ hostname: '   ', username: 'ana' });
    const blankUser = new FakeHubIdentitySource({ hostname: 'workstation', username: '' });

    expect(resolveLocalHubIdentity(blankHost)).toBeUndefined();
    expect(resolveLocalHubIdentity(blankUser)).toBeUndefined();
  });

  it('answers nothing when the machine refuses', () => {
    const source = new FakeHubIdentitySource({
      hostname: 'workstation',
      username: new Error('uv_os_get_passwd returned ENOENT'),
    });

    expect(resolveLocalHubIdentity(source)).toBeUndefined();
  });
});
