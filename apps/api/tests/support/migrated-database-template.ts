import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMigrations } from '../../src/server/migrations';
import { DATABASE_FILE_NAME, ObservedFileDatabase } from './observed-file-database';

/**
 * A fully migrated database file, built once, that tests copy instead of migrating a
 * fresh file each time.
 *
 * Migrations commit at synchronous = FULL, one fsync per statement. That is a third of
 * a second on Linux and seconds on a Windows runner, where a `beforeEach` that migrated
 * timed out at 32.9 s against a 15 s limit. Build the template in `beforeAll` and call
 * {@link copyInto} from `beforeEach`.
 */
export class MigratedDatabaseTemplate {
  private constructor(private readonly directory: string) {}

  /** Migrates a scratch database to the latest schema and closes it, so the file is complete. */
  static async create(prefix: string): Promise<MigratedDatabaseTemplate> {
    const directory = mkdtempSync(join(tmpdir(), `${prefix}-template-`));
    const template = new MigratedDatabaseTemplate(directory);
    const source = new ObservedFileDatabase(directory);
    try {
      await runMigrations(source.db);
    } catch (error) {
      template.dispose();
      throw error;
    } finally {
      // Closing the last connection checkpoints the WAL into the main file that gets copied.
      await source.destroy();
    }
    template.assertCheckpointed();
    return template;
  }

  /** Puts a copy of the migrated database at `<directory>/database.sqlite`. */
  copyInto(directory: string): void {
    copyFileSync(this.databasePath, join(directory, DATABASE_FILE_NAME));
  }

  dispose(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }

  private get databasePath(): string {
    return join(this.directory, DATABASE_FILE_NAME);
  }

  /**
   * A copy takes only the main file. If the WAL still held pages, the copy would silently
   * lack them, so name the file and its size instead of letting a test fail on a missing table.
   */
  private assertCheckpointed(): void {
    const walPath = `${this.databasePath}-wal`;
    const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
    if (walBytes > 0) {
      throw new Error(
        `expected the migrated template to be checkpointed into ${this.databasePath} | received: ${walPath} holding ${walBytes} bytes`
      );
    }
  }
}
