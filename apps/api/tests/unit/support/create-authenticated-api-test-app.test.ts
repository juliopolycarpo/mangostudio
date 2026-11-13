import { describe, expect, it } from 'bun:test';

import { loadConfigForTest } from '../../../src/lib/config';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import { BASE_TEST_AUTH } from '../../support/setup/test-environment';

const USER = { id: 'harness-user', name: 'Harness', email: 'harness@mangostudio.test' };

describe('createAuthenticatedApiTestApp', () => {
  it('names the missing auth secret instead of failing only for the first caller', () => {
    // Bare defaults carry an empty secret, as a stray `loadConfigForTest({})` leaves it.
    loadConfigForTest({});

    expect(() => createAuthenticatedApiTestApp(USER)).toThrow(
      /\(createAuthenticatedApiTestApp\): expected config\.auth\.secret to be a valid test secret \| received: BETTER_AUTH_SECRET is required/
    );
  });

  it('builds the app when the config keeps the base auth block', () => {
    loadConfigForTest({ auth: { ...BASE_TEST_AUTH } });

    const { restore } = createAuthenticatedApiTestApp(USER);
    restore();
  });
});
