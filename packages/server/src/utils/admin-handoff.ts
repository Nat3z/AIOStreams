import { randomBytes } from 'crypto';
import {
  Cache,
  config as appConfig,
  isAdminUser,
  resolveConfigAlias,
} from '@aiostreams/core';

/*
 * Lets the instance's owner, signed in to the web app, open the configure
 * page without the admin password: their profile asks for a one-time code,
 * and /api/v1/auth/handoff trades it for the admin and config sessions.
 */

const HANDOFF_TTL = 60;

const codes = Cache.getInstance<string, true>('admin-handoff', 100);

/** The admin the owner acts as, or null when no admin login is set up. */
export function ownerAdmin(): string | null {
  return (
    [...(appConfig.bootstrap.auth?.keys() ?? [])].find(isAdminUser) ?? null
  );
}

/** Whether a configuration is the one this instance serves. */
export async function isInstanceConfig(uuid: string): Promise<boolean> {
  const alias = appConfig.jellyfin.instanceAlias;
  return !!alias && (await resolveConfigAlias(alias))?.uuid === uuid;
}

export async function issueAdminHandoff(): Promise<string> {
  const code = randomBytes(24).toString('base64url');
  await codes.set(code, true, HANDOFF_TTL);
  return code;
}

/** Each code opens once. */
export async function redeemAdminHandoff(code: string): Promise<boolean> {
  if (!(await codes.get(code))) return false;
  await codes.delete(code);
  return true;
}
