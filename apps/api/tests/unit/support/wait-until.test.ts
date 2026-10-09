import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitUntil } from '../../support/wait-until';

class FakeCondition {
  checks = 0;

  constructor(private readonly readyAfterChecks: number) {}

  matches = (): boolean => {
    this.checks += 1;
    return this.checks >= this.readyAfterChecks;
  };

  describe = (): string => `observed ${this.checks} readiness checks`;
}

class FakePidPublisher {
  constructor(private readonly path: string) {}

  async publish(): Promise<void> {
    writeFileSync(this.path, '');
    await Bun.sleep(40);
    writeFileSync(this.path, '123');
    await Bun.sleep(40);
    writeFileSync(this.path, '12345\n');
  }
}

describe('waitUntil', () => {
  it('resolves an immediately satisfied condition without a timeout budget', async () => {
    const condition = new FakeCondition(1);

    await waitUntil(condition.matches, 'immediate readiness', 0);

    expect(condition.checks).toBe(1);
  });

  it('polls until a delayed condition holds', async () => {
    const condition = new FakeCondition(3);

    await waitUntil(condition.matches, 'delayed readiness', 200);

    expect(condition.checks).toBe(3);
  });

  it('fails an unsatisfied condition with the expectation and timeout', async () => {
    const condition = new FakeCondition(Infinity);

    await expect(waitUntil(condition.matches, 'the child PID marker', 10)).rejects.toThrow(
      'expected the child PID marker | received: nothing within 10ms'
    );
    expect(condition.checks).toBeGreaterThan(1);
  });

  it('includes the last observation when readiness times out', async () => {
    const condition = new FakeCondition(Infinity);

    await expect(
      waitUntil(condition.matches, 'the child PID marker', 0, condition.describe)
    ).rejects.toThrow(
      'expected the child PID marker | received: nothing within 0ms; observed 1 readiness checks'
    );
  });

  it('ignores empty and partial PID files until publication is complete', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wait-until-pid-'));
    const pidFile = join(directory, 'pid.txt');
    const publisher = new FakePidPublisher(pidFile);
    const published = publisher.publish();
    try {
      await waitUntil(
        () => existsSync(pidFile) && /^[1-9]\d*\n$/.test(readFileSync(pidFile, 'utf8')),
        'the complete positive PID marker',
        200
      );
      expect(readFileSync(pidFile, 'utf8')).toBe('12345\n');
    } finally {
      await published;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
