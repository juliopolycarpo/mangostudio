import { describe, expect, it } from 'bun:test';
import origins from '../../../spec/fixtures/1/origins.json';
import { isOriginAllowed } from '../src/transports/websocket';

interface OriginCase {
  readonly name: string;
  readonly verdict: 'accept' | 'reject';
  readonly origin?: string;
  readonly allowed: readonly string[];
}

const cases = origins.cases as readonly OriginCase[];

describe('origin corpus', () => {
  it('reads every case of spec/fixtures/1/origins.json', () => {
    expect(cases.length).toBeGreaterThan(10);
  });

  for (const item of cases) {
    it(`judges ${item.name}`, () => {
      expect(isOriginAllowed(item.origin, item.allowed)).toBe(item.verdict === 'accept');
    });
  }
});

describe('origin comparison', () => {
  const allowed = ['https://app.example'];

  it('refuses the shapes a prefix, suffix or substring check would admit', () => {
    // Each of these passes one of the three comparisons a reviewer reaches
    // for first, and every one of them is an origin the acceptor must refuse.
    expect('https://app.example.attacker.test'.startsWith(allowed[0] as string)).toBe(true);
    expect(isOriginAllowed('https://app.example.attacker.test', allowed)).toBe(false);
    expect('https://notapp.example'.endsWith('app.example')).toBe(true);
    expect(isOriginAllowed('https://notapp.example', allowed)).toBe(false);
  });
});
