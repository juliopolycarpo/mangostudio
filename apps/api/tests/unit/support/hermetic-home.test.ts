import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { assertHermeticHome } from '../../support/setup/hermetic-home';

const TEST_HOME = join('/tmp', 'mangostudio-test-home-a1b2c3');

describe('assertHermeticHome under the launcher', () => {
  test('passes when the home is not the launcher original', () => {
    expect(() =>
      assertHermeticHome({ MANGOSTUDIO_REAL_HOME: '/home/dev' }, TEST_HOME)
    ).not.toThrow();
  });

  test('passes when the variable is blank and the home is a test home', () => {
    expect(() => assertHermeticHome({ MANGOSTUDIO_REAL_HOME: '  ' }, TEST_HOME)).not.toThrow();
  });

  test('aborts when homedir() is the launcher original, naming the value and the expected shape', () => {
    expect(() => assertHermeticHome({ MANGOSTUDIO_REAL_HOME: '/home/dev' }, '/home/dev')).toThrow(
      'expected homedir(): a temporary directory like <tmpdir>/mangostudio-test-home-<random> | received: "/home/dev"'
    );
  });

  test('passes when MANGO_HOME points into the scratch home', () => {
    expect(() =>
      assertHermeticHome(
        { MANGOSTUDIO_REAL_HOME: '/home/dev', MANGO_HOME: join(TEST_HOME, '.mango') },
        TEST_HOME
      )
    ).not.toThrow();
  });

  test('aborts when an exported MANGO_HOME names the real ~/.mango', () => {
    expect(() =>
      assertHermeticHome(
        { MANGOSTUDIO_REAL_HOME: '/home/dev', MANGO_HOME: join('/home/dev', '.mango') },
        TEST_HOME
      )
    ).toThrow(
      `expected MANGO_HOME: unset or outside the real home | received: ${JSON.stringify(join('/home/dev', '.mango'))}`
    );
  });
});

describe('assertHermeticHome without the launcher', () => {
  test('aborts a bare run on a real-looking home, naming the home and the launcher', () => {
    expect(() => assertHermeticHome({}, '/home/dev')).toThrow(
      'expected homedir(): a temporary directory like <tmpdir>/mangostudio-test-home-<random> | received: "/home/dev"'
    );
    expect(() => assertHermeticHome({}, '/home/dev')).toThrow('scripts/with-test-home.ts');
  });

  test('aborts a bare run that exports MANGO_HOME, as the home is real either way', () => {
    expect(() => assertHermeticHome({ MANGO_HOME: '/home/dev/.mango' }, '/home/dev')).toThrow(
      'received: "/home/dev"'
    );
  });

  test('passes a bare run whose HOME already is a test home', () => {
    expect(() => assertHermeticHome({}, TEST_HOME)).not.toThrow();
  });

  test('passes when the caller vouches for a disposable home', () => {
    expect(() =>
      assertHermeticHome({ MANGOSTUDIO_TEST_ALLOW_REAL_HOME: '1' }, '/home/ci')
    ).not.toThrow();
  });

  test('does not read any other value as the opt-out', () => {
    expect(() =>
      assertHermeticHome({ MANGOSTUDIO_TEST_ALLOW_REAL_HOME: 'true' }, '/home/dev')
    ).toThrow('received: "/home/dev"');
  });
});

describe('this lane process', () => {
  test('resolves the home it runs under to a scratch directory, not the real user home', () => {
    const realHome = process.env.MANGOSTUDIO_REAL_HOME?.trim();
    const allowed = process.env.MANGOSTUDIO_TEST_ALLOW_REAL_HOME === '1';
    if (allowed) return;

    expect(
      realHome,
      'expected MANGOSTUDIO_REAL_HOME: set by scripts/with-test-home.ts | received: unset (a bare bun test; the preload should have aborted)'
    ).toBeTruthy();
    expect(
      homedir(),
      `expected homedir() != MANGOSTUDIO_REAL_HOME | received: ${homedir()} (the real home)`
    ).not.toBe(realHome);
  });
});
