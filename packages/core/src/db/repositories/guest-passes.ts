import { createHash, randomBytes } from 'crypto';
import { getDb } from '../db.js';
import type { DbDriver } from '../driver/types.js';
import { sql } from '../sql.js';

/*
 * A link that lets someone without an account watch one title on a
 * configuration until it expires. The link carries a code; only its hash is
 * stored. Anyone holding the link gets in, so a pass caps its devices instead.
 */

export interface GuestPass {
  id: string;
  uuid: string;
  /** The user whose configuration it plays from; empty for the account. */
  persona: string;
  encryptedPassword: string;
  /** The title it opens, and everything under it. */
  itemId: string;
  itemName: string;
  label: string | null;
  /** The party on this server's relay it may join, by id. */
  party: string | null;
  /** What that party plays now, which it also opens meanwhile. */
  playing: string | null;
  maxStreams: number;
  createdAt: number;
  expiresAt: number;
}

export interface NewGuestPass {
  uuid: string;
  persona: string;
  encryptedPassword: string;
  itemId: string;
  itemName: string;
  label?: string;
  party?: string;
  maxStreams: number;
  expiresAt: number;
}

interface PassRow {
  id: string;
  uuid: string;
  persona: string;
  encrypted_password: string;
  item_id: string;
  item_name: string;
  label: string | null;
  party: string | null;
  playing: string | null;
  max_streams: number | string;
  created_at: number | string;
  expires_at: number | string;
  [k: string]: unknown;
}

const MONTH_MS = 30 * 24 * 3600 * 1000;

const hashCode = (code: string) =>
  createHash('sha256').update(code).digest('hex');

const passOf = (row: PassRow): GuestPass => ({
  id: row.id,
  uuid: row.uuid,
  persona: row.persona,
  encryptedPassword: row.encrypted_password,
  itemId: row.item_id,
  itemName: row.item_name,
  label: row.label,
  party: row.party,
  playing: row.playing,
  maxStreams: Number(row.max_streams),
  createdAt: Number(row.created_at),
  expiresAt: Number(row.expires_at),
});

/** Bounds how long a revoked or widened pass reads stale on a replica that did not write it. */
const PASS_TTL_MS = 5_000;

export class GuestPassRepository {
  private static cache = new Map<
    string,
    { value: GuestPass | null; at: number }
  >();

  /** The code is returned once and never stored. */
  static async create(
    pass: NewGuestPass
  ): Promise<{ pass: GuestPass; code: string }> {
    const id = randomBytes(9).toString('base64url');
    const code = randomBytes(18).toString('base64url');
    const now = Date.now();
    await getDb().exec(
      sql`INSERT INTO guest_pass_made (uuid, persona, created_at)
          VALUES (${pass.uuid}, ${pass.persona}, ${now})`
    );
    const row = await getDb().maybeOne<PassRow>(
      sql`INSERT INTO guest_passes
            (id, secret, uuid, persona, encrypted_password, item_id,
             item_name, label, party, max_streams, created_at, expires_at)
          VALUES (${id}, ${hashCode(code)}, ${pass.uuid}, ${pass.persona},
                  ${pass.encryptedPassword}, ${pass.itemId}, ${pass.itemName},
                  ${pass.label ?? null}, ${pass.party ?? null},
                  ${pass.maxStreams}, ${now}, ${pass.expiresAt})
          RETURNING *`
    );
    return { pass: passOf(row!), code };
  }

  /** The unexpired pass a link's code opens. */
  static async open(code: string): Promise<GuestPass | null> {
    const row = await getDb().maybeOne<PassRow>(
      sql`SELECT * FROM guest_passes
           WHERE secret = ${hashCode(code)} AND expires_at > ${Date.now()}`
    );
    return row ? passOf(row) : null;
  }

  /** By id, expired or not: a stream already playing outlives its pass. */
  static async get(id: string): Promise<GuestPass | null> {
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.at < PASS_TTL_MS) return cached.value;
    const row = await getDb().maybeOne<PassRow>(
      sql`SELECT * FROM guest_passes WHERE id = ${id}`
    );
    const value = row ? passOf(row) : null;
    this.cache.set(id, { value, at: Date.now() });
    if (this.cache.size > 1000)
      for (const [key, entry] of this.cache)
        if (Date.now() - entry.at >= PASS_TTL_MS) this.cache.delete(key);
    return value;
  }

  /** A user's unexpired passes; `persona` is empty for the primary user. */
  static async list(uuid: string, persona: string): Promise<GuestPass[]> {
    const rows = await getDb().query<PassRow>(
      sql`SELECT * FROM guest_passes
           WHERE uuid = ${uuid} AND persona = ${persona}
             AND expires_at > ${Date.now()}
           ORDER BY created_at DESC`
    );
    return rows.map(passOf);
  }

  static async countActive(uuid: string, persona: string): Promise<number> {
    const row = await getDb().maybeOne<{ n: number | string }>(
      sql`SELECT COUNT(*) AS n FROM guest_passes
           WHERE uuid = ${uuid} AND persona = ${persona}
             AND expires_at > ${Date.now()}`
    );
    return Number(row?.n ?? 0);
  }

  /** Passes made in the last 30 days, ended ones included. */
  static async countThisMonth(uuid: string, persona: string): Promise<number> {
    const row = await getDb().maybeOne<{ n: number | string }>(
      sql`SELECT COUNT(*) AS n FROM guest_pass_made
           WHERE uuid = ${uuid} AND persona = ${persona}
             AND created_at > ${Date.now() - MONTH_MS}`
    );
    return Number(row?.n ?? 0);
  }

  static async revoke(
    uuid: string,
    persona: string,
    id: string
  ): Promise<boolean> {
    const res = await getDb().exec(
      sql`DELETE FROM guest_passes
           WHERE uuid = ${uuid} AND persona = ${persona} AND id = ${id}`
    );
    this.cache.delete(id);
    return res.rowCount > 0;
  }

  /** Lets the configuration's passes into a party play what it plays now, or nothing more. */
  static async setPlaying(
    uuid: string,
    party: string,
    itemId: string | null
  ): Promise<void> {
    const rows = await getDb().query<{ id: string }>(
      sql`UPDATE guest_passes SET playing = ${itemId}
           WHERE uuid = ${uuid} AND party = ${party}
          RETURNING id`
    );
    for (const { id } of rows) this.cache.delete(id);
  }

  /** Ends the passes that expired before `before`, for their history to go too. */
  static async pruneExpired(
    before: number
  ): Promise<{ id: string; uuid: string }[]> {
    await getDb().exec(
      sql`DELETE FROM guest_pass_made WHERE created_at < ${Date.now() - MONTH_MS}`
    );
    return getDb().query<{ id: string; uuid: string }>(
      sql`DELETE FROM guest_passes WHERE expires_at < ${before}
          RETURNING id, uuid`
    );
  }

  /** Refreshes the stored blob after a password change, in the change's transaction. */
  static async reencryptForUuid(
    tx: DbDriver,
    uuid: string,
    encryptedPassword: string
  ): Promise<void> {
    await tx.exec(
      sql`UPDATE guest_passes SET encrypted_password = ${encryptedPassword}
           WHERE uuid = ${uuid}`
    );
    this.cache.clear();
  }
}
