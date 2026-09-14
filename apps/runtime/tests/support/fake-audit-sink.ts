/**
 * An audit sink that keeps its records in memory.
 *
 * The on-disk sink has its own suite; every other test that cares about
 * auditing cares about *what* was recorded, not about how a line is written.
 *
 * @example
 * const audit = new FakeAuditSink();
 * expect(audit.records.map((record) => record.outcome)).toEqual(['ok']);
 */

import type { RuntimeAuditSink } from '../../src/audit-log';

export type FakeAuditRecord = Parameters<RuntimeAuditSink['record']>[0];

export class FakeAuditSink implements RuntimeAuditSink {
  readonly enabled = true;
  readonly path = '<memory>';
  readonly records: FakeAuditRecord[] = [];
  hub: { readonly host: string; readonly user: string } | null = null;

  lastError(): string | null {
    return null;
  }
  setHub(hub: { readonly host: string; readonly user: string } | null): void {
    this.hub = hub ?? null;
  }
  record(input: FakeAuditRecord): void {
    this.records.push(input);
  }
  async flush(): Promise<void> {
    // Nothing is buffered; the records are already in memory.
  }
  async close(): Promise<void> {
    // Nothing to release.
  }
}
