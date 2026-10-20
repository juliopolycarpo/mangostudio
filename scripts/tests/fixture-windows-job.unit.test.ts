import { expect, test } from 'bun:test';
import { FixtureJobCoverage } from './support/fixture-windows-job';

class BirthDuringTermination {
  total = 2;
  capture(): void {
    this.total++;
  }
}

test('a birth between member capture and termination permanently blocks storage release', () => {
  const kernel = new BirthDuringTermination();
  const coverage = new FixtureJobCoverage();
  coverage.capture(kernel.total);
  kernel.capture();
  expect(() => coverage.verify(kernel.total)).toThrow('expected 2, received 3; storage retained');
  expect(() => coverage.capture(kernel.total)).toThrow('expected 2, received 3; storage retained');
  expect(() => coverage.verify(2)).toThrow('expected 2, received 3; storage retained');
});

test('a complete unchanged census remains valid across repeated termination requests', () => {
  const coverage = new FixtureJobCoverage();
  coverage.capture(2);
  coverage.list(2, 2, 24, 4096);
  coverage.verify(2);
  coverage.capture(2);
  coverage.verify(2);
});

test.each([
  [2, 1, 16, 4096],
  [2, 2, 16, 4096],
  [2, 2, 8192, 4096],
])(
  'incomplete member census %i/%i rows and %i/%i bytes blocks storage release',
  (assigned, listed, bytes, capacity) => {
    const coverage = new FixtureJobCoverage();
    coverage.capture(2);
    expect(() => coverage.list(assigned, listed, bytes, capacity)).toThrow(
      'fixture job census incomplete'
    );
    expect(() => coverage.verify(2)).toThrow('fixture job census incomplete');
  }
);
