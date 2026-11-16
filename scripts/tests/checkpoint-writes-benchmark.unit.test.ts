import { afterEach, describe, expect, it } from 'bun:test';

import {
  countSqliteWrites,
  decodeScenarioPrompt,
  encodeScenarioPrompt,
  type FakeProvider,
  fillerText,
  formatSummaryRow,
  parseProcIo,
  pickGlobalIpv6,
  providerFrames,
  SCENARIOS,
  startFakeProvider,
  summarizeScenario,
} from '../bench/checkpoint-writes';

const DATABASE = '/home/bench/hub/database.sqlite';

/** Builds `strace -f -ttt -y -xx -s 8` lines the way strace prints them: paths and data as \xNN. */
class FakeStraceLog {
  private readonly lines: string[] = [];

  private static hex(text: string): string {
    return [...text]
      .map((char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
      .join('');
  }

  private static hexBytes(bytes: readonly number[]): string {
    return bytes.map((byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join('');
  }

  write(
    at: number,
    path: string,
    bytes: number,
    firstBytes: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0]
  ) {
    this.lines.push(
      `4242 ${at.toFixed(6)} pwrite64(6<${FakeStraceLog.hex(path)}>, "${FakeStraceLog.hexBytes(firstBytes)}"..., ${bytes}, 0) = ${bytes}`
    );
    return this;
  }

  /** A WAL frame header (24 bytes) whose database-size field is `commitPages`. */
  walFrameHeader(at: number, commitPages: number) {
    return this.write(at, `${DATABASE}-wal`, 24, [0, 0, 0, 1, 0, 0, 0, commitPages]);
  }

  fsync(at: number, path: string, call: 'fsync' | 'fdatasync' = 'fsync') {
    this.lines.push(`4242 ${at.toFixed(6)} ${call}(6<${FakeStraceLog.hex(path)}>) = 0`);
    return this;
  }

  text(): string {
    return this.lines.join('\n');
  }
}

describe('countSqliteWrites', () => {
  const everything = { startSeconds: 0, endSeconds: 1e12 };

  it('sums main and WAL bytes, counts only frames with a database size as commits, and counts fsyncs per file', () => {
    const log = new FakeStraceLog()
      .walFrameHeader(10, 0)
      .write(10.1, `${DATABASE}-wal`, 4096)
      .walFrameHeader(10.2, 7)
      .write(10.3, `${DATABASE}-wal`, 4096)
      .fsync(10.4, `${DATABASE}-wal`)
      .fsync(10.5, `${DATABASE}-wal`, 'fdatasync')
      .write(10.6, DATABASE, 4096)
      .fsync(10.7, DATABASE)
      .text();

    expect(countSqliteWrites(log, DATABASE, everything)).toEqual({
      walBytes: 24 + 4096 + 24 + 4096,
      mainBytes: 4096,
      commits: 1,
      walFsyncs: 2,
      mainFsyncs: 1,
    });
  });

  it('ignores other files and syscalls that started outside the window', () => {
    const log = new FakeStraceLog()
      .write(5, `${DATABASE}-wal`, 4096)
      .write(10.5, '/home/bench/hub/uploads/other.bin', 9999)
      .write(10.5, `${DATABASE}-shm`, 1)
      .walFrameHeader(10.6, 3)
      .write(20, `${DATABASE}-wal`, 4096)
      .text();

    expect(countSqliteWrites(log, DATABASE, { startSeconds: 10, endSeconds: 11 })).toEqual({
      walBytes: 24,
      mainBytes: 0,
      commits: 1,
      walFsyncs: 0,
      mainFsyncs: 0,
    });
  });

  it('reads the pid-prefixed and bracketed line shapes strace uses with and without -f -o', () => {
    const hex = [...`${DATABASE}-wal`]
      .map((char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
      .join('');
    const log = [
      `[pid  99] 10.000000 pwrite64(6<${hex}>, "\\x00"..., 4096, 0) = 4096`,
      `10.100000 pwrite64(6<${hex}>, "\\x00"..., 4096, 4096) = 4096`,
    ].join('\n');

    expect(countSqliteWrites(log, DATABASE, everything).walBytes).toBe(8192);
  });
});

describe('providerFrames', () => {
  const answerScenario = {
    name: 'answer-10-chars',
    answerChars: 10,
    chunkDelayMs: 7,
    toolCalls: 0,
    toolResultChars: 0,
    turns: 1,
  };

  async function collect(
    messages: ReadonlyArray<{ role: string; content?: unknown }>
  ): Promise<{ frames: string[]; pauses: number[] }> {
    const pauses: number[] = [];
    const frames: string[] = [];
    const pause = (ms: number): Promise<void> => {
      pauses.push(ms);
      return Promise.resolve();
    };
    for await (const frame of providerFrames({ model: 'm', messages }, pause)) {
      frames.push(frame);
    }
    return { frames, pauses };
  }

  const contentDeltas = (frames: readonly string[]): string[] =>
    frames
      .filter((frame) => frame.startsWith('data: {'))
      .map((frame) => JSON.parse(frame.slice(6)).choices[0]?.delta?.content)
      .filter((content): content is string => typeof content === 'string' && content.length > 0);

  it('streams the answer in 4-character chunks and pauses after each one', async () => {
    const { frames, pauses } = await collect([
      { role: 'user', content: encodeScenarioPrompt(answerScenario) },
    ]);

    expect(contentDeltas(frames)).toEqual(['alph', 'a br', 'av']);
    expect(pauses).toEqual([7, 7, 7]);
    expect(frames.at(-1)).toBe('data: [DONE]\n\n');
  });

  it('asks for a read_file call until every requested tool result is back, then answers', async () => {
    const prompt = encodeScenarioPrompt({ ...answerScenario, toolCalls: 2, chunkDelayMs: 0 });

    const first = await collect([{ role: 'user', content: prompt }]);
    const second = await collect([
      { role: 'user', content: prompt },
      { role: 'assistant' },
      { role: 'tool' },
    ]);
    const answer = await collect([
      { role: 'user', content: prompt },
      { role: 'tool' },
      { role: 'tool' },
    ]);

    expect(first.frames.join('')).toContain('"name":"read_file"');
    expect(second.frames.join('')).toContain('"name":"read_file"');
    expect(answer.frames.join('')).not.toContain('read_file');
    expect(contentDeltas(answer.frames).join('')).toBe(fillerText(10));
  });
});

describe('scenario prompt and filler text', () => {
  it('round-trips the fields the provider needs', () => {
    for (const scenario of SCENARIOS) {
      expect(decodeScenarioPrompt(encodeScenarioPrompt(scenario))).toEqual({
        answerChars: scenario.answerChars,
        chunkDelayMs: scenario.chunkDelayMs,
        toolCalls: scenario.toolCalls,
      });
    }
    expect(decodeScenarioPrompt('hello')).toBeNull();
  });

  it('builds filler text of exactly the requested length', () => {
    expect(fillerText(0)).toBe('');
    expect(fillerText(7)).toBe('alpha b');
    expect(fillerText(65_536)).toHaveLength(65_536);
  });
});

describe('startFakeProvider', () => {
  let provider: FakeProvider | undefined;

  afterEach(() => provider?.stop());

  it('rejects a wrong key and streams a full answer to the right one', async () => {
    provider = startFakeProvider('127.0.0.1');
    const denied = await fetch(`${provider.baseUrl}/models`, {
      headers: { Authorization: 'Bearer nope' },
    });
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'm',
        stream: true,
        messages: [
          {
            role: 'user',
            content: encodeScenarioPrompt({
              name: 't',
              answerChars: 40,
              chunkDelayMs: 0,
              toolCalls: 0,
              toolResultChars: 0,
              turns: 1,
            }),
          },
        ],
      }),
    });
    const body = await response.text();
    const answer = body
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: {'))
      .map((frame) => JSON.parse(frame.slice(6)).choices[0]?.delta?.content ?? '')
      .join('');

    expect(denied.status).toBe(401);
    expect(answer).toBe(fillerText(40));
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});

describe('host readings', () => {
  it('picks a global IPv6 address and skips unique-local ones', () => {
    const output = [
      '2: eth0    inet6 fd14:9c25:574::200/128 scope global dynamic',
      '2: eth0    inet6 2804:14d:5c65:8ddc::200/128 scope global dynamic',
      '2: eth0    inet6 fd14:9c25:574:0:2e0:1eff:fe40:924/64 scope global dynamic',
    ].join('\n');

    expect(pickGlobalIpv6(output)).toBe('2804:14d:5c65:8ddc::200');
    expect(pickGlobalIpv6('2: eth0    inet6 fd14::1/64 scope global')).toBeUndefined();
  });

  it('reads wchar and write_bytes from /proc/<pid>/io and names a malformed file', () => {
    expect(parseProcIo('rchar: 1\nwchar: 2048\nsyscr: 3\nwrite_bytes: 8192\n')).toEqual({
      wcharBytes: 2048,
      writeBytes: 8192,
    });
    expect(() => parseProcIo('rchar: 1\n')).toThrow('expected wchar and write_bytes lines');
  });
});

describe('summarizeScenario', () => {
  const MIB = 1024 * 1024;
  const turn = (wallMs: number, writeMiB: number) => ({
    wallMs,
    cpuMs: 100,
    wcharBytes: writeMiB * MIB,
    writeBytes: writeMiB * MIB,
    peakRssKb: 100 * 1024,
  });

  it('pools turns over runs, divides traced counts by turns, and formats one row', () => {
    const counts = { walBytes: 4 * MIB, mainBytes: 0, commits: 20, walFsyncs: 22, mainFsyncs: 0 };
    const summary = summarizeScenario([
      { scenario: 'tools', turns: [turn(10, 1), turn(30, 3)], counts },
      { scenario: 'tools', turns: [turn(20, 2), turn(40, 4)], counts },
    ]);

    expect(summary.runs).toBe(2);
    expect(summary.turnsPerRun).toBe(2);
    expect(summary.perTurn.wallMs).toMatchObject({ n: 4, min: 10, median: 25, max: 40 });
    expect(summary.counts?.sqliteMiB.median).toBe(2);
    expect(summary.counts?.commits.median).toBe(10);
    expect(formatSummaryRow(summary)).toBe(
      'tools | 2x2 | 25 (10-40) | 100 (100-100) | 2.50 (1.00-4.00) | 2.50 (1.00-4.00) | 100 (100-100) | 2.00 (2.00-2.00) | 10 (10-10) | 11 (11-11)'
    );
  });
});
