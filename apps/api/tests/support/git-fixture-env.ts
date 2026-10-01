/**
 * The environment a test passes to the `git` it runs to build a fixture
 * repository: just enough to find the binary and the lane's temporary home, and
 * never the developer's own Git configuration.
 *
 * The lane launcher (`scripts/with-test-home.ts`) names an empty global config
 * in `GIT_CONFIG_GLOBAL`. A fixture that builds its environment from scratch
 * has to forward it, or Git falls back to whatever `$HOME/.gitconfig` and
 * `$XDG_CONFIG_HOME/git/config` hold on that machine — signing policy, identity
 * and hooks path included — and the same test passes or fails by who runs it.
 *
 * @example
 * Bun.spawn(['git', 'init'], { cwd, env: gitFixtureEnv() });
 */
export function gitFixtureEnv(): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}
