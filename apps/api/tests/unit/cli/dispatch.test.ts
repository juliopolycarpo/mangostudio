import { describe, expect, spyOn, test } from 'bun:test';
import { dispatch } from '../../../src/cli/dispatch';

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
