import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { RustCostConfigFiles } from '../../lib/rust-cost-inputs';

/** Read raw configuration bytes only inside one fixture's lexical and physical directory.
 * @example const files = new OwnedCargoConfigFiles(fixtureDirectory);
 */
export class OwnedCargoConfigFiles implements RustCostConfigFiles {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  /** Read raw bytes of an owned config while presenting every outside path as an absent slot.
   * @example const bytes = await files.read(join(fixtureDirectory, '.cargo/config.toml'));
   */
  async read(path: string): Promise<Uint8Array> {
    const requested = resolve(path);
    if (!this.owns(this.directory, requested)) throw this.outside(path);
    const [directory, actual] = await Promise.all([realpath(this.directory), realpath(requested)]);
    if (!this.owns(directory, actual)) throw this.outside(path);
    return readFile(actual);
  }

  private owns(directory: string, path: string): boolean {
    const child = relative(directory, path);
    return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
  }

  private outside(path: string): NodeJS.ErrnoException {
    return Object.assign(
      new Error(
        `Owned Cargo config fixture: expected path inside ${this.directory} | received: ${path}`
      ),
      { code: 'ENOENT' }
    );
  }
}
