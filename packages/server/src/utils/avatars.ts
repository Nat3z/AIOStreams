import express, { type Request, type Response } from 'express';
import {
  AVATAR_MAX_BYTES,
  AVATAR_TYPES,
  AvatarRepository,
  config as appConfig,
  type AvatarType,
  type UserData,
} from '@aiostreams/core';
import { requestOrigin } from '../routes/jellyfin/context.js';

/*
 * An uploaded picture is the raw image as the body. Stored as a linked one
 * would be: its address goes in the user's `avatar`.
 */

export const avatarBody: express.RequestHandler = express.raw({
  type: [...AVATAR_TYPES],
  limit: AVATAR_MAX_BYTES,
});

/** The bytes only when they are the image they claim to be. */
function imageOf(req: Request): { type: AvatarType; data: Buffer } | null {
  const type = req.get('content-type')?.split(';')[0].trim().toLowerCase();
  const data = req.body;
  if (!Buffer.isBuffer(data) || !data.length) return null;
  const magic =
    type === 'image/png'
      ? data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      : type === 'image/jpeg'
        ? data[0] === 0xff && data[1] === 0xd8
        : type === 'image/webp' &&
          data.subarray(8, 12).toString('latin1') === 'WEBP';
  return magic ? { type: type as AvatarType, data } : null;
}

export const AVATAR_REFUSED = 'A PNG, JPEG or WebP image under 512 KB';

/** The uploads the configuration's users show, which cleanup keeps. */
function avatarsInUse(userData: UserData | null): string[] {
  return (userData?.profiles ?? []).flatMap((u) => {
    const id = /\/avatars\/([\w-]+)$/.exec(u?.avatar ?? '')?.[1];
    return id ? [id] : [];
  });
}

/** Stores the upload for `uuid`, returning its address, or null when it isn't an image. */
export async function saveAvatar(
  req: Request,
  uuid: string,
  userData: UserData | null
): Promise<string | null> {
  const image = imageOf(req);
  if (!image) return null;
  const id = await AvatarRepository.save(
    uuid,
    image.type,
    image.data,
    avatarsInUse(userData)
  );
  const origin =
    appConfig.bootstrap.baseUrl?.replace(/\/$/, '') || requestOrigin(req);
  return `${origin}/avatars/${id}`;
}

export async function serveAvatar(req: Request, res: Response): Promise<void> {
  const avatar = await AvatarRepository.get(String(req.params.id));
  if (!avatar) {
    res.status(404).end();
    return;
  }
  // Its address names its bytes, which never change.
  res
    .type(avatar.type)
    .setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    .setHeader('X-Content-Type-Options', 'nosniff')
    .send(avatar.data);
}
