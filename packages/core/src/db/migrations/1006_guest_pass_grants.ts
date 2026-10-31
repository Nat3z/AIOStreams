import type { Migration } from './types.js';

/**
 * Which configurations may make guest passes, with the limits the dashboard
 * gave each; a null limit is the server's. `guest_pass_made` keeps when each
 * pass was made, outliving the pass, for the monthly limit.
 */
const ddl = (int: string) => `
      CREATE TABLE IF NOT EXISTS guest_pass_grants (
        uuid          TEXT PRIMARY KEY REFERENCES users(uuid) ON DELETE CASCADE,
        max_active    INTEGER,
        max_per_month INTEGER,
        granted_at    ${int} NOT NULL
      );

      CREATE TABLE IF NOT EXISTS guest_pass_made (
        uuid       TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        created_at ${int} NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_guest_pass_made_uuid
        ON guest_pass_made (uuid, created_at);
`;

export const guestPassGrants: Migration = {
  id: 1006,
  name: 'guest_pass_grants',
  up: { sqlite: ddl('INTEGER'), postgres: ddl('BIGINT') },
};
