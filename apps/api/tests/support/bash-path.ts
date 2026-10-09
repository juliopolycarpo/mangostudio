import { shellQuote } from '@mangostudio/shared/environments';
import { asGitPath } from './git-path';

/**
 * A host path written so a `bash -c` command line names the same file.
 *
 * Bash reads an unquoted backslash as an escape, so `> C:\Users\me\out.txt`
 * writes `C:Usersmeout.txt` into the working directory, and the command still
 * exits 0. Git Bash (the shell the runtime starts on Windows) accepts a drive
 * path with forward slashes, so the path is respelled that way and then quoted
 * for anything else it contains. POSIX hosts get the path quoted as it is.
 *
 * @example
 * `printf 'x' > ${bashPath(join(tempDir, 'out.txt'))}`;
 */
export function bashPath(path: string): string {
  return shellQuote(asGitPath(path));
}
