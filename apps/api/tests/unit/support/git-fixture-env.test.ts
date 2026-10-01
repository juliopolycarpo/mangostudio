import { afterEach, describe, expect, test } from 'bun:test';
import { gitFixtureEnv } from '../../support/git-fixture-env';

const KEY = 'GIT_CONFIG_GLOBAL';
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe('gitFixtureEnv', () => {
  test('forwards the lane global git config so the developer config is never read', () => {
    process.env[KEY] = '/tmp/mangostudio-test-home-abc/.gitconfig';

    expect(
      gitFixtureEnv()[KEY],
      `expected ${KEY}: /tmp/mangostudio-test-home-abc/.gitconfig | received: ${gitFixtureEnv()[KEY]}`
    ).toBe('/tmp/mangostudio-test-home-abc/.gitconfig');
  });

  test('leaves the variable unset when the lane did not set it', () => {
    delete process.env[KEY];

    expect(gitFixtureEnv()[KEY]).toBeUndefined();
  });

  test('keeps the binary lookup, the lane home and a prompt-free, locale-stable git', () => {
    const env = gitFixtureEnv();

    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.LC_ALL).toBe('C');
  });
});
