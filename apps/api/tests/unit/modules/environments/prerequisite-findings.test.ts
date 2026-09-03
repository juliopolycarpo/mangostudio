import { describe, expect, it } from 'bun:test';
import type { RuntimeId, RuntimeStatus } from '@mangostudio/shared/environments';
import { INSTALL_RECIPES } from '../../../../src/modules/environments/domain/install-recipes';
import { computePrerequisiteMissingFindings } from '../../../../src/modules/environments/domain/prerequisite-findings';

const WINGET_REMEDY =
  'Install App Installer from the Microsoft Store: https://apps.microsoft.com/detail/9nblggh4nns1';

function notInstalled(id: RuntimeId): RuntimeStatus {
  return {
    id,
    health: 'missing',
    installations: [],
    findings: [],
    installable: true,
    probedAtMs: 1,
  };
}

function installed(id: RuntimeId): RuntimeStatus {
  return {
    id,
    health: 'ok',
    installations: [
      {
        path: `/usr/bin/${id}`,
        rawPath: `/usr/bin/${id}`,
        version: '1.0.0',
        origin: 'path',
        effective: true,
      },
    ],
    findings: [],
    installable: true,
    probedAtMs: 1,
  };
}

describe('computePrerequisiteMissingFindings', () => {
  it('names the blocking recipe and requirement when node on win32 has no winget', () => {
    const statuses = [notInstalled('node'), notInstalled('winget')];
    const result = computePrerequisiteMissingFindings(statuses, 'win32', INSTALL_RECIPES);
    expect(result.get('node')).toEqual([
      {
        code: 'prerequisite-missing',
        params: { recipe: 'winget.node.install', requirement: 'winget', remedy: WINGET_REMEDY },
        severity: 'warn',
      },
    ]);
  });

  it('reports nothing once winget is installed', () => {
    const statuses = [notInstalled('node'), installed('winget')];
    const result = computePrerequisiteMissingFindings(statuses, 'win32', INSTALL_RECIPES);
    expect(result.has('node')).toBe(false);
  });

  it('reports nothing on linux, where node has no install-action recipe at all', () => {
    // `nvm.node.install` and `fnm.node.install` exist on linux, but their
    // action is `use-version`, not `install` — there is no first-install
    // recipe for node there, so this is vacuous, not "every recipe is fixable".
    const statuses = [notInstalled('node')];
    const result = computePrerequisiteMissingFindings(statuses, 'linux', INSTALL_RECIPES);
    expect(result.has('node')).toBe(false);
  });

  it('reports nothing for a runtime that is already installed', () => {
    const statuses = [installed('node'), notInstalled('winget')];
    const result = computePrerequisiteMissingFindings(statuses, 'win32', INSTALL_RECIPES);
    expect(result.has('node')).toBe(false);
  });

  it('answers every stuck runtime in one batch, not just the first', () => {
    // fnm.install and git.install.windows both require winget too, so an
    // absent winget on win32 blocks all three at once.
    const statuses = [
      notInstalled('node'),
      notInstalled('fnm'),
      notInstalled('git'),
      notInstalled('winget'),
    ];
    const result = computePrerequisiteMissingFindings(statuses, 'win32', INSTALL_RECIPES);
    expect([...result.keys()].sort()).toEqual(['fnm', 'git', 'node']);
    expect(result.get('fnm')?.[0]?.params).toEqual({
      recipe: 'fnm.install',
      requirement: 'winget',
      remedy: WINGET_REMEDY,
    });
  });

  it('never fires for winget itself, which has no install recipe to be stuck behind', () => {
    const statuses = [notInstalled('winget')];
    const result = computePrerequisiteMissingFindings(statuses, 'win32', INSTALL_RECIPES);
    expect(result.has('winget')).toBe(false);
  });
});
