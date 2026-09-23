import { describe, expect, it } from 'bun:test';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import {
  configuredLibraryEnv,
  libraryWritePathEnv,
} from '../../../../src/modules/library/infrastructure/location-probe';

describe('libraryWritePathEnv', () => {
  it('sends the Hub directory pins to Local, where they are the configuration', () => {
    expect(libraryWritePathEnv(undefined, LOCAL_ENVIRONMENT_ID)).toEqual({
      env: configuredLibraryEnv(),
    });
  });

  it('keeps the Hub directory pins off a remote machine, which resolves its own', () => {
    const remote = libraryWritePathEnv(undefined, 'rust-box');
    expect(remote, 'expected no env pins for a remote write | received the Hub pins').toEqual({});
  });

  it('forwards the workspace root either way', () => {
    expect(libraryWritePathEnv('/repo', 'rust-box')).toEqual({ workspaceRoot: '/repo' });
  });
});
