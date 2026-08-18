/**
 * resolveInstallChain: a recipe whose requirements are missing becomes the
 * ordered list of installs that satisfies them, or a statement that it cannot
 * be satisfied here.
 */

import { describe, expect, it } from 'vitest';
import { resolveInstallChain } from '../../../../src/features/environments/install-chain';
import { installRecipe } from './fixtures';

const NVM = installRecipe({
  id: 'nvm.install',
  runtimeId: 'nvm',
  action: 'install',
  writes: ['$NVM_DIR'],
  copyCommand: 'curl -fsSL https://example.test/nvm | bash',
});

const NODE = installRecipe({
  id: 'nvm.node.install',
  runtimeId: 'node',
  action: 'use-version',
  inputKind: 'node-version',
  requires: ['nvm'],
  missingRequirements: ['nvm'],
  copyCommand: 'nvm install lts/*',
});

const LTS = { kind: 'node-version', version: 'lts' } as const;

describe('resolveInstallChain', () => {
  it('returns the recipe alone when nothing is missing', () => {
    const bun = installRecipe();
    const chain = resolveInstallChain([bun], bun, { kind: 'none' });

    expect(chain).toEqual({ kind: 'ready', steps: [{ recipe: bun, input: { kind: 'none' } }] });
  });

  it('puts the prerequisite before the recipe that needs it', () => {
    const chain = resolveInstallChain([NVM, NODE], NODE, LTS);

    expect(chain.kind).toBe('ready');
    expect(chain.kind === 'ready' && chain.steps).toEqual([
      { recipe: NVM, input: { kind: 'none' } },
      { recipe: NODE, input: LTS },
    ]);
  });

  it('reports a requirement no catalog recipe installs', () => {
    const chain = resolveInstallChain([NODE], NODE, LTS);

    expect(chain).toEqual({ kind: 'unresolved', missing: ['nvm'] });
  });

  it('rejects a prerequisite that is unsupported here or needs its own input', () => {
    const unsupported = { ...NVM, supported: false };
    const needsInput = { ...NVM, inputKind: 'node-version' as const };

    expect(resolveInstallChain([unsupported, NODE], NODE, LTS).kind).toBe('unresolved');
    expect(resolveInstallChain([needsInput, NODE], NODE, LTS).kind).toBe('unresolved');
  });

  it('resolves a prerequisite of a prerequisite, deepest first', () => {
    const deep = installRecipe({
      id: 'bun.update',
      runtimeId: 'bun',
      action: 'update',
      requires: ['node'],
      missingRequirements: ['node'],
    });
    const nodeInstall = { ...NODE, action: 'install' as const, inputKind: 'none' as const };
    const chain = resolveInstallChain([NVM, nodeInstall, deep], deep, { kind: 'none' });

    expect(chain.kind === 'ready' && chain.steps.map((step) => step.recipe.id)).toEqual([
      'nvm.install',
      'nvm.node.install',
      'bun.update',
    ]);
  });

  it('reports a cycle as unresolved rather than walking it forever', () => {
    // A catalog can only say this by mistake, but the walk must terminate on it
    // rather than recurse until the stack gives out.
    const left = installRecipe({
      id: 'nvm.install',
      runtimeId: 'nvm',
      action: 'install',
      missingRequirements: ['bun'],
    });
    const right = installRecipe({
      id: 'bun.install.official',
      runtimeId: 'bun',
      action: 'install',
      missingRequirements: ['nvm'],
    });

    expect(resolveInstallChain([left, right], left, { kind: 'none' })).toEqual({
      kind: 'unresolved',
      missing: ['nvm'],
    });
  });
});
