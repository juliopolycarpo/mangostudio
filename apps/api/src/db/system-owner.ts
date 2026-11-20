/**
 * The reserved `user` row that owns operations recorded before any account
 * exists (see migration 071). It has no credentials and cannot sign in, so
 * code that lists or counts accounts must skip it.
 */
export const SYSTEM_OWNER_USER_ID = 'local';

/** Reserved `.invalid` address of {@link SYSTEM_OWNER_USER_ID}; never deliverable. */
export const SYSTEM_OWNER_EMAIL = 'system@mangostudio.invalid';
