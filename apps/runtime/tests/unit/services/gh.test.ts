import { describe, expect, it } from 'bun:test';
import { GITHUB_PR_REVIEW_THREADS_QUERY } from '@mangostudio/shared/github';
import { RuntimeToolArgumentError } from '../../../src/errors';
import {
  buildGhArgv,
  buildGhEnvironment,
  execGh,
  GhExecutionError,
  mutateGh,
  summarizeGhSubcommand,
} from '../../../src/services/gh';

const hasGh = Bun.which('gh') !== null;
const isWindows = process.platform === 'win32';
const cwd = process.cwd();

/**
 * A cwd no spawn can enter, so an argv the validator *accepted* fails at
 * `posix_spawn` instead of reaching GitHub. That failure is the assertion: a
 * `GhExecutionError` means validation passed and execution began, which is what
 * an allowlist test wants to prove without a network round trip per case.
 */
const UNSPAWNABLE_CWD = '/mangostudio-gh-allowlist-probe-does-not-exist';

const READ_SUBCOMMANDS: readonly (readonly string[])[] = [
  ['--version'],
  ['auth', 'status'],
  ['repo', 'view', '--json', 'nameWithOwner'],
  ['pr', 'view', '--json', 'number'],
  ['pr', 'list'],
  ['pr', 'status'],
  ['pr', 'checks'],
  ['issue', 'list'],
  ['search', 'prs', '--review-requested=@me'],
];

const WRITE_SUBCOMMANDS: readonly (readonly string[])[] = [
  ['pr', 'create', '--fill'],
  ['pr', 'ready'],
  ['pr', 'checkout', '42'],
];

const PINNED_GRAPHQL_ARGS: readonly string[] = [
  'api',
  'graphql',
  '-F',
  'owner=mango',
  '-F',
  'name=mangostudio',
  '-F',
  'number=42',
  '-f',
  `query=${GITHUB_PR_REVIEW_THREADS_QUERY}`,
];

/** The rejection an `execGh`/`mutateGh` call produced, whatever kind it was. */
async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  return await run().catch((error: unknown) => error);
}

/** Asserts the validator let an argv through, without letting it reach GitHub. */
async function expectAccepted(
  run: (params: { args: readonly string[]; cwd: string }) => Promise<unknown>,
  args: readonly string[]
): Promise<void> {
  const error = await refusal(() => run({ args, cwd: UNSPAWNABLE_CWD }));
  expect(error).toBeInstanceOf(GhExecutionError);
}

describe('gh CLI boundary', () => {
  it('assembles a direct argv without shell interpolation', () => {
    expect(buildGhArgv(['pr', 'view', '--json', 'number'])).toEqual([
      'gh',
      'pr',
      'view',
      '--json',
      'number',
    ]);
  });

  it('forwards only gh runtime variables and never a token', () => {
    const env = buildGhEnvironment({
      PATH: '/bin',
      HOME: '/home/test',
      APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
      XDG_CONFIG_HOME: '/config',
      GH_CONFIG_DIR: '/config/gh',
      GH_HOST: 'github.example',
      HTTPS_PROXY: 'https://proxy.example',
      SSL_CERT_FILE: '/certs/ca.pem',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      LC_ALL: 'pt_BR.UTF-8',
      GH_TOKEN: 'never-forward',
      GITHUB_TOKEN: 'never-forward',
      GH_ENTERPRISE_TOKEN: 'never-forward',
      PROVIDER_API_KEY: 'never-forward',
    });

    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/test',
      APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
      XDG_CONFIG_HOME: '/config',
      GH_CONFIG_DIR: '/config/gh',
      GH_HOST: 'github.example',
      HTTPS_PROXY: 'https://proxy.example',
      SSL_CERT_FILE: '/certs/ca.pem',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      NO_COLOR: '1',
      LC_ALL: 'C',
    });
  });

  /**
   * The regression: on a native Windows runtime without an explicit
   * `GH_CONFIG_DIR`, `gh` falls back to `$AppData/GitHub CLI` — dropping
   * `APPDATA` from the allowlist made that config unreachable, so a real
   * `gh auth login` looked like no login had happened at all.
   */
  it("preserves APPDATA for gh's default Windows config location", () => {
    const env = buildGhEnvironment({ APPDATA: 'C:\\Users\\test\\AppData\\Roaming' });
    expect(env.APPDATA).toBe('C:\\Users\\test\\AppData\\Roaming');
  });

  it('summarizes an argv down to its subcommand, never its prose', () => {
    expect(
      summarizeGhSubcommand(['pr', 'create', '--title', 'Secret plan', '--body', 'x'])
    ).toEqual(['pr', 'create']);
    expect(summarizeGhSubcommand(['--version'])).toEqual(['--version']);
    expect(summarizeGhSubcommand([42, 'pr'])).toEqual(['pr']);
  });
});

describe('gh subcommand allowlists', () => {
  it.skipIf(isWindows)('accepts every read-only subcommand on gh.exec', async () => {
    for (const args of READ_SUBCOMMANDS) {
      await expectAccepted(execGh, args);
    }
  });

  it('refuses every write subcommand on gh.exec', async () => {
    for (const args of WRITE_SUBCOMMANDS) {
      const error = await refusal(() => execGh({ args, cwd }));
      expect(error).toBeInstanceOf(RuntimeToolArgumentError);
    }
  });

  it('refuses every read-only subcommand on gh.mutate', async () => {
    for (const args of READ_SUBCOMMANDS) {
      const error = await refusal(() => mutateGh({ args, cwd }));
      expect(error).toBeInstanceOf(RuntimeToolArgumentError);
    }
  });

  it.skipIf(isWindows)('accepts every write subcommand on gh.mutate', async () => {
    for (const args of WRITE_SUBCOMMANDS) {
      await expectAccepted(mutateGh, args);
    }
  });

  it('refuses a subcommand on neither list', async () => {
    for (const args of [['repo', 'delete'], ['release', 'create'], ['workflow', 'run'], ['auth']]) {
      expect(await refusal(() => execGh({ args, cwd }))).toBeInstanceOf(RuntimeToolArgumentError);
      expect(await refusal(() => mutateGh({ args, cwd }))).toBeInstanceOf(RuntimeToolArgumentError);
    }
  });

  it('refuses --version carrying extra tokens', async () => {
    const error = await refusal(() => execGh({ args: ['--version', 'repo', 'delete'], cwd }));
    expect(error).toBeInstanceOf(RuntimeToolArgumentError);
  });

  it('names the refusing method so a gh.mutate error does not say gh.exec', async () => {
    const error = await refusal(() => mutateGh({ args: ['pr', 'list'], cwd }));
    expect((error as Error).message).toContain('gh.mutate');
    expect((error as Error).message).not.toContain('gh.exec');
  });
});

describe('gh credential and side-effect flags', () => {
  /**
   * The subcommand allowlists key on the first one or two tokens; everything
   * after that is gh's to interpret. `gh auth status --show-token` prints the
   * stored token on stdout, and stdout is exactly what the hub reads back — so
   * without this guard one flag hands the hub the credential the whole design
   * is built on never possessing.
   */
  it('refuses a flag that would print the stored token, in both spellings', async () => {
    for (const args of [
      ['auth', 'status', '--show-token'],
      ['auth', 'status', '--show-token=true'],
      ['auth', 'status', '-t'],
    ]) {
      expect(await refusal(() => execGh({ args, cwd }))).toBeInstanceOf(RuntimeToolArgumentError);
    }
  });

  it('refuses a flag that opens a browser on the runtime host', async () => {
    for (const args of [
      ['repo', 'view', '--web'],
      ['repo', 'view', '-w'],
      ['pr', 'view', '123', '--web=true'],
    ]) {
      expect(await refusal(() => execGh({ args, cwd }))).toBeInstanceOf(RuntimeToolArgumentError);
    }
  });

  /**
   * `-w` is `--web` on every gh subcommand that defines it, not only on the two
   * view commands — `gh pr checks` spells its watch mode `--watch` with no
   * short alias, and `pr list`, `issue list`, `search prs` and `pr create` all
   * take `-w, --web`. Scoping the letter to `repo view` / `pr view` left four
   * allowlisted reads and one write able to open a browser on the runtime host.
   */
  it('refuses the browser short flag on every subcommand that defines it', async () => {
    for (const args of [
      ['pr', 'list', '-w'],
      ['pr', 'checks', '123', '-w'],
      ['issue', 'list', '-w'],
      ['search', 'prs', '-w'],
    ]) {
      expect(await refusal(() => execGh({ args, cwd }))).toBeInstanceOf(RuntimeToolArgumentError);
    }
    expect(await refusal(() => mutateGh({ args: ['pr', 'create', '-w'], cwd }))).toBeInstanceOf(
      RuntimeToolArgumentError
    );
  });

  /**
   * gh's flag parser (pflag) clusters single-letter boolean flags together
   * and accepts `=` on a short flag too, so `-at` means `-a -t` and `-t=true`
   * is `-t` with an explicit value. Both spellings have to be refused, not
   * just the bare `-t` token.
   */
  it('refuses a clustered or valued short flag that would print the stored token', async () => {
    for (const args of [
      ['auth', 'status', '-at'],
      ['auth', 'status', '-ta'],
      ['auth', 'status', '-t=true'],
    ]) {
      expect(await refusal(() => execGh({ args, cwd }))).toBeInstanceOf(RuntimeToolArgumentError);
    }
  });

  /**
   * gh reuses short letters across subcommands: `-t` is `--show-token` on
   * `auth status` but `--title` on `pr create`. That overload is why `-t` is
   * scoped rather than refused globally the way `-w` is — refusing the letter
   * everywhere would forbid opening a pull request.
   */
  it.skipIf(isWindows)(
    'still accepts the same letters where they mean something else',
    async () => {
      await expectAccepted(mutateGh, ['pr', 'create', '-t', 'A title', '--body=Some body']);
    }
  );

  /**
   * Refusing `-w` on every subcommand puts every argument in the scan's path,
   * operands included. A pull request body sent as its own argv element can
   * open on a markdown bullet, and `- what changed` is not a flag cluster: it
   * starts with a dash and contains a `w`, which was enough to refuse it while
   * the scan matched on any dash-prefixed token.
   */
  it.skipIf(isWindows)('reads free text as an operand rather than a flag cluster', async () => {
    await expectAccepted(mutateGh, [
      'pr',
      'create',
      '--title=Add the panel',
      '--body',
      '- what changed\n- why',
    ]);
  });
});

describe('gh api graphql pinning', () => {
  it.skipIf(isWindows)('accepts the pinned review-thread document', async () => {
    await expectAccepted(execGh, PINNED_GRAPHQL_ARGS);
  });

  it('refuses api without graphql', async () => {
    for (const args of [['api', 'repos/mango/mangostudio'], ['api', 'user'], ['api']]) {
      expect(await refusal(() => execGh({ args, cwd }))).toBeInstanceOf(RuntimeToolArgumentError);
    }
  });

  it('refuses method, input, paginate and jq flags in both spellings', async () => {
    const flags = [
      ['-X', 'DELETE'],
      ['--method', 'DELETE'],
      ['--method=DELETE'],
      ['-X=DELETE'],
      ['--input', '/etc/passwd'],
      ['--input=/etc/passwd'],
      ['--paginate'],
      ['--paginate=true'],
      ['-q', '.data'],
      ['--jq', '.data'],
      ['--jq=.data'],
      ['-q=.data'],
    ];
    for (const flag of flags) {
      const args = [...PINNED_GRAPHQL_ARGS, ...flag];
      expect(await refusal(() => execGh({ args, cwd }))).toBeInstanceOf(RuntimeToolArgumentError);
    }
  });

  it('refuses a field value that would read a file off the target machine', async () => {
    for (const field of ['-F', '-f', '--field', '--raw-field']) {
      const args = ['api', 'graphql', field, 'body=@/etc/passwd', ...PINNED_GRAPHQL_ARGS.slice(2)];
      expect(await refusal(() => execGh({ args, cwd }))).toBeInstanceOf(RuntimeToolArgumentError);
    }
  });

  it('refuses a document that is not pinned', async () => {
    const args = ['api', 'graphql', '-f', 'query=query { viewer { login } }'];
    expect(await refusal(() => execGh({ args, cwd }))).toBeInstanceOf(RuntimeToolArgumentError);
  });

  it('refuses a pinned document smuggled in on the typed -F flag', async () => {
    const args = ['api', 'graphql', '-F', `query=${GITHUB_PR_REVIEW_THREADS_QUERY}`];
    expect(await refusal(() => execGh({ args, cwd }))).toBeInstanceOf(RuntimeToolArgumentError);
  });

  it('refuses api graphql with no document at all', async () => {
    for (const args of [
      ['api', 'graphql'],
      ['api', 'graphql', '-F', 'owner=mango'],
    ]) {
      expect(await refusal(() => execGh({ args, cwd }))).toBeInstanceOf(RuntimeToolArgumentError);
    }
  });

  it('refuses a field token that is not key=value', async () => {
    const args = ['api', 'graphql', '-f', 'query'];
    expect(await refusal(() => execGh({ args, cwd }))).toBeInstanceOf(RuntimeToolArgumentError);
  });
});

describe('gh parameter validation', () => {
  it('rejects non-array args', async () => {
    await expect(execGh({ args: 'pr view' as unknown as string[], cwd })).rejects.toBeInstanceOf(
      RuntimeToolArgumentError
    );
  });

  it('rejects args containing NUL bytes', async () => {
    await expect(execGh({ args: ['pr', 'view\0'], cwd })).rejects.toBeInstanceOf(
      RuntimeToolArgumentError
    );
  });

  it('rejects an empty cwd', async () => {
    await expect(execGh({ args: ['pr', 'view'], cwd: '' })).rejects.toBeInstanceOf(
      RuntimeToolArgumentError
    );
  });

  it('rejects timeouts that would fire the kill timer immediately', async () => {
    for (const timeoutMs of [0, -1, Number.NaN, '5000' as unknown as number]) {
      await expect(execGh({ args: ['pr', 'view'], cwd, timeoutMs })).rejects.toBeInstanceOf(
        RuntimeToolArgumentError
      );
    }
  });

  it('rejects accepted exit codes that are not an integer array', async () => {
    for (const acceptedExitCodes of [1 as unknown as number[], [1.5], ['1' as unknown as number]]) {
      await expect(execGh({ args: ['pr', 'view'], cwd, acceptedExitCodes })).rejects.toBeInstanceOf(
        RuntimeToolArgumentError
      );
    }
  });

  it('rejects a smuggled command string', async () => {
    await expect(
      execGh({
        args: ['pr', 'view'],
        cwd,
        command: 'gh repo delete mango/mangostudio --yes',
      } as never)
    ).rejects.toBeInstanceOf(RuntimeToolArgumentError);
  });
});

describe('gh execution', () => {
  it.skipIf(!hasGh)('reports the installed version through gh.exec', async () => {
    const result = await execGh({ args: ['--version'], cwd, timeoutMs: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('gh version');
  });

  it.skipIf(!hasGh)('maps a non-zero exit to a structured GhExecutionError', async () => {
    // A directory that is not a repository: `gh pr list` needs one.
    const error = await refusal(() =>
      execGh({ args: ['pr', 'list'], cwd: '/', timeoutMs: 10_000 })
    );
    expect(error).toBeInstanceOf(GhExecutionError);
    expect((error as GhExecutionError).data.args).toEqual(['pr', 'list']);
  });

  it.skipIf(!hasGh)('surfaces an aborted call as an aborted execution error', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await refusal(() =>
      execGh({ args: ['--version'], cwd, timeoutMs: 10_000 }, controller.signal)
    );
    expect(error).toBeInstanceOf(GhExecutionError);
    expect((error as GhExecutionError).data.aborted).toBe(true);
  });
});
