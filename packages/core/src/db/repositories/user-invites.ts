import { createHash, randomBytes } from 'crypto';
import { getDb } from '../db.js';
import { sql } from '../sql.js';

/*
 * A link the owner sends someone to set up their user: it signs them in, so
 * they pick a password and preferences before typing one. The first device to
 * open it claims it, and only that device can open it again until it expires.
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
  device: string | null;
  [k: string]: unknown;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
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
          VALUES (${hashSecret(token)}, ${target.uuid}, ${target.persona},
                  ${target.encryptedPassword}, ${now}, ${expiresAt})`
    );
    return { token, expiresAt };
  }

  /**
   * The user a link sets up, for the device opening it: an unused link is
   * claimed by the first, and only it gets in after, `done` once set up.
   */
  static async open(
    token: string,
    device: string
  ): Promise<{ target: UserInviteTarget; done: boolean } | null> {
    const db = getDb();
    const id = hashSecret(token);
    const claim = hashSecret(device);
    const now = Date.now();
    await db.exec(
      sql`UPDATE user_invites SET device = ${claim}
           WHERE id = ${id} AND device IS NULL AND used_at IS NULL
             AND expires_at > ${now}`
    );
    const row = await db.maybeOne<InviteRow>(
      sql`SELECT * FROM user_invites
           WHERE id = ${id} AND device = ${claim} AND expires_at > ${now}`
    );
    return row ? { target: targetOf(row), done: row.used_at != null } : null;
  }

  /** The user an unused, unexpired link sets up. */
  static async find(token: string): Promise<UserInviteTarget | null> {
    const row = await getDb().maybeOne<InviteRow>(
      sql`SELECT * FROM user_invites
           WHERE id = ${hashSecret(token)} AND used_at IS NULL
             AND expires_at > ${Date.now()}`
    );
    return row ? targetOf(row) : null;
  }

  /** Ends the link once set up: only the update that marks it used counts. */
  static async consume(token: string): Promise<UserInviteTarget | null> {
    const now = Date.now();
    const row = await getDb().maybeOne<InviteRow>(
      sql`UPDATE user_invites SET used_at = ${now}
           WHERE id = ${hashSecret(token)} AND used_at IS NULL
             AND expires_at > ${now}
          RETURNING *`
    );
    return row ? targetOf(row) : null;
  }

  /** Reopens a link whose setup failed after {@link consume} claimed it. */
  static async release(token: string): Promise<void> {
    await getDb().exec(
      sql`UPDATE user_invites SET used_at = NULL WHERE id = ${hashSecret(token)}`
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
