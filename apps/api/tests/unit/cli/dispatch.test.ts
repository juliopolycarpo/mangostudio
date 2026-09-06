import { describe, expect, spyOn, test } from 'bun:test';
import { dispatch } from '../../../src/cli/dispatch';
import { embeddedInstaller } from '../../../src/modules/updates/infrastructure/embedded-installers';

describe('dispatch', () => {
  test('turns a CliError into a clean stderr message and exit(1), not a thrown error', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await expect(dispatch(['serve', '--bogus'])).resolves.toBeUndefined();

      expect(stderrSpy).toHaveBeenCalledWith('Unknown option for serve: --bogus\n');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

describe('dispatch service', () => {
  test('routes `service` to the command rather than the unknown-command path', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await dispatch(['service']);
      expect(stderrSpy).toHaveBeenCalledWith(
        'Missing service action. Expected one of: install, uninstall, status, start, stop, restart\n'
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

describe('dispatch __installer', () => {
  test('writes the embedded sh installer verbatim to stdout, no newline added, no log prefix', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await dispatch(['__installer', 'sh']);
      expect(stdoutSpy).toHaveBeenCalledWith(embeddedInstaller('sh'));
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  test('writes the embedded ps1 installer verbatim to stdout', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await dispatch(['__installer', 'ps1']);
      expect(stdoutSpy).toHaveBeenCalledWith(embeddedInstaller('ps1'));
    } finally {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  test('names the two accepted kinds when given anything else', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await dispatch(['__installer', 'bogus']);
      expect(stderrSpy).toHaveBeenCalledWith(
        'Unknown installer kind: bogus. Expected one of: sh, ps1\n'
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  test('names the two accepted kinds when given none', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await dispatch(['__installer']);
      expect(stderrSpy).toHaveBeenCalledWith('Missing installer kind. Expected one of: sh, ps1\n');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

describe('dispatch env install/update', () => {
  test('routes `env install` through the new subcommand rather than "Unknown env subcommand"', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      // No recipe id: this throws inside `parseEnvArgs` before `runEnvInstall`
      // is even called, so it exercises the routing without needing to fake
      // the install service — proof this is the new branch, not the old
      // "Unknown env subcommand" one `env install` used to fall into.
      await dispatch(['env', 'install']);
      expect(stderrSpy).toHaveBeenCalledWith(
        'Missing recipe id for env install. Usage: env install <recipe> [--environment <id>] [--version <spec>]\n'
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  test('routes `env update` through the new subcommand the same way', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await dispatch(['env', 'update']);
      expect(stderrSpy).toHaveBeenCalledWith(
        'Missing recipe id for env update. Usage: env update <recipe> [--environment <id>] [--version <spec>]\n'
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

describe('dispatch upgrade/update', () => {
  test('routes `upgrade` to the new command rather than "Unknown command"', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      // An unknown option throws inside parseUpgradeArgs before runUpgrade is
      // even called — proof this is the new branch, not the old
      // "Unknown command: upgrade" default one.
      await dispatch(['upgrade', '--bogus']);
      expect(stderrSpy).toHaveBeenCalledWith('Unknown option for upgrade: --bogus\n');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  test('routes the `update` alias the same way', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await dispatch(['update', '--bogus']);
      expect(stderrSpy).toHaveBeenCalledWith('Unknown option for upgrade: --bogus\n');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
