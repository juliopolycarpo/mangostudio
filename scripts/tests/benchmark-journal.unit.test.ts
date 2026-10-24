import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { appendBenchmarkJournal, writeBenchmarkProgress } from '../lib/benchmark-journal';
import { runNativeCommand } from '../lib/native-bun-qualification-process';

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
class DiscardedJournalOutput extends Writable {
  override _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    done();
  }
}
class FakeAbruptJournalProcess {
  constructor(private readonly directory: string) {}
  async create(): Promise<string> {
    const script = join(this.directory, 'abrupt-journal.ts');
    await Bun.write(
      script,
      `import { appendBenchmarkJournal, writeBenchmarkProgress } from ${JSON.stringify(resolve(import.meta.dir, '../lib/benchmark-journal.ts'))};
const journal = ${JSON.stringify(join(this.directory, 'events.jsonl'))};
const output = ${JSON.stringify(join(this.directory, 'receipt.json'))};
const finished = { kind: 'finished', phase: 'measured', index: 1, status: 'success' };
await appendBenchmarkJournal(journal, finished);
await writeBenchmarkProgress(output, { complete: false, attempts: [finished] });
await appendBenchmarkJournal(journal, { kind: 'started', phase: 'measured', index: 2 });
process.kill(process.pid, 'SIGKILL');
`
    );
    return script;
  }
}
describe('durable benchmark records', () => {
  it.skipIf(process.platform === 'win32')(
    'retains a synced completed sample and interrupted start after uncatchable cancellation',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'benchmark-abrupt-test-'));
      scratch.push(root);
      const script = await new FakeAbruptJournalProcess(root).create();
      const result = await runNativeCommand({
        label: 'abrupt-journal',
        command: [process.execPath, script],
        root,
        out: root,
        env: { ...process.env },
        timeoutSeconds: 10,
        pollIntervalMs: 20,
        stream: new DiscardedJournalOutput(),
      });
      expect(result.timedOut).toBe(false);
      expect(result.signal).toBe('SIGKILL');
      expect(result.settlement.empty).toBe(true);
      const events = (await readFile(join(root, 'events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events).toEqual([
        { kind: 'finished', phase: 'measured', index: 1, status: 'success' },
        { kind: 'started', phase: 'measured', index: 2 },
      ]);
      expect(JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8'))).toMatchObject({
        complete: false,
        attempts: [{ index: 1, status: 'success' }],
      });
    }
  );

  it('appends complete independently parseable events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-journal-test-'));
    scratch.push(root);
    const path = join(root, 'journal/events.jsonl');
    await appendBenchmarkJournal(path, { kind: 'started', index: 1 });
    await appendBenchmarkJournal(path, { kind: 'finished', index: 1, status: 'success' });
    expect(
      (await readFile(path, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([
      { kind: 'started', index: 1 },
      { kind: 'finished', index: 1, status: 'success' },
    ]);
  });
  it('replaces a previous checkpoint with complete JSON and permits disabled persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-progress-test-'));
    scratch.push(root);
    const path = join(root, 'receipt.json');
    await writeBenchmarkProgress(path, { complete: false, attempts: [] });
    await writeBenchmarkProgress(path, { complete: false, attempts: [1] });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ complete: false, attempts: [1] });
    expect(await Bun.file(`${path}.partial`).exists()).toBe(false);
    await appendBenchmarkJournal(undefined, {});
    await writeBenchmarkProgress(undefined, {});
  });
});
