import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { assertHermeticHome } from '../../support/setup/hermetic-home';

describe('assertHermeticHome', () => {
  test('passes when the home is not the launcher original', () => {
    expect(() =>
      assertHermeticHome(
        { MANGOSTUDIO_REAL_HOME: '/home/dev' },
        '/tmp/mangostudio-test-home-a1b2c3'
      )
    ).not.toThrow();
  });

  test('passes without the launcher variable, as a bare bun test has nothing to compare', () => {
    expect(() => assertHermeticHome({}, '/home/dev')).not.toThrow();
  });

  test('passes when the variable is blank', () => {
    expect(() => assertHermeticHome({ MANGOSTUDIO_REAL_HOME: '  ' }, '/home/dev')).not.toThrow();
  });

  test('aborts when homedir() is the launcher original, naming the value and the expected shape', () => {
    expect(() => assertHermeticHome({ MANGOSTUDIO_REAL_HOME: '/home/dev' }, '/home/dev')).toThrow(
      'expected homedir(): a temporary directory like <tmpdir>/mangostudio-test-home-<random> | received: "/home/dev"'
    );
  });

  test('this lane process runs with a home that is not the launcher original', () => {
    const original = process.env.MANGOSTUDIO_REAL_HOME;
    if (!original) return;

    expect(
      homedir(),
      `expected homedir() != MANGOSTUDIO_REAL_HOME | received: ${homedir()} (the real home)`
    ).not.toBe(original);
  });
});
