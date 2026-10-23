import type { Migration } from './types.js';

/**
 * Pictures uploaded for a configuration's users. `id` hashes the bytes and is
 * the picture's public address, so uploading the same one twice keeps one row.
 */
const ddl = (int: string, bytes: string) => `
      CREATE TABLE IF NOT EXISTS avatars (
        id         TEXT PRIMARY KEY,
        uuid       TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        type       TEXT NOT NULL,
        data       ${bytes} NOT NULL,
        created_at ${int} NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_avatars_uuid ON avatars (uuid);
`;

export const avatars: Migration = {
  id: 51,
  name: 'avatars',
  up: { sqlite: ddl('INTEGER', 'BLOB'), postgres: ddl('BIGINT', 'BYTEA') },
};
