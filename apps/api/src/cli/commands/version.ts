import { getVersion } from '../../lib/config';
import { writeLine } from '../output';

interface VersionDeps {
  readonly getVersion?: () => string;
  readonly log?: (message: string) => void;
}

/** Print the embedded MangoStudio version. // Usage: runVersion() */
export function runVersion(deps: VersionDeps = {}): void {
  const resolveVersion = deps.getVersion ?? getVersion;
  const log = deps.log ?? writeLine;
  log(resolveVersion());
}
