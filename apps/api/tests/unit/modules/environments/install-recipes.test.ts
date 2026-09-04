import { describe, expect, it } from 'bun:test';
import type { InstallPlatform } from '@mangostudio/shared/environments';
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
const RUNTIME_IDS = ['bun', 'node', 'fnm', 'winget', 'git'];
const VERSION_MANAGER_IDS = ['nvm', 'fnm'];
const AGENT_TARGET_IDS = AGENT_CLI_DEFINITIONS.map((definition) => definition.targetId);

/** winget's HRESULT for "no applicable update found" (0x8A15002B), signed. */
const WINGET_NO_APPLICABLE_UPGRADE = -1978335189;

function invokesWinget(recipe: (typeof INSTALL_RECIPES)[number]): boolean {
  if (!recipe.argv) return false;
  try {
    const argv = recipe.argv(
      recipe.inputKind === 'none' ? { kind: 'none' } : { kind: 'node-version', version: 'lts' },
      { platform: 'win32', binaryPaths: { winget: 'winget' } }
    );
    return argv[0] === 'winget';
  } catch {
    // Not every recipe can build against a bare `winget` context (a
    // downloaded script needs an `installerPath`); those never invoke winget.
    return false;
  }
}

describe('install recipes', () => {
  it('keeps ids unique, and every recipe carries a timeout and writes', () => {
    expect(new Set(INSTALL_RECIPES.map((recipe) => recipe.id)).size).toBe(INSTALL_RECIPES.length);
    for (const recipe of INSTALL_RECIPES) {
      expect(recipe.timeoutMs).toBeGreaterThan(0);
      expect(recipe.writes.length).toBeGreaterThan(0);
      expect(recipe.platforms.length).toBeGreaterThan(0);
    }
  });

  it('either runs unattended or names why it cannot', () => {
    for (const recipe of INSTALL_RECIPES) {
      if (recipe.argv) {
        expect(recipe.unrunnableReason).toBeUndefined();
      } else {
        expect(recipe.unrunnableReason).toBe('vendor-undocumented');
      }
    }
  });

  it('marks every win32 recipe that invokes winget with the "already current" exit code', () => {
    for (const recipe of INSTALL_RECIPES) {
      if (!recipe.platforms.includes('win32') || !invokesWinget(recipe)) continue;
      expect(recipe.acceptedExitCodes).toContain(WINGET_NO_APPLICABLE_UPGRADE);
    }
  });

  it('never declares a download for a platform the recipe does not support', () => {
    for (const recipe of INSTALL_RECIPES) {
      if (!recipe.download) continue;
      for (const platform of Object.keys(recipe.download) as InstallPlatform[]) {
        expect(recipe.platforms).toContain(platform);
      }
    }
  });

  it('only pairs a powershell interpreter with the win32 entry', () => {
    for (const recipe of INSTALL_RECIPES) {
      if (!recipe.download) continue;
      for (const [platform, download] of Object.entries(recipe.download)) {
        if (platform === 'win32') expect(download?.interpreter).toBe('powershell');
        else expect(download?.interpreter).not.toBe('powershell');
      }
    }
  });

  it('builds downloaded installers from a prepared local file only', () => {
    const recipe = getInstallRecipe('bun.install.official');
    const posixContext = { platform: 'linux' as const, binaryPaths: {} };

    expect(() => recipe.argv?.({ kind: 'none' }, posixContext)).toThrow(
      'Downloaded installer path is required.'
    );
    expect(
      recipe.argv?.({ kind: 'none' }, { ...posixContext, installerPath: '/tmp/installer.sh' })
    ).toEqual(['bash', '/tmp/installer.sh']);
    expect(recipe.download?.linux?.url).toBe('https://bun.com/install');
  });

  it('runs a win32 downloaded installer through a locked-down powershell -File', () => {
    const recipe = getInstallRecipe('claude.install');

    expect(
      recipe.argv?.(
        { kind: 'none' },
        { platform: 'win32', binaryPaths: {}, installerPath: 'C:\\temp\\installer.ps1' }
      )
    ).toEqual([
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\temp\\installer.ps1',
    ]);
  });

  it('passes validated nvm input as a quoted positional argument, not shell source', () => {
    const install = getInstallRecipe('nvm.node.install');
    const setDefault = getInstallRecipe('nvm.node.set-default');
    const context = { platform: 'linux' as const, binaryPaths: {}, nvmDir: '/home/tester/.nvm' };

    const installArgv = install.argv?.({ kind: 'node-version', version: '22.13.0' }, context);
    const defaultArgv = setDefault.argv?.({ kind: 'node-version', version: 'lts' }, context);

    expect(installArgv).toEqual([
      'bash',
      '-c',
      '. "$NVM_DIR/nvm.sh" && nvm install "$1"',
      'mangostudio-install',
      '22.13.0',
    ]);
    expect(installArgv?.[2]).not.toContain('22.13.0');
    expect(defaultArgv?.at(-1)).toBe('lts/*');
  });

  it("reads nvm.install's pinned digest from its downloaded installer", () => {
    const recipe = getInstallRecipe('nvm.install');
    expect(recipe.download?.linux?.sha256).toBe(
      '066ce4eaf4d78eaa6410433bc9ba58faaba646157cbbed6109153e6c24c5f8a5'
    );
    expect(recipe.download?.linux?.url).toBe(
      'https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh'
    );
  });

  it('calls fnm by its resolved absolute path, never `fnm use`', () => {
    const install = getInstallRecipe('fnm.node.install');
    const setDefault = getInstallRecipe('fnm.node.set-default');
    const context = { platform: 'win32' as const, binaryPaths: { fnm: 'C:\\fnm\\fnm.exe' } };

    const installArgv = install.argv?.({ kind: 'node-version', version: 'lts' }, context);
    const defaultArgv = setDefault.argv?.({ kind: 'node-version', version: 'lts' }, context);

    expect(installArgv).toEqual(['C:\\fnm\\fnm.exe', 'install', '--lts']);
    expect(defaultArgv).toEqual(['C:\\fnm\\fnm.exe', 'default', 'lts-latest']);
    for (const recipe of [install, setDefault]) {
      const argv = recipe.argv?.({ kind: 'node-version', version: 'lts' }, context) ?? [];
      expect(argv).not.toContain('use');
    }
    expect(setDefault.copyCommand({ kind: 'node-version', version: 'lts' }, 'win32')).toBe(
      'fnm default lts-latest'
    );
  });

  it('declares at least one probe target per recipe', () => {
    // A recipe whose completion re-probes nothing leaves the surface it changed
    // showing pre-install state until the next lazy read. The non-empty tuple
    // type already rejects `[]`, so this stands guard on the type being
    // loosened rather than on any value the catalog can hold today.
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

  /**
   * The frontend's chain resolution satisfies a missing requirement with the
   * first catalog entry that installs it unattended. That `find` is only
   * unambiguous while at most one recipe per runtime qualifies on a platform: a
   * second one would make which prerequisite runs depend on array order, with
   * nothing failing loudly. Asserted here because the catalog is where the
   * ambiguity would be introduced.
   */
  it('offers at most one unattended install per runtime on a platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const runtimeIds = INSTALL_RECIPES.filter(
        (recipe) =>
          recipe.action === 'install' &&
          recipe.inputKind === 'none' &&
          recipe.platforms.includes(platform)
      ).map((recipe) => recipe.runtimeId);
      expect(new Set(runtimeIds).size).toBe(runtimeIds.length);
    }
  });

  it('marks runtime and agent targets installable when a platform recipe exists', () => {
    expect(hasInstallRecipeForRuntime('bun', 'linux')).toBe(true);
    expect(hasInstallRecipeForRuntime('claude', 'darwin')).toBe(true);
    expect(hasInstallRecipeForRuntime('mangostudio', 'linux')).toBe(false);
    expect(hasInstallRecipeForRuntime('bun', 'win32')).toBe(true);
    expect(hasInstallRecipeForRuntime('node', 'win32')).toBe(true);
  });

  it('exposes the winget-driven node install', () => {
    const recipe = getInstallRecipe('winget.node.install');
    expect(recipe.platforms).toEqual(['win32']);
    expect(
      recipe.argv?.({ kind: 'none' }, { platform: 'win32', binaryPaths: { winget: 'winget' } })
    ).toEqual([
      'winget',
      'install',
      '--id',
      'OpenJS.NodeJS.LTS',
      '--exact',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--disable-interactivity',
    ]);
  });

  // Detection resolves Bun's root as `$BUN_INSTALL` before `~/.bun`
  // (`isBunManagedPath`), and the card only offers this recipe for an
  // installation it classified as Bun-managed. A hardcoded `~/.bun` would
  // therefore delete the wrong directory for anyone who set `BUN_INSTALL`,
  // leave the effective Bun running, and still report success.
  it("removes Bun from the same root detection resolves, not a hardcoded '~/.bun'", () => {
    const recipe = getInstallRecipe('bun.uninstall');

    const posix = recipe.argv?.({ kind: 'none' }, { platform: 'linux', binaryPaths: {} });
    expect(posix?.at(-1)).toContain('${BUN_INSTALL:-$HOME/.bun}');

    const win32 = recipe.argv?.({ kind: 'none' }, { platform: 'win32', binaryPaths: {} });
    expect(win32?.at(-1)).toContain('$env:BUN_INSTALL');
    expect(recipe.writes).toContain('$BUN_INSTALL');
  });

  it('offers uninstall and update recipes as copy-only when no vendor shape exists', () => {
    for (const id of ['codex.uninstall', 'cursor.uninstall'] as const) {
      const recipe = getInstallRecipe(id);
      expect(recipe.argv).toBeUndefined();
      expect(recipe.unrunnableReason).toBe('vendor-undocumented');
      expect(recipe.copyCommand({ kind: 'none' }, 'linux').length).toBeGreaterThan(0);
    }
  });
});
