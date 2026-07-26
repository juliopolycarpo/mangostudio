import { describe, expect, it } from 'bun:test';
import {
  getInstallRecipe,
  hasInstallRecipeForRuntime,
  INSTALL_RECIPES,
} from '../../../../src/modules/environments/domain/install-recipes';

describe('install recipes', () => {
  it('keeps ids unique and every command on the supported POSIX platforms', () => {
    expect(new Set(INSTALL_RECIPES.map((recipe) => recipe.id)).size).toBe(INSTALL_RECIPES.length);
    for (const recipe of INSTALL_RECIPES) {
      expect(recipe.platforms).toEqual(['darwin', 'linux']);
      expect(recipe.timeoutMs).toBeGreaterThan(0);
      expect(recipe.writes.length).toBeGreaterThan(0);
    }
  });

  it('builds downloaded installers from a prepared local file only', () => {
    const recipe = getInstallRecipe('bun.install.official');

    expect(() => recipe.argv({ kind: 'none' }, {})).toThrow(
      'Downloaded installer path is required.'
    );
    expect(recipe.argv({ kind: 'none' }, { installerPath: '/tmp/installer.sh' })).toEqual([
      'bash',
      '/tmp/installer.sh',
    ]);
    expect(recipe.download?.url).toBe('https://bun.com/install');
  });

  it('passes validated nvm input as a quoted positional argument, not shell source', () => {
    const install = getInstallRecipe('nvm.node.install');
    const setDefault = getInstallRecipe('nvm.node.set-default');

    const installArgv = install.argv(
      { kind: 'node-version', version: '22.13.0' },
      { nvmDir: '/home/tester/.nvm' }
    );
    const defaultArgv = setDefault.argv(
      { kind: 'node-version', version: 'lts' },
      { nvmDir: '/home/tester/.nvm' }
    );

    expect(installArgv).toEqual([
      'bash',
      '-c',
      '. "$NVM_DIR/nvm.sh" && nvm install "$1"',
      'mangostudio-install',
      '22.13.0',
    ]);
    expect(installArgv[2]).not.toContain('22.13.0');
    expect(defaultArgv.at(-1)).toBe('lts/*');
  });

  it('marks runtime and agent targets installable when a platform recipe exists', () => {
    expect(hasInstallRecipeForRuntime('bun', 'linux')).toBe(true);
    expect(hasInstallRecipeForRuntime('claude', 'darwin')).toBe(true);
    expect(hasInstallRecipeForRuntime('mangostudio', 'linux')).toBe(false);
    expect(hasInstallRecipeForRuntime('bun', 'win32')).toBe(false);
  });
});
