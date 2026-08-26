import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import {
  auditLogRotatedPath,
  createRuntimeAuditSink,
  MAX_BUFFERED_RECORDS,
  parseAuditSince,
  readRuntimeAuditError,
  readRuntimeAuditLog,
  rotateIfNeeded,
  summarizeAuditArgs,
} from '../../src/audit-log';
import { staticConsentSource } from '../../src/consent-source';
import { RuntimeHost } from '../../src/host';
import { createLocalRuntimeHost } from '../../src/runtime';
import { connectInProcessRuntime } from '../../src/transports/in-process';

/** A peer built before `hello_ack` carried `hub` — no `acceptsHubIdentity`. */
const PRE_AUDIT_MANIFEST: RuntimeCapabilityManifest = {
  platform: 'linux',
  arch: 'x64',
  pathStyle: 'posix',
  homeDir: '/home/peer',
  shells: [],
  git: { available: false },
  features: {
    tools: true,
    git: false,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: true,
  },
};

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => Bun.$`rm -rf ${home}`.quiet().nothrow()));
});

async function tempHome(): Promise<{ readonly env: NodeJS.ProcessEnv; readonly home: string }> {
  const home = await mkdtemp(join(tmpdir(), 'mango-audit-'));
  homes.push(home);
  return { home, env: { ...process.env, MANGO_HOME: home } };
}

describe('summarizeAuditArgs', () => {
  it('records paths and byte counts, never file contents', () => {
    expect(
      summarizeAuditArgs('fs.write-file', {
        path: '/tmp/a.txt',
        content: 'SECRET_PAYLOAD_BYTES',
      })
    ).toEqual({ path: '/tmp/a.txt', bytes: Buffer.byteLength('SECRET_PAYLOAD_BYTES') });
  });

  it('summarizes argv and omits env values', () => {
    expect(
      summarizeAuditArgs('install.run', {
        runId: 'run-1',
        argv: ['npm', 'install', 'left-pad'],
        env: { NPM_TOKEN: 'secret-token-value', PATH: '/usr/bin' },
        logPath: '/tmp/log',
      })
    ).toEqual({
      runId: 'run-1',
      argv: ['npm', 'install', 'left-pad'],
      logPath: '/tmp/log',
    });
  });

  it('records only the subcommand for gh, never the prose in its argv', () => {
    // `gh pr create --title ... --body ...` carries whatever a user wrote, and
    // the scrubber below is best-effort pattern matching on free-form English.
    // Two tokens name the operation, which is what the audit line is for.
    const summary = summarizeAuditArgs('gh.mutate', {
      cwd: '/repo',
      args: ['pr', 'create', '--title', 'Rotate the SECRET_PAYLOAD key', '--body', 'internal'],
    });

    expect(summary).toEqual({ cwd: '/repo', args: ['pr', 'create'] });
    expect(JSON.stringify(summary)).not.toContain('SECRET_PAYLOAD');
    expect(summarizeAuditArgs('gh.exec', { cwd: '/repo', args: ['--version'] })).toEqual({
      cwd: '/repo',
      args: ['--version'],
    });
  });

  it('still records the full argv for git, which composes its own', () => {
    // Only `gh.*` and `mcp.*` opt into argv summaries; git.exec argv is code-
    // defined and is deliberately not promoted onto the audit line at all.
    expect(summarizeAuditArgs('git.exec', { cwd: '/repo', args: ['status'] })).toEqual({
      cwd: '/repo',
    });
  });

  it('redacts credential-shaped tokens inside command and argv', () => {
    expect(
      summarizeAuditArgs('shell.run', {
        command: 'tool --token=SECRET_TOKEN --password=SECRET_PASSWORD',
      })
    ).toEqual({
      command: 'tool --token=*** --password=***',
    });
    expect(
      summarizeAuditArgs('install.run', {
        argv: [
          'tool',
          '--header',
          'Authorization: Bearer SECRET_TOKEN',
          '--password=SECRET_PASSWORD',
        ],
      })
    ).toEqual({
      argv: ['tool', '--header', 'Authorization: Bearer ***', '--password=***'],
    });
    expect(
      summarizeAuditArgs('mcp.call', {
        args: ['{"apiKey":"SECRET_API_KEY","password":"SECRET_PASSWORD"}'],
      })
    ).toEqual({
      args: ['{"apiKey":"***","password":"***"}'],
    });
  });

  it('redacts a credential that sits in the argv entry after its flag', () => {
    // No regex over one entry can see across the boundary, so the summariser
    // carries the flag forward instead.
    expect(
      summarizeAuditArgs('install.run', {
        argv: ['deploy', '--token', 'SECRET_TOKEN', '--verbose'],
      })
    ).toEqual({ argv: ['deploy', '--token', '***', '--verbose'] });
  });

  it('redacts bare assignments, URL credentials, and api-key headers', () => {
    expect(
      summarizeAuditArgs('shell.run', {
        command: 'export AWS_SECRET_ACCESS_KEY=SECRET_VALUE && deploy',
      })
    ).toEqual({ command: 'export AWS_SECRET_ACCESS_KEY=*** && deploy' });
    expect(
      summarizeAuditArgs('shell.run', { command: 'psql postgres://user:SECRET_PW@db/app' })
    ).toEqual({ command: 'psql postgres://user:***@db/app' });
    expect(
      summarizeAuditArgs('install.run', { argv: ['curl', '-H', 'X-Api-Key: SECRET_KEY'] })
    ).toEqual({ argv: ['curl', '-H', 'X-Api-Key: ***'] });
  });

  it('records update chunk length, not chunk bytes', () => {
    const payload = Buffer.from('not-on-disk');
    expect(
      summarizeAuditArgs('runtime.update.chunk', {
        sessionId: 's1',
        seq: 2,
        bytesBase64: payload.toString('base64'),
      })
    ).toEqual({
      sessionId: 's1',
      seq: 2,
      bytes: payload.byteLength,
    });
  });
});

describe('rotateIfNeeded', () => {
  it('drops the oldest sibling under a small cap', async () => {
    const { home } = await tempHome();
    const path = join(home, 'audit.log');
    await writeFile(path, 'active\n', 'utf8');
    await writeFile(`${path}.1`, 'one\n', 'utf8');
    await writeFile(`${path}.2`, 'two\n', 'utf8');

    // Force rotation regardless of size by using a tiny cap after a large write.
    await writeFile(path, 'x'.repeat(64), 'utf8');
    await rotateIfNeeded(path, 16, 2);

    // Rotation shifts the active file away; the next append recreates it. No
    // check-then-create on the path (that is the CodeQL race this avoids).
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(auditLogRotatedPath(path, 1), 'utf8')).toBe('x'.repeat(64));
    expect(await readFile(auditLogRotatedPath(path, 2), 'utf8')).toBe('one\n');
  });
});

describe('createRuntimeAuditSink', () => {
  it('buffers, flushes, and never exceeds the rotated budget for many lines', async () => {
    const { home, env } = await tempHome();
    const path = join(home, 'slot', 'audit.log');
    const sink = createRuntimeAuditSink({
      slot: 'remote',
      enabled: true,
      env,
      path,
      maxBytes: 200,
      maxFiles: 2,
      flushIntervalMs: 10_000,
    });
    sink.setHub({ host: 'hub.local', user: 'alice' });
    for (let i = 0; i < 40; i += 1) {
      sink.record({
        method: 'fs.read-file',
        outcome: 'ok',
        durationMs: 1,
        params: { path: `/tmp/file-${i}.txt` },
      });
    }
    await sink.flush();
    await sink.close();

    const records = await readRuntimeAuditLog({ path });
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.hub === 'alice@hub.local')).toBe(true);

    let total = 0;
    for (const file of [path, `${path}.1`, `${path}.2`]) {
      try {
        total += (await Bun.file(file).size) || 0;
      } catch {
        // absent
      }
    }
    // Active + two siblings, each capped roughly at maxBytes after rotation.
    expect(total).toBeLessThanOrEqual(200 * 3 + 200);
  });

  it('flushes on its own interval without anyone asking', async () => {
    const { home, env } = await tempHome();
    const path = join(home, 'audit.log');
    const sink = createRuntimeAuditSink({
      slot: 'remote',
      enabled: true,
      env,
      path,
      flushIntervalMs: 10,
    });
    try {
      sink.record({
        method: 'fs.read-file',
        outcome: 'ok',
        durationMs: 1,
        params: { path: '/tmp/a.txt' },
      });
      // Poll rather than sleep a fixed span: the assertion is that the timer
      // drains the buffer unaided, not that it does so within one tick.
      const deadline = Date.now() + 5_000;
      let records = await readRuntimeAuditLog({ path });
      while (records.length === 0 && Date.now() < deadline) {
        await Bun.sleep(10);
        records = await readRuntimeAuditLog({ path });
      }
      expect(records.map((record) => record.method)).toEqual(['fs.read-file']);
    } finally {
      await sink.close();
    }
  });

  it('degrades on write failure without throwing into the caller', async () => {
    const { home, env } = await tempHome();
    // Point the log at a path whose parent is a file — mkdir/append must fail.
    const blocker = join(home, 'blocked');
    await writeFile(blocker, 'not-a-directory', 'utf8');
    const path = join(blocker, 'audit.log');
    const sink = createRuntimeAuditSink({
      slot: 'remote',
      enabled: true,
      env,
      path,
      flushIntervalMs: 10_000,
    });
    sink.record({ method: 'fs.read-file', outcome: 'ok', durationMs: 1 });
    await sink.flush();
    expect(sink.lastError()).toBeTruthy();
    expect(await readRuntimeAuditError(path)).toBeTruthy();
    await sink.close();
  });

  it('drains records added while a flush is in flight on close', async () => {
    const { home, env } = await tempHome();
    const path = join(home, 'audit.log');
    const sink = createRuntimeAuditSink({
      slot: 'remote',
      enabled: true,
      env,
      path,
      flushIntervalMs: 10_000,
    });
    sink.record({
      method: 'fs.read-file',
      outcome: 'ok',
      durationMs: 1,
      params: { path: '/tmp/a.txt' },
    });
    // Start a flush without awaiting so the second record lands mid-batch.
    const inFlight = sink.flush();
    sink.record({
      method: 'fs.write-file',
      outcome: 'ok',
      durationMs: 2,
      params: { path: '/tmp/b.txt' },
    });
    await inFlight;
    await sink.close();

    const records = await readRuntimeAuditLog({ path });
    expect(records.map((record) => record.method)).toEqual(['fs.read-file', 'fs.write-file']);
  });

  it('caps the retry buffer after write failures and reports dropped records', async () => {
    const { home, env } = await tempHome();
    const blocker = join(home, 'blocked');
    await writeFile(blocker, 'not-a-directory', 'utf8');
    const path = join(blocker, 'audit.log');
    const sink = createRuntimeAuditSink({
      slot: 'remote',
      enabled: true,
      env,
      path,
      flushIntervalMs: 10_000,
    });
    const overflow = 50;
    for (let i = 0; i < MAX_BUFFERED_RECORDS + overflow; i += 1) {
      sink.record({
        method: 'fs.read-file',
        outcome: 'ok',
        durationMs: 1,
        params: { path: `/tmp/file-${i}.txt` },
      });
    }
    await sink.flush();
    const error = sink.lastError();
    expect(error).toBeTruthy();
    expect(error).toContain(`${overflow} record(s) dropped`);
    await sink.close();
  });
});

describe('dispatch audit hook', () => {
  it('logs denials with method, capability, and reason when no work ran', async () => {
    const { home, env } = await tempHome();
    const path = join(home, 'audit.log');
    const sink = createRuntimeAuditSink({
      slot: 'remote',
      enabled: true,
      env,
      path,
      flushIntervalMs: 10_000,
    });
    const host = createLocalRuntimeHost({
      runtimeVersion: '0.0.0-test',
      consent: staticConsentSource(RUNTIME_CONSENT_PRESETS.readonly, 'remote'),
      audit: sink,
    });
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      hub: { host: 'desk', user: 'bob' },
    });
    try {
      await expect(
        connection.client.request('shell.run', {
          kind: 'bash',
          command: 'true',
          timeoutMs: 1_000,
          maxOutputBytes: 1_024,
        })
      ).rejects.toMatchObject({ code: 'RUNTIME_DENIED' });
      await sink.flush();
      const denied = await readRuntimeAuditLog({ path, deniedOnly: true });
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({
        method: 'shell.run',
        outcome: 'denied',
        capability: 'shell',
        code: 'RUNTIME_DENIED',
        hub: 'bob@desk',
      });
    } finally {
      connection.close();
      await sink.close();
    }
  });

  it('tolerates an older hub with no identity field', async () => {
    const { home, env } = await tempHome();
    const path = join(home, 'audit.log');
    const sink = createRuntimeAuditSink({
      slot: 'wsl',
      enabled: true,
      env,
      path,
      flushIntervalMs: 10_000,
    });
    const host = createLocalRuntimeHost({
      runtimeVersion: '0.0.0-test',
      consent: staticConsentSource(RUNTIME_CONSENT_PRESETS.full, 'wsl'),
      audit: sink,
    });
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      hub: null,
    });
    try {
      await connection.client.request('runtime.health', {});
      await sink.flush();
      const lines = await readRuntimeAuditLog({ path });
      expect(lines.some((line) => line.hub === 'unidentified hub')).toBe(true);
    } finally {
      connection.close();
      await sink.close();
    }
  });

  it('keeps the shared sink writable after the host closes', async () => {
    const { home, env } = await tempHome();
    const path = join(home, 'audit.log');
    const sink = createRuntimeAuditSink({
      slot: 'remote',
      enabled: true,
      env,
      path,
      flushIntervalMs: 10_000,
    });
    const host = createLocalRuntimeHost({
      runtimeVersion: '0.0.0-test',
      consent: staticConsentSource(RUNTIME_CONSENT_PRESETS.full, 'remote'),
      audit: sink,
    });
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      hub: { host: 'desk', user: 'bob' },
    });
    connection.close();
    // Host teardown must flush, not close, so reconnect/supersede can keep
    // writing through the process-scoped sink.
    sink.setHub({ host: 'desk', user: 'carol' });
    sink.record({
      method: 'runtime.health',
      outcome: 'ok',
      durationMs: 1,
    });
    await sink.flush();
    const lines = await readRuntimeAuditLog({ path });
    expect(lines.some((line) => line.hub === 'carol@desk')).toBe(true);
    await sink.close();
  });

  it('withholds hub identity from a peer that does not advertise the field', async () => {
    // `hello_ack` is a closed envelope: a runtime built before `hub` existed
    // fails the decode and drops the socket rather than ignoring the key. So
    // the hub reads the manifest — the tolerant surface, and it arrives first —
    // and stays silent when the peer has not said it can read the field.
    const { home, env } = await tempHome();
    const path = join(home, 'audit.log');
    const sink = createRuntimeAuditSink({
      slot: 'remote',
      enabled: true,
      env,
      path,
      flushIntervalMs: 10_000,
    });
    const host = new RuntimeHost({
      runtimeVersion: 'runtime-test',
      manifest: PRE_AUDIT_MANIFEST,
      handlers: new Map([['runtime.health', async () => ({})]]),
      audit: sink,
    });
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      hub: { host: 'desk', user: 'bob' },
      validateFrames: true,
    });
    try {
      await connection.client.request('runtime.health', {});
      await sink.flush();
      const lines = await readRuntimeAuditLog({ path });
      expect(lines).not.toHaveLength(0);
      expect(lines.every((line) => line.hub === 'unidentified hub')).toBe(true);
    } finally {
      connection.close();
      await sink.close();
    }
  });

  it('names the hub once the peer advertises that it reads the field', async () => {
    const { home, env } = await tempHome();
    const path = join(home, 'audit.log');
    const sink = createRuntimeAuditSink({
      slot: 'remote',
      enabled: true,
      env,
      path,
      flushIntervalMs: 10_000,
    });
    const host = new RuntimeHost({
      runtimeVersion: 'runtime-test',
      manifest: { ...PRE_AUDIT_MANIFEST, acceptsHubIdentity: true },
      handlers: new Map([['runtime.health', async () => ({})]]),
      audit: sink,
    });
    const connection = await connectInProcessRuntime(host, {
      hubVersion: 'hub-test',
      hub: { host: 'desk', user: 'bob' },
      validateFrames: true,
    });
    try {
      await connection.client.request('runtime.health', {});
      await sink.flush();
      const lines = await readRuntimeAuditLog({ path });
      expect(lines.every((line) => line.hub === 'bob@desk')).toBe(true);
    } finally {
      connection.close();
      await sink.close();
    }
  });

  it('never writes MCP secrets or pairing-shaped tokens into the log', async () => {
    const { home, env } = await tempHome();
    const path = join(home, 'audit.log');
    const sink = createRuntimeAuditSink({
      slot: 'remote',
      enabled: true,
      env,
      path,
      flushIntervalMs: 10_000,
    });
    const secret = 'pairing-token-SHOULD-NOT-APPEAR';
    const header = 'Bearer mcp-secret-SHOULD-NOT-APPEAR';
    sink.record({
      method: 'mcp.connect',
      outcome: 'ok',
      durationMs: 1,
      params: {
        id: 'server-1',
        slug: 'demo',
        secrets: { env: { TOKEN: secret }, headers: { Authorization: header } },
        env: { TOKEN: secret },
        headers: { Authorization: header },
        token: secret,
      },
    });
    await sink.flush();
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain(secret);
    expect(text).not.toContain(header);
    expect(text).not.toContain('SHOULD-NOT-APPEAR');
    expect(text).toContain('server-1');
    await sink.close();
  });
});

describe('parseAuditSince', () => {
  it('accepts relative durations and ISO instants', () => {
    const relative = parseAuditSince('1h');
    expect(typeof relative).toBe('string');
    const iso = parseAuditSince('2026-01-01T00:00:00.000Z');
    expect(iso).toBe('2026-01-01T00:00:00.000Z');
    expect(parseAuditSince('nope')).toMatchObject({ error: expect.any(String) });
  });

  it('rejects relative durations that overflow the date range', () => {
    const overflow = parseAuditSince(`${'9'.repeat(400)}d`);
    expect(overflow).toMatchObject({
      error: expect.stringContaining('outside the supported date range'),
    });
  });
});
