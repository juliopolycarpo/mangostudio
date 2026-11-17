/**
 * Every 5xx the environment entity routes can produce, and the 409s that used
 * to forward a caught error's text, answer with fixed copy. Diagnostics (a
 * socket path, a pid, a home path, an environment variable, a stack frame) go
 * to the hub log with the environment id and never into the body.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RuntimeId } from '@mangostudio/shared/environments';
import { ApiErrorResponseSchema } from '@mangostudio/shared/errors';
import Value from 'typebox/value';

import { acquireToolchainCredentialLock } from '../../../src/backup/capture-lock';
import { getDb } from '../../../src/db/database';
import {
  createEnvironmentRuntimeEffects,
  createEnvironmentService,
  type EnvironmentRuntimeEffects,
} from '../../../src/modules/environments/application/environment-service';
import type { EnvironmentProbingService } from '../../../src/modules/environments/application/probing-service';
import { createToolchainService } from '../../../src/modules/environments/application/toolchain-service';
import type { RuntimeCommandResult } from '../../../src/modules/environments/domain/runtime-push';
import { createEnvironmentEntityRoutes } from '../../../src/modules/environments/http/environment-entity-routes';
import { createEnvironmentRepository } from '../../../src/modules/environments/infrastructure/environment-repository';
import { RuntimeConnectionManager } from '../../../src/services/runtime-client/runtime-connection-manager';
import { setRuntimeTokenStoreForTests } from '../../../src/services/runtime-client/runtime-token-secrets';
import {
  SecretStorageUnavailableError,
  type SecretStore,
} from '../../../src/services/secret-store/store';
import { DiagnosticWarnCapture } from '../../support/diagnostic-warn-capture';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'environment-error-leaks-user',
  name: 'Environment Error Leaks User',
  email: 'environment-error-leaks@mangostudio.test',
};

/** The fragments a client must never read; each one is in `LEAKY_DIAGNOSTIC`. */
const LEAKED_FRAGMENTS = [
  '/run/user/1000/mango-runtime.sock',
  '48213',
  '/home/alice',
  'MANGOSTUDIO_RUNTIME_BINARY',
  'connectRuntime (',
  'Permission denied (publickey)',
  'build-host.internal',
] as const;

const LEAKY_DIAGNOSTIC =
  'connect ENOENT /run/user/1000/mango-runtime.sock (pid 48213); set MANGOSTUDIO_RUNTIME_BINARY; Permission denied (publickey) for alice@build-host.internal\n    at connectRuntime (/home/alice/mango/apps/api/src/connect.ts:42:11)';

let restoreAuth: (() => void) | null = null;

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  setRuntimeTokenStoreForTests(undefined);
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  await getDb().deleteFrom('environments').where('userId', '=', TEST_USER.id).execute();
  await getDb().deleteFrom('environment_toolchains').where('userId', '=', TEST_USER.id).execute();
});

/** Named fake for a remote host: every command exits non-zero with a leaking stderr. */
function failingSshRunnerFor(
  stderr: string = LEAKY_DIAGNOSTIC,
  exitCode = 255
): () => (script: string) => Promise<RuntimeCommandResult> {
  return () => () => Promise.resolve({ stdout: '', stderr, exitCode } as const);
}

/** Named fake for a secret store whose backend names paths and hosts when it fails. */
class LeakySecretStore implements SecretStore {
  constructor(private readonly failure: () => Error) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }
  getSecret(): Promise<string | null> {
    return Promise.resolve(null);
  }
  setSecret(): Promise<void> {
    return Promise.reject(this.failure());
  }
  deleteSecret(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** Named fake for probing: asking an environment what it has fails with a leaking error. */
class LeakyProbingService {
  getRuntimeStatus(_scope: unknown, _id: RuntimeId): Promise<never> {
    return Promise.reject(new Error(LEAKY_DIAGNOSTIC));
  }
}

/**
 * Named fake for a manager whose interactive connect fails with something that is
 * not a connect refusal, the case the service maps to 409.
 */
class RawFailureConnectManager extends RuntimeConnectionManager {
  override connectInteractive(): Promise<never> {
    return Promise.reject(new Error(LEAKY_DIAGNOSTIC));
  }
}

interface AppOptions {
  readonly runtimeEffects?: EnvironmentRuntimeEffects;
  readonly secretStore?: SecretStore;
  readonly credentialDatabasePath?: () => string;
  readonly rawConnectFailure?: boolean;
}

function createTestApp(options: AppOptions = {}) {
  const repository = createEnvironmentRepository(getDb());
  const managerOptions = {
    resolveEnvironment: async (userId: string, environmentId: string) =>
      repository.find(userId, environmentId),
    connectors: {},
  };
  const manager = options.rawConnectFailure
    ? new RawFailureConnectManager(managerOptions)
    : new RuntimeConnectionManager(managerOptions);
  const toolchain = createToolchainService(
    undefined,
    new LeakyProbingService() as unknown as EnvironmentProbingService
  );
  const service = createEnvironmentService(
    repository,
    manager,
    undefined,
    options.secretStore,
    options.runtimeEffects ?? {
      hasActiveInstall: () => false,
      cancelActiveRun: () => false,
      removeRuntimeBytes: () => Promise.resolve(),
    },
    toolchain,
    undefined,
    options.credentialDatabasePath
  );
  const { app, restore } = createAuthenticatedApiTestApp(
    TEST_USER,
    createEnvironmentEntityRoutes(service, undefined, undefined, toolchain)
  );
  restoreAuth = restore;
  return { app, repository };
}

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

interface LeakCase {
  readonly name: string;
  readonly status: number;
  readonly reason: string;
  /** A substring the fixed message must contain: the cause and fix it names. */
  readonly messageIncludes?: string;
  /** Text the hub log line must carry; defaults to the pid in `LEAKY_DIAGNOSTIC`. */
  readonly logged?: string;
  /** Case-specific fragments the body must not carry, on top of `LEAKED_FRAGMENTS`. */
  readonly leaked?: readonly string[];
  readonly run: () => Promise<Response>;
}

interface RemoteRemovalSample {
  readonly label: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly reason: string;
  readonly messageIncludes: string;
}

/** What the remote uninstall's stderr says decides the advice the user gets. */
const REMOTE_REMOVAL_SAMPLES: readonly RemoteRemovalSample[] = [
  {
    label: 'changed host key',
    stderr:
      '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nOffending ECDSA key in /home/alice/.ssh/known_hosts:7\nHost key verification failed.',
    exitCode: 255,
    reason: 'host-key-mismatch',
    messageIncludes: 'host key',
  },
  {
    label: 'slot directory not writable',
    stderr: "rm: cannot remove '/home/alice/.mango/runtime/host': Permission denied",
    exitCode: 1,
    reason: 'remote-permission-denied',
    messageIncludes: 'permission denied',
  },
  {
    label: 'host unreachable',
    stderr: 'ssh: connect to host build-host.internal port 22: Connection refused',
    exitCode: 255,
    reason: 'host-unreachable',
    messageIncludes: 'could not reach the machine',
  },
  {
    label: 'unclassified failure shows only the exit code',
    stderr: '/home/alice/slot-cleanup.sh: unexpected failure 48213',
    exitCode: 3,
    reason: 'remote-command-failed',
    messageIncludes: '(exit code 3)',
  },
];

const scratchDirectories: string[] = [];

function makeScratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'environment-error-leaks-'));
  scratchDirectories.push(directory);
  return directory;
}

async function seedSshEnvironment(repository: ReturnType<typeof createTestApp>['repository']) {
  await repository.create({
    id: 'leak-ssh',
    userId: TEST_USER.id,
    name: 'Leak SSH',
    transportKind: 'ssh',
    config: { host: 'build-host.internal', user: 'alice' },
    enabled: true,
  });
}

async function seedHttpEnvironment(repository: ReturnType<typeof createTestApp>['repository']) {
  await repository.create({
    id: 'leak-http',
    userId: TEST_USER.id,
    name: 'Leak HTTP',
    transportKind: 'http',
    config: { baseUrl: 'http://leak.example' },
    enabled: true,
  });
}

const CASES: readonly (readonly [string, () => LeakCase])[] = [
  [
    'remote uninstall stderr',
    () => {
      const { app, repository } = createTestApp({
        runtimeEffects: {
          ...createEnvironmentRuntimeEffects(failingSshRunnerFor()),
          hasActiveInstall: () => false,
          cancelActiveRun: () => false,
        },
      });
      return {
        name: 'remote uninstall stderr',
        status: 503,
        // The leaking stderr carries OpenSSH's publickey refusal.
        reason: 'auth-failed',
        run: async () => {
          await seedSshEnvironment(repository);
          return app.handle(
            new Request('http://localhost/environments/leak-ssh?removeRuntime=true', json('DELETE'))
          );
        },
      };
    },
  ],
  [
    'removeRuntimeBytes throws a raw error',
    () => {
      const { app, repository } = createTestApp({
        runtimeEffects: {
          hasActiveInstall: () => false,
          cancelActiveRun: () => false,
          removeRuntimeBytes: () => Promise.reject(new Error(LEAKY_DIAGNOSTIC)),
        },
      });
      return {
        name: 'removeRuntimeBytes throws a raw error',
        status: 503,
        reason: 'auth-failed',
        run: async () => {
          await seedSshEnvironment(repository);
          return app.handle(
            new Request('http://localhost/environments/leak-ssh?removeRuntime=true', json('DELETE'))
          );
        },
      };
    },
  ],
  [
    'secret store outage while creating',
    () => {
      const { app } = createTestApp({
        secretStore: new LeakySecretStore(
          () => new SecretStorageUnavailableError(LEAKY_DIAGNOSTIC)
        ),
      });
      return {
        name: 'secret store outage while creating',
        status: 503,
        reason: 'token-storage-failed',
        run: () =>
          app.handle(
            new Request(
              'http://localhost/environments',
              json('POST', {
                id: 'leak-created',
                name: 'Leak created',
                transportKind: 'http',
                config: { baseUrl: 'http://leak.example' },
                token: 'secret-token',
              })
            )
          ),
      };
    },
  ],
  [
    'secret store failure while rotating',
    () => {
      const { app, repository } = createTestApp({
        secretStore: new LeakySecretStore(() => new Error(LEAKY_DIAGNOSTIC)),
      });
      return {
        name: 'secret store failure while rotating',
        status: 400,
        reason: 'token-storage-failed',
        // A write error is not the user's token's fault, so the copy must not say so.
        messageIncludes: 'The hub could not store the runtime token. Details are in the hub log.',
        run: async () => {
          await seedHttpEnvironment(repository);
          return app.handle(
            new Request(
              'http://localhost/environments/leak-http',
              json('PUT', { token: 'secret-token' })
            )
          );
        },
      };
    },
  ],
  [
    'credential path lookup throws a raw error',
    () => {
      const { app, repository } = createTestApp({
        credentialDatabasePath: () => {
          throw new Error(LEAKY_DIAGNOSTIC);
        },
      });
      return {
        name: 'credential path lookup throws a raw error',
        status: 409,
        reason: 'token-lock-failed',
        messageIncludes: 'could not lock the credentials',
        run: async () => {
          await seedHttpEnvironment(repository);
          return app.handle(
            new Request(
              'http://localhost/environments/leak-http',
              json('PUT', { token: 'secret-token' })
            )
          );
        },
      };
    },
  ],
  [
    'token edit lock is held by another editor',
    () => {
      const directory = makeScratchDirectory();
      const databasePath = join(directory, 'mango.sqlite');
      const { app, repository } = createTestApp({ credentialDatabasePath: () => databasePath });
      return {
        name: 'token edit lock is held by another editor',
        status: 409,
        reason: 'token-edit-locked',
        messageIncludes: 'in progress',
        logged: 'in progress',
        leaked: [directory],
        run: async () => {
          await seedHttpEnvironment(repository);
          // A second process holding the same environment's edit lock.
          const release = await acquireToolchainCredentialLock(
            databasePath,
            TEST_USER.id,
            'leak-http',
            'edit'
          );
          try {
            return await app.handle(
              new Request(
                'http://localhost/environments/leak-http',
                json('PUT', { token: 'secret-token' })
              )
            );
          } finally {
            await release();
          }
        },
      };
    },
  ],
  [
    'connect fails with a raw error',
    () => {
      const { app, repository } = createTestApp({ rawConnectFailure: true });
      return {
        name: 'connect fails with a raw error',
        status: 409,
        reason: 'auth-failed',
        run: async () => {
          await seedSshEnvironment(repository);
          return app.handle(
            new Request('http://localhost/environments/leak-ssh/connect', json('POST'))
          );
        },
      };
    },
  ],
  [
    'toolchain probe fails',
    () => {
      const { app, repository } = createTestApp();
      return {
        name: 'toolchain probe fails',
        status: 503,
        reason: 'toolchain-probe-failed',
        run: async () => {
          await seedSshEnvironment(repository);
          return app.handle(
            new Request(
              'http://localhost/environments/leak-ssh/toolchain',
              json('PUT', { node: '/opt/node/bin/node' })
            )
          );
        },
      };
    },
  ],
  ...REMOTE_REMOVAL_SAMPLES.map((sample): readonly [string, () => LeakCase] => [
    `remote uninstall: ${sample.label}`,
    () => {
      const { app, repository } = createTestApp({
        runtimeEffects: {
          ...createEnvironmentRuntimeEffects(failingSshRunnerFor(sample.stderr, sample.exitCode)),
          hasActiveInstall: () => false,
          cancelActiveRun: () => false,
        },
      });
      return {
        name: sample.label,
        status: 503,
        reason: sample.reason,
        messageIncludes: sample.messageIncludes,
        // Every removal diagnostic is prefixed with the host it was run against.
        logged: 'build-host.internal',
        run: async () => {
          await seedSshEnvironment(repository);
          return app.handle(
            new Request('http://localhost/environments/leak-ssh?removeRuntime=true', json('DELETE'))
          );
        },
      };
    },
  ]),
  [
    'WSL removal fails',
    () => {
      const { app, repository } = createTestApp({
        runtimeEffects: {
          hasActiveInstall: () => false,
          cancelActiveRun: () => false,
          removeRuntimeBytes: () => Promise.reject(new Error(LEAKY_DIAGNOSTIC)),
        },
      });
      return {
        name: 'WSL removal fails',
        status: 503,
        reason: 'runtime-removal-failed',
        messageIncludes: 'Check that the machine is running',
        run: async () => {
          await repository.create({
            id: 'leak-wsl',
            userId: TEST_USER.id,
            name: 'Leak WSL',
            transportKind: 'wsl',
            config: { distro: 'Ubuntu' },
            enabled: true,
          });
          return app.handle(
            new Request('http://localhost/environments/leak-wsl?removeRuntime=true', json('DELETE'))
          );
        },
      };
    },
  ],
  [
    'credential lock file is unsafe',
    () => {
      const directory = makeScratchDirectory();
      // The lock module words this refusal itself and names no path, so it passes through.
      symlinkSync(join(directory, 'missing-target.sqlite'), join(directory, 'mango.sqlite'));
      const { app, repository } = createTestApp({
        credentialDatabasePath: () => join(directory, 'mango.sqlite'),
      });
      return {
        name: 'credential lock file is unsafe',
        status: 409,
        reason: 'token-lock-failed',
        messageIncludes: 'refuses a dangling database symlink.',
        logged: 'dangling database symlink',
        leaked: [directory],
        run: async () => {
          await seedHttpEnvironment(repository);
          return app.handle(
            new Request(
              'http://localhost/environments/leak-http',
              json('PUT', { token: 'secret-token' })
            )
          );
        },
      };
    },
  ],
  [
    'credential lock hits a raw errno error',
    () => {
      const directory = makeScratchDirectory();
      writeFileSync(join(directory, 'blocker'), 'not a directory');
      const { app, repository } = createTestApp({
        credentialDatabasePath: () => join(directory, 'blocker', 'sub', 'mango.sqlite'),
      });
      return {
        name: 'credential lock hits a raw errno error',
        status: 409,
        reason: 'token-lock-failed',
        messageIncludes: 'could not lock the credentials',
        logged: directory,
        leaked: [directory],
        run: async () => {
          await seedHttpEnvironment(repository);
          return app.handle(
            new Request(
              'http://localhost/environments/leak-http',
              json('PUT', { token: 'secret-token' })
            )
          );
        },
      };
    },
  ],
];

describe('environment routes keep diagnostics out of error bodies', () => {
  for (const [label, build] of CASES) {
    it(`${label}: fixed message, stable reason, diagnostic only in the log`, async () => {
      const leakCase = build();
      const capture = new DiagnosticWarnCapture();
      let response: Response | undefined;
      const logged = await capture.during(async () => {
        response = await leakCase.run();
      });
      if (!response) throw new Error(`(${label}): the case produced no response`);

      const text = await response.clone().text();
      expect(
        response.status,
        `(${label}): expected status ${leakCase.status} | received: ${response.status} ${text}`
      ).toBe(leakCase.status);
      const body: unknown = JSON.parse(text);
      expect(Value.Check(ApiErrorResponseSchema, body)).toBe(true);
      expect(body).toMatchObject({ details: { reason: leakCase.reason } });
      if (leakCase.messageIncludes !== undefined) {
        const { error } = body as { error: string };
        expect(
          error.toLowerCase(),
          `(${label}): expected message naming "${leakCase.messageIncludes}" | received: ${error}`
        ).toContain(leakCase.messageIncludes.toLowerCase());
      }
      for (const fragment of [...LEAKED_FRAGMENTS, ...(leakCase.leaked ?? [])]) {
        expect(
          text.includes(fragment),
          `(${label}): expected body without "${fragment}" | received: ${text}`
        ).toBe(false);
      }

      // The detail is not discarded: the hub log carries it with the environment id.
      const line = logged.find((entry) => entry.includes('"service_refusal"'));
      expect(
        line,
        `(${label}): expected a service_refusal log line | received: ${logged.join(' ; ')}`
      ).toBeDefined();
      expect(line).toContain('"environmentId":"leak-');
      // The log line is JSON, so compare the fragment as JSON encodes it: a Windows path's
      // backslashes are doubled there.
      const loggedFragment = JSON.stringify(leakCase.logged ?? '48213').slice(1, -1);
      expect(
        line,
        `(${label}): expected the log line to carry "${loggedFragment}" | received: ${line}`
      ).toContain(loggedFragment);
    });
  }
});
