import { runCapture } from './support';

/** Literal tracked paths: NUL output avoids Git quoting and preserves whitespace. */
export const listTrackedFiles = async (run: typeof runCapture = runCapture): Promise<string[]> => {
  const { stdout, exitCode, stderr } = await run(['git', 'ls-files', '-z']);
  if (exitCode !== 0) throw new Error(`git ls-files failed: ${stderr.trim()}`);
  if (stdout === '') return [];
  if (!stdout.endsWith('\0')) throw new Error('git ls-files -z returned an incomplete path record');
  return stdout.slice(0, -1).split('\0');
};
