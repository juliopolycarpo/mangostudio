import { describe, expect, it } from 'bun:test';
import {
  parseArtifactSections,
  parseBuildCpu,
  qualifiesRustIncremental,
  qualifiesTextAttribution,
  rustCostWorkloads,
  shippingRustProfile,
  summarizeRustCosts,
} from '../lib/rust-cost-receipt';

describe('Rust cost receipt contracts', () => {
  it('rejects a restamp without changed artifact identity and keeps no-op invariants distinct', () => {
    const before = 'a'.repeat(64),
      after = 'b'.repeat(64);
    expect(qualifiesRustIncremental('restamp', before, after, 1)).toBe(true);
    expect(qualifiesRustIncremental('restamp', before, before, 1)).toBe(false);
    expect(qualifiesRustIncremental('restamp', before, after, 0)).toBe(false);
    expect(qualifiesRustIncremental('noop', before, before, 0)).toBe(true);
    expect(qualifiesRustIncremental('noop', before, after, 0)).toBe(false);
    expect(qualifiesRustIncremental('noop', before, before, 1)).toBe(false);
    expect(qualifiesRustIncremental('noop', undefined, after, 0)).toBe(false);
    expect(() => qualifiesRustIncremental('noop', 'invalid', after, 0)).toThrow(
      'expected lowercase SHA-256'
    );
  });

  it('requires and pins the repository shipping profile without changing its tradeoffs', () => {
    const manifest =
      '[profile.release]\nopt-level=3\nlto="fat"\ncodegen-units=1\nstrip=true\npanic="unwind"';
    expect(shippingRustProfile(manifest)).toEqual([
      '--config',
      'profile.release.opt-level=3',
      '--config',
      'profile.release.lto="fat"',
      '--config',
      'profile.release.codegen-units=1',
      '--config',
      'profile.release.strip=true',
      '--config',
      'profile.release.panic="unwind"',
    ]);
    expect(() => shippingRustProfile(manifest.replace('lto="fat"', 'lto="thin"'))).toThrow(
      'expected "fat"'
    );
    expect(() => shippingRustProfile('')).toThrow('expected 3');
  });

  it('keeps final CPU, elapsed and individual-process RSS in their original units', () => {
    expect(parseBuildCpu('1.20 0.30 2048 1.50\n')).toEqual({
      userSeconds: 1.2,
      systemSeconds: 0.3,
      maxIndividualRssKb: 2048,
      elapsedSeconds: 1.5,
    });
    for (const value of [
      '',
      '-1 0 0 1',
      '1 0 null 1',
      '1 0 2048 1\n1 0 2048 1',
      '1 0 99999999999999999999 1',
    ])
      expect(() => parseBuildCpu(value)).toThrow('GNU time: expected');
  });
  it('requires named text and rejects duplicate or unsafe section sizes', () => {
    expect(
      parseArtifactSections(
        'file :\nsection size addr\n.text 4096 100\n.debug_info 20 0\nTotal 4116\n'
      )
    ).toEqual([
      { name: '.text', bytes: 4096, address: '100' },
      { name: '.debug_info', bytes: 20, address: '0' },
    ]);
    expect(() => parseArtifactSections('.data 4 0')).toThrow('expected .text');
    expect(() => parseArtifactSections('.text 4 0\n.rodata invalid 10')).toThrow(
      'expected name decimal-bytes decimal-address'
    );
    expect(() => parseArtifactSections('.text 4 0\n.text 5 0')).toThrow('expected unique');
    expect(() => parseArtifactSections('.text 99999999999999999999 0')).toThrow('safe byte count');
  });
  it('requires exact validated text identity before symbol attribution', () => {
    expect(qualifiesTextAttribution('a'.repeat(64), 'a'.repeat(64))).toBe(true);
    expect(qualifiesTextAttribution('a'.repeat(64), 'b'.repeat(64))).toBe(false);
    expect(() => qualifiesTextAttribution('', 'a'.repeat(64))).toThrow('SHA-256');
  });
  it('freezes six empty, ten no-op and ten restamp workloads with separate labels', () => {
    const work = rustCostWorkloads('0.1.1');
    expect(work).toHaveLength(26);
    expect(work.filter((row) => row.emptyTarget)).toHaveLength(6);
    expect(work.filter((row) => row.label.startsWith('runtime-noop'))).toHaveLength(10);
    expect(work.filter((row) => row.label.startsWith('runtime-restamp'))).toHaveLength(10);
    expect(work.slice(6, 10).map((row) => row.stamp)).toEqual([
      '0.1.1',
      '0.1.1-bench.1',
      '0.1.1-bench.1',
      '0.1.1-bench.2',
    ]);
    expect(work.slice(6).every((row) => row.target === 'runtime-3' && !row.emptyTarget)).toBe(true);
    expect(() => rustCostWorkloads('bad')).toThrow('expected x.y.z');
  });
  it('summarizes only valid attempts without calculating a baseline/candidate delta', () => {
    const summary = summarizeRustCosts([
      { label: 'runtime-noop-1', valid: true, durationMs: 10 },
      { label: 'runtime-noop-2', valid: false, durationMs: 1000 },
      { label: 'runtime-restamp-1', valid: true, durationMs: 20 },
    ]);
    expect(summary['runtime-noop'].median).toBe(10);
    expect(summary['runtime-restamp'].median).toBe(20);
    expect(Object.keys(summary)).toEqual(['runtime-noop', 'runtime-restamp']);
    expect(() => summarizeRustCosts([{ label: 'x', valid: true, durationMs: NaN }])).toThrow(
      'expected finite'
    );
  });
});
