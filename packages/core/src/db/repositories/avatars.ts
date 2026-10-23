import { createHash } from 'crypto';
import { getDb } from '../db.js';
import { sql } from '../sql.js';

/* Uploaded user pictures, served at an address of their own like a linked one. */

export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type AvatarType = (typeof AVATAR_TYPES)[number];
export const AVATAR_MAX_BYTES = 512 * 1024;
/** Old uploads a configuration keeps, for users not saved yet. */
const KEEP_PER_CONFIG = 32;

interface AvatarRow {
  type: string;
  data: Buffer | Uint8Array;
  [k: string]: unknown;
}

export class AvatarRepository {
  /** Stores a picture, returning its id; the oldest past the cap go. */
  static async save(
    uuid: string,
    type: AvatarType,
    data: Buffer
  ): Promise<string> {
    const db = getDb();
    const id = createHash('sha256')
      .update(uuid)
      .update(data)
      .digest('base64url')
      .slice(0, 32);
    await db.exec(
      sql`INSERT INTO avatars (id, uuid, type, data, created_at)
          VALUES (${id}, ${uuid}, ${type}, ${data}, ${Date.now()})
          ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at`
    );
    await db.exec(
      sql`DELETE FROM avatars WHERE uuid = ${uuid} AND id NOT IN (
            SELECT id FROM avatars WHERE uuid = ${uuid}
             ORDER BY created_at DESC LIMIT ${KEEP_PER_CONFIG})`
    );
    return id;
  }

  static async get(id: string): Promise<{ type: string; data: Buffer } | null> {
    const row = await getDb().maybeOne<AvatarRow>(
      sql`SELECT type, data FROM avatars WHERE id = ${id}`
    );
    return row ? { type: row.type, data: Buffer.from(row.data) } : null;
  }
}
