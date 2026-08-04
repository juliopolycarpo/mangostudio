import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
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
import { createLocalRuntimeHost } from '../../src/runtime';
import { connectInProcessRuntime } from '../../src/transports/in-process';

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
});
