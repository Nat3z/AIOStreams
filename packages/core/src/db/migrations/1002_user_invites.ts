import type { Migration } from './types.js';

/**
 * Onboarding links the owner sends a user, one per user. `id` is a hash of the
 * token, never the token; `used_at` is set once they finish setting up.
 */
const ddl = (int: string) => `
      CREATE TABLE IF NOT EXISTS user_invites (
        id                 TEXT PRIMARY KEY,
        uuid               TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        persona            TEXT NOT NULL,
        encrypted_password TEXT NOT NULL,
        created_at         ${int} NOT NULL,
        expires_at         ${int} NOT NULL,
        used_at            ${int}
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_invites_user
        ON user_invites (uuid, persona);
`;

export const userInvites: Migration = {
  id: 1002,
  name: 'user_invites',
  up: { sqlite: ddl('INTEGER'), postgres: ddl('BIGINT') },
};
