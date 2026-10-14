import { describe, expect, it } from 'bun:test';

import { laneById } from '../../lib/test-lanes';
import { receiptText, shardReceipts } from '../../tests/support/shard-receipt-fixtures';
import { fakeFiles, junitXml, passingCases, receiptJson } from '../testing/junit-fixture';
import { parseReceipt, readJobEvidence } from './evidence';

describe('parseReceipt', () => {
  it('reads the exit code the watchdog wrote', () => {
    expect(parseReceipt(receiptJson(3, 0))).toMatchObject({
      kind: 'read',
      shard: 3,
      exitCode: 0,
      durationSeconds: 40,
      attempts: null,
    });
    expect(parseReceipt(receiptJson(3, 124))).toMatchObject({ kind: 'read', exitCode: 124 });
  });

  it('reads the attempt count the watchdog recorded', () => {
    expect(parseReceipt('{"shard":3,"exitCode":0,"durationSeconds":9,"attempts":2}')).toMatchObject(
      {
        kind: 'read',
        exitCode: 0,
        attempts: 2,
      }
    );
  });

  it.each(['0', '-1', '1.5', '"2"', 'null'])('rejects an attempts value of %s', (attempts) => {
    const receipt = parseReceipt(`{"shard":3,"exitCode":0,"attempts":${attempts}}`);

    expect(receipt.kind).toBe('missing');
  });

  it('treats an absent file as a missing receipt', () => {
    expect(parseReceipt(null)).toEqual({ kind: 'missing', why: 'no shard-meta.json' });
  });

  it.each([
    ['not JSON', '{"exit'],
    ['an array', '[]'],
    ['no exitCode', '{"shard":1}'],
    ['a string exitCode', '{"exitCode":"0"}'],
    ['a null exitCode', '{"exitCode":null}'],
  ])('never reads %s as a clean run', (_label, text) => {
    const receipt = parseReceipt(text);

    expect(receipt.kind, `receipt ${text} should not be readable`).toBe('missing');
  });
});

describe('readJobEvidence', () => {
  const lane = laneById('shared');
  const job = { id: 'shard 1', dir: 'shards/test-shard-1', lanes: [lane] };

  it('reads the lane report and the receipt from the job directory', async () => {
    const fs = fakeFiles({
      [`shards/test-shard-1/${lane.junitPath}`]: junitXml(passingCases(2)),
      'shards/test-shard-1/shard-meta.json': receiptJson(1, 0),
    });

    const evidence = await readJobEvidence(job, fs.readText);

    expect(evidence.receipt).toMatchObject({ kind: 'read', exitCode: 0 });
    const report = evidence.reports.get(lane.id);
    expect(report?.kind === 'read' && report.parsed.tests).toBe(2);
  });

  it('records a missing report and a missing receipt as such', async () => {
    const evidence = await readJobEvidence(job, fakeFiles({}).readText);

    expect(evidence.reports.get(lane.id)).toEqual({ kind: 'missing' });
    expect(evidence.receipt.kind).toBe('missing');
  });

  it('makes a report with another producer identity incomplete', async () => {
    const evidence = await readJobEvidence(
      job,
      fakeFiles({
        [`${job.dir}/${lane.junitPath}`]: junitXml(passingCases(2)),
        [`${job.dir}/shard-meta.json`]: receiptJson(2, 0),
      }).readText
    );
    expect(evidence.receipt).toMatchObject({ kind: 'missing' });
  });

  it('retains findings from a failed attempt after a later pass', async () => {
    const evidence = await readJobEvidence(
      job,
      fakeFiles({
        [`${job.dir}/shard-meta.json`]: receiptText(shardReceipts.retainedFindings),
      }).readText
    );
    expect(evidence.receipt).toMatchObject({ kind: 'read', exitCode: 1, attempts: 2 });
  });

  it('uses a supplied receipt instead of reading one', async () => {
    const fs = fakeFiles({});

    const evidence = await readJobEvidence(job, fs.readText, { kind: 'read', exitCode: 1 });

    expect(evidence.receipt).toEqual({ kind: 'read', exitCode: 1 });
    expect(fs.reads.some((path) => path.endsWith('shard-meta.json'))).toBe(false);
  });
});
