/** A patch read a row that another writer replaced before it could commit. */
export class AppSettingsConflict extends Error {
  constructor() {
    super('Settings changed while saving. Reload current settings and reapply your edit.');
    this.name = 'AppSettingsConflict';
  }
}
