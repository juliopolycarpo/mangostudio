import { describe, expect, it } from 'bun:test';
import { runVersion } from '../../../../src/cli/commands/version';

class CapturingVersionOutput {
  readonly lines: string[] = [];

  log = (message: string): void => {
    this.lines.push(message);
  };
}

const releaseVersion = (): string => '1.2.3';

describe('runVersion', () => {
  it('prints the resolved version', () => {
    const output = new CapturingVersionOutput();

    runVersion({ getVersion: releaseVersion, log: output.log });

    expect(output.lines).toEqual(['1.2.3']);
  });
});
