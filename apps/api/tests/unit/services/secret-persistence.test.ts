import { describe, expect, it } from 'bun:test';
import {
  persistSecret,
  removeSecret,
} from '../../../src/modules/connectors/infrastructure/secret-persistence';

const CONNECTOR_ENV_VAR = 'GEMINI_API_KEY_DEFAULT';

describe('persistSecret environment source', () => {
  it('does not set the connector secret in process.env', async () => {
    delete process.env[CONNECTOR_ENV_VAR];

    await persistSecret(
      'regression-test-id',
      'Default',
      'gemini',
      'environment',
      'sk-regression-test-key'
    );

    expect(process.env[CONNECTOR_ENV_VAR]).toBeUndefined();
  });

  it('does not leave a connector secret in process.env after removeSecret', async () => {
    delete process.env[CONNECTOR_ENV_VAR];

    await removeSecret('regression-test-id', 'Default', 'gemini', 'environment');

    expect(process.env[CONNECTOR_ENV_VAR]).toBeUndefined();
  });
});
