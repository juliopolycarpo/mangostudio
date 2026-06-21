import { randomBytes } from 'node:crypto';

/** Generates a stable unique ID based on current time + secure random suffix. */
export function generateId(): string {
  return `${Date.now()}-${randomBytes(8).toString('hex')}`;
}
