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
