import { describe, expect, it } from 'bun:test';
import {
  assertNodeVersionSpec,
  parseNodeVersionSpec,
  RecipeInputError,
  toFnmDefaultArgument,
  toFnmVersionArgument,
} from '../../../../src/modules/environments/domain/recipe-input';

describe('NodeVersionSpec', () => {
  it.each(['22.13.0', '22.13', '22', 'lts', 'latest'])('accepts %s', (value) => {
    expect(parseNodeVersionSpec(value)).toBe(value);
    expect(assertNodeVersionSpec(value)).toBe(value);
  });

  it.each([
    { label: 'shell separator', value: '22; rm -rf ~' },
    { label: 'command substitution', value: '$(whoami)' },
    { label: 'backticks', value: '`id`' },
    { label: 'option-like input', value: '--' },
    { label: 'path traversal', value: '../../x' },
    { label: 'empty input', value: '' },
    { label: 'unsupported alias', value: 'lts/*' },
    { label: 'version prefix', value: 'v22.13.0' },
    { label: 'too many parts', value: '1.2.3.4' },
    { label: 'oversized input', value: '1'.repeat(10_000) },
  ])('rejects $label', ({ value }) => {
    expect(parseNodeVersionSpec(value)).toBeNull();
    expect(() => assertNodeVersionSpec(value)).toThrow(RecipeInputError);
  });

  it('never accepts a generated spec containing shell metacharacters', () => {
    const metacharacters = /[\s;&|`$<>(){}[\]\\'"!?*]/;
    const candidates = ['lts', 'latest'];
    for (let major = 0; major <= 30; major += 1) {
      candidates.push(`${major}`, `${major}.${major % 10}`, `${major}.${major % 10}.${major % 7}`);
    }

    for (const candidate of candidates) {
      const parsed = parseNodeVersionSpec(candidate);
      expect(parsed).not.toBeNull();
      expect(parsed).not.toMatch(metacharacters);
    }
  });
});

describe('fnm arguments', () => {
  it('renders --lts / --latest / the version as-is for install', () => {
    expect(toFnmVersionArgument('lts')).toBe('--lts');
    expect(toFnmVersionArgument('latest')).toBe('--latest');
    expect(toFnmVersionArgument('22.13.0')).toBe('22.13.0');
  });

  it('renders lts-latest / latest / the version as-is for the default alias', () => {
    expect(toFnmDefaultArgument('lts')).toBe('lts-latest');
    expect(toFnmDefaultArgument('latest')).toBe('latest');
    expect(toFnmDefaultArgument('22.13.0')).toBe('22.13.0');
  });
});
