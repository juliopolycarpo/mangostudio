import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RegistryClient, RegistryResponse } from '../lib/canary-publication';
import type { CanaryTagAncestry, CanaryTagRunner } from '../lib/canary-tags';
import { CanaryVisibilityWindow } from '../lib/canary-visibility';
import { NPM_PLATFORMS } from '../lib/npm-pack';
import type { NpmCommandResult } from '../lib/npm-publish';
import {
  BunCanaryTagProcess,
  type CanaryTagProcess,
  GitHubCanaryTagAncestry,
  HttpCanaryRegistry,
  IsolatedCanaryTagRunner,
  runPromoteCanaryTagsCli,
} from '../release/promote-canary-tags';

const SOURCE = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const VERSION = '1.2.3-canary.aaaaaaa';
const OIDC = {
  GITHUB_ACTIONS: 'true',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/request',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-request-token',
};

class RecordingTagProcess implements CanaryTagProcess {
  readonly calls: {
    readonly command: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  }[] = [];
  run(
    command: readonly string[],
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }
  ): Promise<NpmCommandResult> {
    this.calls.push({ command: [...command], ...options });
    return Promise.resolve({ exitCode: 0, stdout: 'fixture-output', stderr: '' });
  }
}

class FakeGitHubCommands implements CanaryTagRunner {
  readonly calls: string[] = [];
  readonly results = new Map<string, NpmCommandResult>();
  run(command: readonly string[]): Promise<NpmCommandResult> {
    const key = command.join(' ');
    this.calls.push(key);
    const result = this.results.get(key);
    if (!result) throw new Error(`Unexpected fixture GitHub request ${key}`);
    return Promise.resolve(result);
  }
  response(path: string, body: unknown): void {
    this.results.set(`gh api repos/owner/repo/${path}`, {
      exitCode: 0,
      stdout: JSON.stringify(body),
      stderr: '',
    });
  }
}

class FakeRegistryFetch {
  readonly calls: { readonly url: string; readonly redirect: RequestInit['redirect'] }[] = [];
  readonly responses = new Map<string, { readonly status: number; readonly body: string }>();
  readonly failures = new Map<string, Error>();
  fetch(input: Parameters<typeof fetch>[0], options?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    this.calls.push({ url, redirect: options?.redirect });
    const failure = this.failures.get(url);
    if (failure) throw failure;
    const response = this.responses.get(url);
    if (!response) throw new Error(`Unexpected fixture fetch ${url}`);
    return Promise.resolve(new Response(response.body, { status: response.status }));
  }
}

class AbsentRegistry implements RegistryClient {
  reads = 0;
  getJson(): Promise<RegistryResponse<unknown>> {
    this.reads += 1;
    return Promise.resolve({ status: 404, body: null });
  }
  getBytes(): Promise<RegistryResponse<Uint8Array>> {
    throw new Error('Absent fixture packages must not request archive bytes');
  }
}
class ProbeOnlyRunner implements CanaryTagRunner {
  readonly calls: (readonly string[])[] = [];
  run(command: readonly string[]): Promise<NpmCommandResult> {
    this.calls.push([...command]);
    if (command.join(' ') === 'node --version')
      return Promise.resolve({ exitCode: 0, stdout: 'v22.14.0', stderr: '' });
    if (command.join(' ') === 'bunx --package npm@11.21.0 npm --version')
      return Promise.resolve({ exitCode: 0, stdout: '11.21.0', stderr: '' });
    throw new Error(`Unexpected write from probe-only fixture ${command.join(' ')}`);
  }
}
class UnusedAncestry implements CanaryTagAncestry {
  resolveCommit(): Promise<string> {
    throw new Error('Missing packages must stop before fixture ancestry');
  }
  compare(): Promise<'ahead'> {
    throw new Error('Missing packages must stop before fixture comparison');
  }
}

function manifestFixture(): object {
  const required = [
    ...NPM_PLATFORMS.flatMap((platform) =>
      ['package.json', platform.binary, platform.runtimeBinary].map(
        (name) => `dist-npm/${platform.os}-${platform.cpu}/${name}`
      )
    ),
    'dist-npm/cli/package.json',
    'dist-npm/cli/README.md',
    'dist-npm/cli/bin/mangostudio.js',
  ];
  return {
    schemaVersion: 5,
    sourceSha: SOURCE,
    packageVersion: VERSION,
    dirty: false,
    channel: 'canary',
    runtimeProfile: 'shipping',
    bunVersion: '1.4.4',
    bunRevision: 'd'.repeat(40),
    targets: [],
    files: required.map((path) => ({ path, size: 0, sha256: 'e'.repeat(64) })),
  };
}
function compareBody(base = OLD, head = SOURCE, status = 'ahead'): Record<string, unknown> {
  return {
    status,
    base_commit: { sha: base },
    merge_base_commit: { sha: status === 'behind' ? head : base },
    html_url: `https://github.com/owner/repo/compare/${base}...${head}`,
  };
}

describe('canary command adapters', () => {
  test('subprocess adapter drains stdout/stderr and retains failure status', async () => {
    const process = new BunCanaryTagProcess();
    expect(
      await process.run(
        [
          'node',
          '-e',
          'process.stdout.write("fixture-out"); process.stderr.write("fixture-err"); process.exitCode=7',
        ],
        { cwd: tmpdir(), env: globalThis.process.env }
      )
    ).toEqual({ exitCode: 7, stdout: 'fixture-out', stderr: 'fixture-err' });
  });
  test('pinned npm uses empty user/global configuration in an isolated project directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fix-canary-tag-recovery-runner-'));
    try {
      const process = new RecordingTagProcess();
      const runner = new IsolatedCanaryTagRunner(
        directory,
        {
          ...OIDC,
          NPM_CONFIG_REGISTRY: 'https://wrong.example',
          npm_config_userconfig: '/wrong/npmrc',
          PATH: '/fixture/path',
        },
        process
      );
      await runner.run([
        'bunx',
        '--package',
        'npm@11.21.0',
        'npm',
        'dist-tag',
        'add',
        `mangostudio@${VERSION}`,
        'canary',
      ]);
      expect(process.calls).toHaveLength(1);
      expect(process.calls[0]).toEqual({
        command: [
          'bunx',
          '--package',
          'npm@11.21.0',
          'npm',
          '--userconfig',
          join(directory, 'user.npmrc'),
          '--globalconfig',
          join(directory, 'global.npmrc'),
          'dist-tag',
          'add',
          `mangostudio@${VERSION}`,
          'canary',
        ],
        cwd: directory,
        env: { ...OIDC, PATH: '/fixture/path' },
      });
      expect(readFileSync(join(directory, '.npmrc'), 'utf8')).toBe('');
      expect(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))).toEqual({
        private: true,
      });
      expect(readFileSync(join(directory, 'user.npmrc'), 'utf8')).toBe('');
      expect(readFileSync(join(directory, 'global.npmrc'), 'utf8')).toBe('');
      await runner.run(['node', '--version']);
      expect(process.calls[1]?.command).toEqual(['node', '--version']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('runner refuses a populated project directory without overwriting it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fix-canary-tag-recovery-populated-'));
    try {
      writeFileSync(join(directory, 'package.json'), 'owner-fixture-content');
      expect(() => new IsolatedCanaryTagRunner(directory, OIDC, new RecordingTagProcess())).toThrow(
        'expected empty owned scratch directory'
      );
      expect(readFileSync(join(directory, 'package.json'), 'utf8')).toBe('owner-fixture-content');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('runner refuses a different npm pin before spawning it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fix-canary-tag-recovery-pin-'));
    try {
      const process = new RecordingTagProcess();
      const runner = new IsolatedCanaryTagRunner(directory, OIDC, process);
      expect(() => runner.run(['bunx', '--package', 'npm@11.5.1', 'npm', '--version'])).toThrow(
        'expected bunx --package npm@11.21.0 npm'
      );
      expect(process.calls).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('public registry adapter preserves actual statuses and downloaded bytes', async () => {
    const http = new FakeRegistryFetch();
    const registry = new HttpCanaryRegistry(http.fetch.bind(http) as typeof fetch);
    http.responses.set('https://registry.npmjs.org/metadata', {
      status: 200,
      body: '{"name":"fixture"}',
    });
    http.responses.set('https://registry.npmjs.org/missing', {
      status: 404,
      body: 'Not JSON; actually missing',
    });
    http.responses.set('https://registry.npmjs.org/blocked', { status: 403, body: 'Forbidden' });
    http.responses.set('https://registry.npmjs.org/archive', {
      status: 200,
      body: 'archive-fixture-bytes',
    });
    expect(await registry.getJson('https://registry.npmjs.org/metadata')).toEqual({
      status: 200,
      body: { name: 'fixture' },
    });
    expect(await registry.getJson('https://registry.npmjs.org/missing')).toEqual({
      status: 404,
      body: null,
    });
    expect(await registry.getBytes('https://registry.npmjs.org/blocked')).toEqual({
      status: 403,
      body: new Uint8Array(),
    });
    expect(await registry.getBytes('https://registry.npmjs.org/archive')).toEqual({
      status: 200,
      body: new TextEncoder().encode('archive-fixture-bytes'),
    });
    expect(http.calls.every((call) => call.redirect === 'error')).toBe(true);
  });
  test('registry adapter rejects malformed successful JSON and transport failures', async () => {
    const http = new FakeRegistryFetch();
    const registry = new HttpCanaryRegistry(http.fetch.bind(http) as typeof fetch);
    http.responses.set('https://registry.npmjs.org/malformed', { status: 200, body: '{broken' });
    http.failures.set(
      'https://registry.npmjs.org/network',
      new Error('fixture fetch disconnected')
    );
    await expect(registry.getJson('https://registry.npmjs.org/malformed')).rejects.toThrow(
      'expected valid JSON'
    );
    await expect(registry.getJson('https://registry.npmjs.org/network')).rejects.toThrow(
      'fixture fetch disconnected'
    );
    await expect(registry.getBytes('https://elsewhere.example/archive')).rejects.toThrow(
      'expected https://registry.npmjs.org/'
    );
  });
});

describe('GitHub canary ancestry adapter', () => {
  test('resolves a seven-character owner through the expected repository', async () => {
    const runner = new FakeGitHubCommands();
    runner.response('commits/bbbbbbb', { sha: OLD });
    const ancestry = new GitHubCanaryTagAncestry('owner/repo', runner);
    expect(await ancestry.resolveCommit('bbbbbbb')).toBe(OLD);
    expect(runner.calls).toEqual(['gh api repos/owner/repo/commits/bbbbbbb']);
  });
  test.each(['aaaaaaa', 'a'.repeat(40), null])(
    'rejects resolution %j for a different prefix',
    async (sha) => {
      const runner = new FakeGitHubCommands();
      runner.response('commits/bbbbbbb', { sha });
      await expect(
        new GitHubCanaryTagAncestry('owner/repo', runner).resolveCommit('bbbbbbb')
      ).rejects.toThrow('expected full SHA starting bbbbbbb');
    }
  );
  test.each(['main', 'AAAAAAA', 'aaa'])(
    'rejects invalid short source %s before I/O',
    async (prefix) => {
      const runner = new FakeGitHubCommands();
      await expect(
        new GitHubCanaryTagAncestry('owner/repo', runner).resolveCommit(prefix)
      ).rejects.toThrow('expected seven lowercase hex characters');
      expect(runner.calls).toEqual([]);
    }
  );
  test.each(['ahead', 'behind', 'diverged'])(
    'preserves associated compare verdict %s',
    async (status) => {
      const runner = new FakeGitHubCommands();
      runner.response(`compare/${OLD}...${SOURCE}`, compareBody(OLD, SOURCE, status));
      expect(await new GitHubCanaryTagAncestry('owner/repo', runner).compare(OLD, SOURCE)).toBe(
        status as 'ahead'
      );
    }
  );
  test('identical requires matching full sources and merge base', async () => {
    const runner = new FakeGitHubCommands();
    runner.response(`compare/${SOURCE}...${SOURCE}`, compareBody(SOURCE, SOURCE, 'identical'));
    expect(await new GitHubCanaryTagAncestry('owner/repo', runner).compare(SOURCE, SOURCE)).toBe(
      'identical'
    );
  });
  test.each([
    { status: 'pending' },
    { base_commit: { sha: SOURCE } },
    { merge_base_commit: { sha: SOURCE } },
    { html_url: 'https://github.com/other/repo/compare/source' },
    { status: 'identical' },
  ])('rejects unassociated comparison %j', async (mutation) => {
    const runner = new FakeGitHubCommands();
    runner.response(`compare/${OLD}...${SOURCE}`, { ...compareBody(), ...mutation });
    await expect(
      new GitHubCanaryTagAncestry('owner/repo', runner).compare(OLD, SOURCE)
    ).rejects.toThrow('expected associated GitHub compare verdict');
  });
  test('rejects malformed comparison input before I/O', async () => {
    const runner = new FakeGitHubCommands();
    await expect(
      new GitHubCanaryTagAncestry('owner/repo', runner).compare('bbbbbbb', SOURCE)
    ).rejects.toThrow('expected full base/head SHA');
    expect(runner.calls).toEqual([]);
  });
  test.each(['wrong', 'owner/..', '../repo'])('rejects invalid repository %s', (repository) => {
    expect(() => new GitHubCanaryTagAncestry(repository, new FakeGitHubCommands())).toThrow(
      'expected owner/repository'
    );
  });
  test('failed GitHub auth and malformed data cannot establish ancestry', async () => {
    const runner = new FakeGitHubCommands();
    const command = 'gh api repos/owner/repo/commits/bbbbbbb';
    const ancestry = new GitHubCanaryTagAncestry('owner/repo', runner);
    runner.results.set(command, { exitCode: 1, stdout: '', stderr: 'HTTP403 fixture' });
    await expect(ancestry.resolveCommit('bbbbbbb')).rejects.toThrow('expected exit0; received 1');
    runner.results.set(command, { exitCode: 0, stdout: '{broken', stderr: '' });
    await expect(ancestry.resolveCommit('bbbbbbb')).rejects.toThrow('expected valid JSON');
    runner.response('commits/bbbbbbb', []);
    await expect(ancestry.resolveCommit('bbbbbbb')).rejects.toThrow('expected object');
  });
});

describe('canary tag CLI identity', () => {
  test('help is read-only and requires no OIDC credentials', async () => {
    expect(await runPromoteCanaryTagsCli(['--help'], {})).toBe(null);
  });
  test.each([['--invalid'], ['one', 'two']].map((args) => [args]))(
    'rejects invalid arguments %j',
    async (args) => {
      await expect(runPromoteCanaryTagsCli(args, {})).rejects.toThrow(
        'expected optional manifest path'
      );
    }
  );
  test('requires repository identity before reading a manifest', async () => {
    await expect(runPromoteCanaryTagsCli([], {})).rejects.toThrow('Invalid REPO');
  });
  test.each([{ SOURCE_SHA: OLD }, { VERSION: '1.2.2' }])(
    'rejects manifest/source mismatch %j before vendor commands',
    async (override) => {
      const directory = mkdtempSync(join(tmpdir(), 'fix-canary-tag-recovery-cli-'));
      try {
        const path = join(directory, 'manifest.json');
        writeFileSync(path, JSON.stringify(manifestFixture()));
        await expect(
          runPromoteCanaryTagsCli([path], { ...OIDC, REPO: 'owner/repo', ...override })
        ).rejects.toThrow('Canary tag manifest identity mismatch');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
  test('injects read/command/ancestry boundaries and refuses missing packages before writes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fix-canary-tag-recovery-cli-'));
    try {
      const path = join(directory, 'manifest.json');
      writeFileSync(path, JSON.stringify(manifestFixture()));
      const registry = new AbsentRegistry();
      const runner = new ProbeOnlyRunner();
      await expect(
        runPromoteCanaryTagsCli(
          [path],
          { ...OIDC, REPO: 'owner/repo', SOURCE_SHA: SOURCE, VERSION },
          { registry, runner, ancestry: new UnusedAncestry(), visibility: { retryDelaysMs: [] } }
        )
      ).rejects.toThrow('requires all seven verified packages');
      expect(registry.reads).toBe(14);
      expect(runner.calls).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

class StalledRegistryFetch {
  signal?: AbortSignal;
  aborted = false;
  constructor(private readonly stage: 'headers' | 'body') {}
  fetch(_input: Parameters<typeof fetch>[0], options?: RequestInit): Promise<Response> {
    const signal = options?.signal;
    if (!signal) throw new Error('Fixture requires a propagated deadline signal');
    this.signal = signal;
    if (this.stage === 'headers')
      return new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            this.aborted = true;
            reject(signal.reason);
          },
          { once: true }
        );
      });
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        signal.addEventListener(
          'abort',
          () => {
            this.aborted = true;
            controller.error(signal.reason);
          },
          { once: true }
        );
      },
    });
    return Promise.resolve(new Response(body));
  }
}

test.each(['headers', 'body'] as const)(
  'TTL cancels actual registry %s I/O, including response consumption',
  async (stage) => {
    const http = new StalledRegistryFetch(stage);
    const registry = new HttpCanaryRegistry(http.fetch.bind(http) as typeof fetch);
    for (const method of ['getJson', 'getBytes'] as const) {
      const window = new CanaryVisibilityWindow({ ttlMs: 25, retryDelaysMs: [] });
      const outcome = await Promise.race([
        window
          .read(
            (signal) => registry[method]('https://registry.npmjs.org/fixture', signal),
            () => true
          )
          .then(
            () => 'unexpected success',
            (cause: Error) => cause.message
          ),
        Bun.sleep(500).then(() => 'watchdog: registry did not settle'),
      ]);
      expect(outcome).toContain('TTL expired');
      expect(http.signal?.aborted).toBe(true);
      expect(http.aborted).toBe(true);
    }
  }
);

test('TTL kills and reaps an active command instead of leaving it running', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'canary-deadline-command-'));
  const marker = join(directory, 'pid');
  const controller = new AbortController();
  const command = new BunCanaryTagProcess();
  const completion = command.run(
    [
      process.execPath,
      '-e',
      `await Bun.write(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`,
    ],
    { cwd: directory, env: process.env, signal: controller.signal }
  );
  try {
    let pid = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await Bun.file(marker).exists()) {
        pid = Number(readFileSync(marker, 'utf8'));
        break;
      }
      await Bun.sleep(10);
    }
    expect(pid).toBeGreaterThan(0);
    controller.abort(new Error('fixture TTL expired'));
    const result = await Promise.race([completion, Bun.sleep(500).then(() => null)]);
    expect(result).not.toBe(null);
    expect(result?.exitCode).not.toBe(0);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    await completion;
    rmSync(directory, { recursive: true, force: true });
  }
});

class UnconsumedErrorRegistryFetch {
  cancelled = 0;
  fetch(_input: Parameters<typeof fetch>[0], _options?: RequestInit): Promise<Response> {
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel: () => {
            this.cancelled++;
          },
        }),
        { status: 503 }
      )
    );
  }
}

test('temporary HTTP responses release their unused bodies before the next retry', async () => {
  const http = new UnconsumedErrorRegistryFetch();
  const registry = new HttpCanaryRegistry(http.fetch.bind(http) as typeof fetch);
  expect((await registry.getJson('https://registry.npmjs.org/fixture')).status).toBe(503);
  expect((await registry.getBytes('https://registry.npmjs.org/fixture')).status).toBe(503);
  expect(http.cancelled).toBe(2);
});
