import { describe, expect, it } from 'bun:test';
import { AGENT_CLI_DEFINITIONS } from '@mangostudio/shared/environments/detection';
import {
  getInstallRecipe,
  hasInstallRecipeForRuntime,
  INSTALL_RECIPES,
} from '../../../../src/modules/environments/domain/install-recipes';

/**
 * The ids each detection service will answer for. A probe target outside these
 * lists resolves to `null` and publishes nothing, so the recipe would look
 * declared and still leave its surface stale.
 */
const RUNTIME_IDS = ['bun', 'node'];
const VERSION_MANAGER_IDS = ['nvm'];
const AGENT_TARGET_IDS = AGENT_CLI_DEFINITIONS.map((definition) => definition.targetId);

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

  it('declares at least one probe target per recipe', () => {
    // A recipe whose completion re-probes nothing leaves the surface it changed
    // showing pre-install state until the next lazy read. The type makes the
    // field mandatory; this asserts nobody satisfies it with an empty array.
    for (const recipe of INSTALL_RECIPES) {
      expect(recipe.probe.length).toBeGreaterThan(0);
    }
  });

  it('names a probe target that the detection services can actually answer', () => {
    for (const recipe of INSTALL_RECIPES) {
      for (const target of recipe.probe) {
        if (target.kind === 'runtime') expect(RUNTIME_IDS).toContain(target.runtimeId);
        else if (target.kind === 'version-manager') {
          expect(VERSION_MANAGER_IDS).toContain(target.versionManagerId);
        } else expect(AGENT_TARGET_IDS).toContain(target.targetId);
      }
    }
  });

  it('marks runtime and agent targets installable when a platform recipe exists', () => {
    expect(hasInstallRecipeForRuntime('bun', 'linux')).toBe(true);
    expect(hasInstallRecipeForRuntime('claude', 'darwin')).toBe(true);
    expect(hasInstallRecipeForRuntime('mangostudio', 'linux')).toBe(false);
    expect(hasInstallRecipeForRuntime('bun', 'win32')).toBe(false);
  });
});
