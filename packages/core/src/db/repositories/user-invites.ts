import { createHash, randomBytes } from 'crypto';
import { getDb } from '../db.js';
import { sql } from '../sql.js';

/*
 * A link the owner sends someone to set up their user: it signs them in until
 * they finish, so they pick a password and preferences before typing one.
 */

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface UserInviteTarget {
  uuid: string;
  encryptedPassword: string;
  persona: string;
}

export interface UserInviteInfo {
  persona: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

interface InviteRow {
  uuid: string;
  persona: string;
  encrypted_password: string;
  created_at: number | string;
  expires_at: number | string;
  used_at: number | string | null;
  [k: string]: unknown;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const targetOf = (row: InviteRow): UserInviteTarget => ({
  uuid: row.uuid,
  encryptedPassword: row.encrypted_password,
  persona: row.persona,
});

export class UserInviteRepository {
  /** Replaces the user's last link. The token is never stored. */
  static async create(
    target: UserInviteTarget
  ): Promise<{ token: string; expiresAt: number }> {
    const db = getDb();
    const token = randomBytes(24).toString('base64url');
    const now = Date.now();
    const expiresAt = now + INVITE_TTL_MS;
    await db.exec(
      sql`DELETE FROM user_invites
           WHERE uuid = ${target.uuid} AND persona = ${target.persona}`
    );
    await db.exec(
      sql`INSERT INTO user_invites
            (id, uuid, persona, encrypted_password, created_at, expires_at)
          VALUES (${hashToken(token)}, ${target.uuid}, ${target.persona},
                  ${target.encryptedPassword}, ${now}, ${expiresAt})`
    );
    return { token, expiresAt };
  }

  /** The user an unused, unexpired link sets up. */
  static async find(token: string): Promise<UserInviteTarget | null> {
    const row = await getDb().maybeOne<InviteRow>(
      sql`SELECT * FROM user_invites
           WHERE id = ${hashToken(token)} AND used_at IS NULL
             AND expires_at > ${Date.now()}`
    );
    return row ? targetOf(row) : null;
  }

  /** Ends the link once set up: only the update that marks it used counts. */
  static async consume(token: string): Promise<UserInviteTarget | null> {
    const now = Date.now();
    const row = await getDb().maybeOne<InviteRow>(
      sql`UPDATE user_invites SET used_at = ${now}
           WHERE id = ${hashToken(token)} AND used_at IS NULL
             AND expires_at > ${now}
          RETURNING *`
    );
    return row ? targetOf(row) : null;
  }

  /** Reopens a link whose setup failed after {@link consume} claimed it. */
  static async release(token: string): Promise<void> {
    await getDb().exec(
      sql`UPDATE user_invites SET used_at = NULL WHERE id = ${hashToken(token)}`
    );
  }

  static async list(uuid: string): Promise<UserInviteInfo[]> {
    const rows = await getDb().query<InviteRow>(
      sql`SELECT * FROM user_invites WHERE uuid = ${uuid}`
    );
    return rows.map((row) => ({
      persona: row.persona,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      usedAt: row.used_at == null ? null : Number(row.used_at),
    }));
  }

  static async revoke(uuid: string, persona: string): Promise<boolean> {
    const res = await getDb().exec(
      sql`DELETE FROM user_invites
           WHERE uuid = ${uuid} AND persona = ${persona}`
    );
    return res.rowCount > 0;
  }
}
