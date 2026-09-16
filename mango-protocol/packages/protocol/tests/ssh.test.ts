import { describe, expect, it } from 'bun:test';
import corpus from '../../../spec/fixtures/1/ssh-argv.json';
import { classifySshExit, type SshArgvOptions, sshArgv } from '../src/transports/ssh';

interface ArgvCase {
  readonly name: string;
  readonly verdict: 'accept' | 'reject';
  readonly options: Record<string, unknown>;
  readonly argv?: readonly string[];
  readonly reason?: string;
}

/** The refusal message each `reason` must open with, as the Rust enum spells it. */
const REASON_PREFIX: Record<string, string> = {
  host: 'ssh host is',
  user: 'ssh user is',
  port: 'ssh port is',
  connectTimeoutSeconds: 'ssh connectTimeoutSeconds is',
  command: 'ssh command is',
};

/** The options every case in the preset carries, in the order spawn.md spells them. */
const PRESET = [
  'ssh',
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=3',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
  '-o',
  'RemoteCommand=none',
];

describe('the shared argv corpus', () => {
  // The Rust suite reads this same file, so these cases passing on both sides
  // is what proves the two SDKs hand the operating system one command line.
  const cases = corpus.cases as readonly ArgvCase[];

  it('holds both accept and reject cases', () => {
    expect(cases.filter((item) => item.verdict === 'accept').length).toBeGreaterThan(0);
    expect(cases.filter((item) => item.verdict === 'reject').length).toBeGreaterThan(0);
  });

  for (const item of cases) {
    it(`${item.name} is ${item.verdict}ed exactly as the corpus says`, () => {
      const options = item.options as unknown as SshArgvOptions;
      if (item.verdict === 'accept') {
        expect(sshArgv(options)).toEqual([...(item.argv ?? [])]);
        return;
      }
      const prefix = REASON_PREFIX[item.reason ?? ''];
      expect(prefix).toBeDefined();
      expect(() => sshArgv(options)).toThrow(prefix as string);
    });
  }
});

describe('sshArgv', () => {
  it('produces the preset, the destination and the quoted remote command', () => {
    expect(sshArgv({ host: 'build-box', command: ['mango-runtime'] })).toEqual([
      ...PRESET,
      '-T',
      '--',
      'build-box',
      "'mango-runtime'",
    ]);
  });

  it('adds the user to the destination and quotes every remote argument', () => {
    expect(
      sshArgv({
        host: 'build-box',
        user: 'deploy',
        command: ['/opt/mango/runtime', '--stdio', '--name', "it's mine"],
      })
    ).toEqual([
      ...PRESET,
      '-T',
      '--',
      'deploy@build-box',
      "'/opt/mango/runtime'",
      "'--stdio'",
      "'--name'",
      "'it'\\''s mine'",
    ]);
  });

  it('forces an ambient RemoteCommand off so the command after the destination runs', () => {
    const argv = sshArgv({ host: 'build-box', command: ['mango-runtime'] });
    const options = argv.flatMap((word, index) => (word === '-o' ? [`-o ${argv[index + 1]}`] : []));
    expect(options).toContain('-o RemoteCommand=none');
  });

  it('leaves a leading ~/ outside the quotes so the remote shell expands it', () => {
    expect(sshArgv({ host: 'build-box', command: ['~/bin/mango-runtime'] }).at(-1)).toBe(
      "~/'bin/mango-runtime'"
    );
  });

  it('adds the identity file with IdentitiesOnly, before the port', () => {
    expect(
      sshArgv({
        host: 'build-box',
        port: 2222,
        identityFile: '/home/u/.ssh/id_ed25519',
        command: ['mango-runtime'],
      })
    ).toEqual([
      ...PRESET,
      '-o',
      'IdentitiesOnly=yes',
      '-i',
      '/home/u/.ssh/id_ed25519',
      '-p',
      '2222',
      '-T',
      '--',
      'build-box',
      "'mango-runtime'",
    ]);
  });

  it('carries a chosen connect timeout', () => {
    expect(sshArgv({ host: 'build-box', command: ['x'], connectTimeoutSeconds: 20 })).toContain(
      'ConnectTimeout=20'
    );
  });

  it('refuses a host that could become an option', () => {
    expect(() => sshArgv({ host: '-oProxyCommand=touch /tmp/x', command: ['x'] })).toThrow(
      'ssh host is "-oProxyCommand=touch /tmp/x"; expected a non-empty host name without whitespace and not beginning with "-"'
    );
  });

  it('refuses a host with whitespace and an empty host', () => {
    expect(() => sshArgv({ host: 'build box', command: ['x'] })).toThrow('ssh host is "build box"');
    expect(() => sshArgv({ host: '', command: ['x'] })).toThrow('ssh host is ""');
  });

  it('refuses a user that could become an option', () => {
    expect(() => sshArgv({ host: 'build-box', user: '-oX=1', command: ['x'] })).toThrow(
      'ssh user is "-oX=1"; expected a non-empty user name without whitespace and not beginning with "-"'
    );
  });

  it('refuses a port outside 1-65535', () => {
    expect(() => sshArgv({ host: 'h', port: 0, command: ['x'] })).toThrow(
      'ssh port is 0; expected an integer between 1 and 65535'
    );
    expect(() => sshArgv({ host: 'h', port: 65536, command: ['x'] })).toThrow('ssh port is 65536');
    expect(() => sshArgv({ host: 'h', port: 22.5, command: ['x'] })).toThrow('ssh port is 22.5');
  });

  it('refuses an empty command', () => {
    expect(() => sshArgv({ host: 'h', command: [] })).toThrow(
      'ssh command is []; expected [remotePath, ...remoteArgs] with a non-empty remote path'
    );
    expect(() => sshArgv({ host: 'h', command: [''] })).toThrow('ssh command is [""]');
  });

  it('refuses a connect timeout that is not a whole number of seconds', () => {
    expect(() => sshArgv({ host: 'h', command: ['x'], connectTimeoutSeconds: 0 })).toThrow(
      'ssh connectTimeoutSeconds is 0; expected an integer of at least 1 second'
    );
  });
});

describe('classifySshExit', () => {
  it('names 255 as ssh own failure and quotes the last stderr line', () => {
    expect(
      classifySshExit(
        { code: 255, signal: null },
        'ssh: Warning\nssh: connect to host build-box port 22: Connection timed out\n\n'
      )
    ).toBe(
      'ssh exited 255, its own failure (connection, authentication or host key), not a status from the remote command: ssh: connect to host build-box port 22: Connection timed out.'
    );
  });

  it('names 255 without a tail to quote', () => {
    expect(classifySshExit({ code: 255, signal: null }, '   \n')).toBe(
      'ssh exited 255, its own failure (connection, authentication or host key), not a status from the remote command.'
    );
  });

  it('names 127 as a remote command nobody could find', () => {
    expect(classifySshExit({ code: 127, signal: null }, 'bash: mango: command not found')).toBe(
      'ssh exited 127: the remote login shell could not find the command; check the remote path and the PATH of a non-interactive shell.'
    );
  });

  it('names the signal that killed ssh', () => {
    expect(classifySshExit({ code: null, signal: 'SIGKILL' }, '')).toBe(
      'ssh was killed by SIGKILL before the remote command reported a status.'
    );
  });

  it('reports a status it could not observe', () => {
    expect(classifySshExit({ code: null, signal: null }, '')).toBe(
      'ssh ended without an exit status, so the launcher could not observe how the remote command finished.'
    );
  });

  it('passes any other code through as the remote command status', () => {
    expect(classifySshExit({ code: 3, signal: null }, 'ignored')).toBe(
      'ssh exited 3, which is the status the remote command returned.'
    );
  });
});
