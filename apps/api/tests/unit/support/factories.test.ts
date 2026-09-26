import { describe, expect, it, spyOn } from 'bun:test';
import { faker } from '@faker-js/faker';
import { insertTestUser } from '../../support/factories';

const COLLIDING_EMAIL = 'duplicate@mangostudio.test';

function collidingEmail(): string {
  return COLLIDING_EMAIL;
}

describe('test factories', () => {
  it('derives default user emails from ids when faker repeats an email', async () => {
    const email = spyOn(faker.internet, 'email').mockImplementation(collidingEmail);
    try {
      const first = await insertTestUser();
      const second = await insertTestUser();
      const explicit = await insertTestUser({ email: 'explicit@mangostudio.test' });

      expect(first.email).toBe(`${first.id}@mangostudio.test`);
      expect(second.email).toBe(`${second.id}@mangostudio.test`);
      expect(first.email).not.toBe(second.email);
      expect(explicit.email).toBe('explicit@mangostudio.test');
    } finally {
      email.mockRestore();
    }
  });
});
