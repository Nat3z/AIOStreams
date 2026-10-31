import type { Migration } from './types.js';

/**
 * Guest passes are each user's to make, as their settings allow, so the
 * passes made are counted by user and the per-configuration grants go.
 */
const ddl = `
      ALTER TABLE guest_pass_made ADD COLUMN persona TEXT NOT NULL DEFAULT '';
      DROP INDEX IF EXISTS idx_guest_pass_made_uuid;
      CREATE INDEX IF NOT EXISTS idx_guest_pass_made_user
        ON guest_pass_made (uuid, persona, created_at);
      DROP TABLE IF EXISTS guest_pass_grants;
`;

export const guestPassUsers: Migration = {
  id: 1007,
  name: 'guest_pass_users',
  up: { sqlite: ddl, postgres: ddl },
};
