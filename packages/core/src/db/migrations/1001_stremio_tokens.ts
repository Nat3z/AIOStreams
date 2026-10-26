import type { Migration } from './types.js';

/**
 * Install links a user mints for Stremio, `/s/<token>/manifest.json`. `id` is
 * a hash of the token, never the token; `persona` is empty for the primary user.
 */
const ddl = (int: string) => `
      CREATE TABLE IF NOT EXISTS stremio_tokens (
        id                 TEXT PRIMARY KEY,
        uuid               TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        persona            TEXT NOT NULL,
        encrypted_password TEXT NOT NULL,
        label              TEXT NOT NULL,
        created_at         ${int} NOT NULL,
        last_used_at       ${int}
      );

      CREATE INDEX IF NOT EXISTS idx_stremio_tokens_uuid
        ON stremio_tokens (uuid);
`;

export const stremioTokens: Migration = {
  id: 1001,
  name: 'stremio_tokens',
  up: { sqlite: ddl('INTEGER'), postgres: ddl('BIGINT') },
};
