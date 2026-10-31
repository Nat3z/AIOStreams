import type { Migration } from './types.js';

/**
 * Links that let someone without an account watch one title on a
 * configuration. `id` names the pass and its history; `secret` is a hash of
 * the link's code, never the code. `playing` is what the pass's party plays
 * now, which the pass also opens while it does.
 */
const ddl = (int: string) => `
      CREATE TABLE IF NOT EXISTS guest_passes (
        id                 TEXT PRIMARY KEY,
        secret             TEXT NOT NULL UNIQUE,
        uuid               TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        persona            TEXT NOT NULL,
        encrypted_password TEXT NOT NULL,
        item_id            TEXT NOT NULL,
        item_name          TEXT NOT NULL,
        label              TEXT,
        party              TEXT,
        playing            TEXT,
        max_streams        INTEGER NOT NULL,
        created_at         ${int} NOT NULL,
        expires_at         ${int} NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_guest_passes_uuid
        ON guest_passes (uuid);
      CREATE INDEX IF NOT EXISTS idx_guest_passes_expires
        ON guest_passes (expires_at);
`;

export const guestPasses: Migration = {
  id: 1005,
  name: 'guest_passes',
  up: { sqlite: ddl('INTEGER'), postgres: ddl('BIGINT') },
};
