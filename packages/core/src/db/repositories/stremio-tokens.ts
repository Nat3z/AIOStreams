import { createHash, randomBytes } from 'crypto';
import { getDb } from '../db.js';
import { sql } from '../sql.js';

/*
 * A user's Stremio install link. The link carries only a random token; what it
 * opens, the configuration and which of its users, stays here.
 */

const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const MAX_PER_USER = 10;

export interface StremioTokenTarget {
  uuid: string;
  encryptedPassword: string;
  /** Null for the primary user. */
  persona: string | null;
}

export interface StremioTokenInfo {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface TokenRow {
  id: string;
  uuid: string;
  persona: string;
  encrypted_password: string;
  label: string;
  created_at: number | string;
  last_used_at: number | string | null;
  [k: string]: unknown;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Listed and revoked by a short prefix of the hash, never the token. */
const publicId = (id: string) => id.slice(0, 16);

export class StremioTokenRepository {
  /** Returns the token, which is never stored and cannot be shown again. */
  static async create(
    target: StremioTokenTarget,
    label: string
  ): Promise<string> {
    const db = getDb();
    const persona = target.persona ?? '';
    const token = randomBytes(24).toString('base64url');
    const now = Date.now();
    // Oldest first out, so a user cannot pile up links without bound.
    const rows = await db.query<{ id: string }>(
      sql`SELECT id FROM stremio_tokens
           WHERE uuid = ${target.uuid} AND persona = ${persona}
           ORDER BY created_at DESC`
    );
    for (const row of rows.slice(MAX_PER_USER - 1)) {
      await db.exec(sql`DELETE FROM stremio_tokens WHERE id = ${row.id}`);
    }
    await db.exec(
      sql`INSERT INTO stremio_tokens
            (id, uuid, persona, encrypted_password, label, created_at)
          VALUES (${hashToken(token)}, ${target.uuid}, ${persona},
                  ${target.encryptedPassword}, ${label}, ${now})`
    );
    return token;
  }

  static async resolve(token: string): Promise<StremioTokenTarget | null> {
    const db = getDb();
    const id = hashToken(token);
    const row = await db.maybeOne<TokenRow>(
      sql`SELECT * FROM stremio_tokens WHERE id = ${id}`
    );
    if (!row) return null;
    const now = Date.now();
    const lastUsed = row.last_used_at == null ? 0 : Number(row.last_used_at);
    if (now - lastUsed > TOUCH_INTERVAL_MS) {
      await db.exec(
        sql`UPDATE stremio_tokens SET last_used_at = ${now} WHERE id = ${id}`
      );
    }
    return {
      uuid: row.uuid,
      encryptedPassword: row.encrypted_password,
      persona: row.persona || null,
    };
  }

  static async list(
    uuid: string,
    persona: string | null
  ): Promise<StremioTokenInfo[]> {
    const rows = await getDb().query<TokenRow>(
      sql`SELECT * FROM stremio_tokens
           WHERE uuid = ${uuid} AND persona = ${persona ?? ''}
           ORDER BY created_at DESC`
    );
    return rows.map((row) => ({
      id: publicId(row.id),
      label: row.label,
      createdAt: Number(row.created_at),
      lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
    }));
  }

  /** Only the owner's own links match, whatever id is passed. */
  static async revoke(
    uuid: string,
    persona: string | null,
    id: string
  ): Promise<boolean> {
    if (!/^[0-9a-f]{16}$/.test(id)) return false;
    const db = getDb();
    const rows = await db.query<{ id: string }>(
      sql`SELECT id FROM stremio_tokens
           WHERE uuid = ${uuid} AND persona = ${persona ?? ''}`
    );
    const match = rows.find((row) => publicId(row.id) === id);
    if (!match) return false;
    await db.exec(sql`DELETE FROM stremio_tokens WHERE id = ${match.id}`);
    return true;
  }
}
