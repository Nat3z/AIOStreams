import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  APIError,
  createLogger,
  decryptString,
  mintToken,
  readToken,
  selfStateOf,
  SelfPreferencesSchema,
  StremioTokenRepository,
  UserInviteRepository,
  config as appConfig,
  updateSelf,
  USER_PASSWORD_MIN,
  isOwner,
  profileById,
  type SelfProfilePatch,
} from '@aiostreams/core';
import {
  bodyOf,
  forgetConfig,
  jf,
  lockTag,
  resolveConfig,
  userPasswordOpens,
  type JellyfinRequestContext,
} from './context.js';
import { jellyfinLoginRateLimiter } from '../../middlewares/ratelimit.js';
import { AVATAR_REFUSED, avatarBody, saveAvatar } from '../../utils/avatars.js';
import {
  isInstanceConfig,
  issueAdminHandoff,
} from '../../utils/admin-handoff.js';

/*
 * The signed-in user's own profile, as the web app's settings edit it. Every
 * write goes through `updateSelf`, which only reaches that user's fields.
 */

const logger = createLogger('jellyfin');
const router: Router = Router({ mergeParams: true });

function self(
  handler: (
    req: Request,
    res: Response,
    ctx: JellyfinRequestContext
  ) => Promise<void>
) {
  return jf(async (req, res, ctx) => {
    if (ctx.apiKey) {
      res.status(403).json({ Message: 'Not available to API keys' });
      return;
    }
    await handler(req, res, ctx);
  });
}

/** Saves a change to the caller's own part of the configuration. */
export async function saveSelf(
  ctx: JellyfinRequestContext,
  patch: SelfProfilePatch
): Promise<void> {
  const dec = decryptString(ctx.encryptedPassword);
  if (!dec.success || !dec.data) throw new Error('Unreadable session');
  await updateSelf(ctx.uuid, dec.data, ctx.profile.id, patch);
  await forgetConfig(ctx.uuid, ctx.encryptedPassword);
}

/** Re-asks the user's own password for a change that hands something out. */
export async function confirmsPassword(
  req: Request,
  ctx: JellyfinRequestContext,
  password: unknown
): Promise<boolean> {
  // A user without a password of their own signed in with the configuration's.
  if (!ctx.profile.password) return true;
  if (!(await jellyfinLoginRateLimiter.tryConsume(req))) return false;
  return userPasswordOpens(ctx.uuid, ctx.profile, String(password ?? ''));
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof APIError) {
    res.status(error.statusCode ?? 400).json({ Message: error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ Message: error.issues[0]?.message ?? 'Invalid' });
    return;
  }
  throw error;
}

router.get(
  '/AIOStreams/Profile',
  self(async (_req, res, ctx) => {
    const user = ctx.profile;
    const state = selfStateOf(ctx.userData, user);
    res.json({
      name: user.name ?? null,
      avatar: user.avatar ?? null,
      hasPin: !!user.lock,
      hasPassword: !!user.password,
      passwordMin: USER_PASSWORD_MIN,
      preferences: state.preferences,
      linked: state.addons.map((a) => ({ source: a.source, name: a.name })),
      configure: await configures(ctx),
    });
  })
);

/**
 * The instance's own owner profile, and the profiles it lets configure it.
 * Those must have signed in with a password, not a PIN alone.
 */
async function configures(ctx: JellyfinRequestContext): Promise<boolean> {
  if (
    !isOwner(ctx.profile) &&
    !(ctx.profile.configure && readToken(ctx.token)?.w === 1)
  )
    return false;
  return isInstanceConfig(ctx.uuid);
}

// They are already signed in, so the configure page asks nothing more.
// `Owner` asks on the owner's behalf alone, as signing in does.
router.post(
  '/AIOStreams/Profile/Configure',
  self(async (req, res, ctx) => {
    const ownerOnly = bodyOf(req).Owner === true;
    if ((ownerOnly && !isOwner(ctx.profile)) || !(await configures(ctx))) {
      res
        .status(403)
        .json({ Message: 'Only the owner configures this server' });
      return;
    }
    if (ctx.persona)
      logger.info(
        { uuid: ctx.uuid, persona: ctx.persona.id },
        'user opened the configure page as admin'
      );
    const code = await issueAdminHandoff();
    res.json({ url: `/api/v1/auth/handoff?code=${code}` });
  })
);

const profileBody = z
  .object({
    name: z.string().trim().min(1).max(32).optional(),
    avatar: z.string().url().max(2048).nullable().optional(),
    pin: z
      .string()
      .regex(/^\d{4,12}$/, 'A PIN must be 4 to 12 digits.')
      .nullable()
      .optional(),
    preferences: SelfPreferencesSchema.optional(),
  })
  .strict();

// POST, as Jellyfin updates a user, so every client's CORS lets it through.
router.post(
  '/AIOStreams/Profile',
  self(async (req, res, ctx) => {
    try {
      const patch: SelfProfilePatch = profileBody.parse(bodyOf(req));
      await saveSelf(ctx, patch);
      logger.info(
        {
          uuid: ctx.uuid,
          profile: ctx.profile.id,
          fields: Object.keys(patch),
        },
        'user updated their profile'
      );
      if (patch.pin === undefined) {
        res.status(204).end();
        return;
      }
      // A new PIN ends the user's other sessions, but not this one.
      const userData = await resolveConfig(ctx.uuid, ctx.encryptedPassword);
      const profile = userData ? profileById(userData, ctx.profile.id) : null;
      const { iat: _, ...payload } = readToken(ctx.token)!;
      res.json({
        AccessToken: mintToken({
          ...payload,
          l: (profile && lockTag(profile)) || undefined,
        }),
      });
    } catch (error) {
      sendError(res, error);
    }
  })
);

// The picture goes up first; saving the profile with its address sets it.
router.post(
  '/AIOStreams/Profile/Avatar',
  avatarBody,
  self(async (req, res, ctx) => {
    const url = await saveAvatar(req, ctx.uuid, ctx.userData);
    if (url) res.json({ url });
    else res.status(400).json({ Message: AVATAR_REFUSED });
  })
);

const passwordBody = z.object({
  current: z.string().max(128).optional(),
  next: z.string().min(USER_PASSWORD_MIN).max(128),
});

router.post(
  '/AIOStreams/Profile/Password',
  self(async (req, res, ctx) => {
    try {
      const { current, next } = passwordBody.parse(bodyOf(req));
      if (!(await confirmsPassword(req, ctx, current))) {
        res.status(403).json({ Message: 'Invalid password' });
        return;
      }
      await saveSelf(ctx, { password: next });
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
  })
);

const welcomeBody = z.object({
  token: z.string().min(16).max(64),
  password: z.string().min(USER_PASSWORD_MIN).max(128),
});

// A setup link's last step: the user's own password, which also resets a
// forgotten one, and then the link stops working.
router.post(
  '/AIOStreams/Profile/Welcome',
  self(async (req, res, ctx) => {
    try {
      const { token, password } = welcomeBody.parse(bodyOf(req));
      const invite = await UserInviteRepository.find(token);
      // Claimed before the save, so two submits can't both set a password.
      if (
        !invite ||
        invite.uuid !== ctx.uuid ||
        invite.persona !== ctx.profile.id ||
        !(await UserInviteRepository.consume(token))
      ) {
        res
          .status(403)
          .json({ Message: 'This link has expired or was already used' });
        return;
      }
      await saveSelf(ctx, { password }).catch(async (error: unknown) => {
        // Nothing was set, so the link still works for another try.
        await UserInviteRepository.release(token);
        throw error;
      });
      logger.info(
        { uuid: ctx.uuid, profile: ctx.profile.id },
        'user finished setting up'
      );
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
  })
);

/** Install links store the owner as no profile. */
const ownTokenId = (ctx: JellyfinRequestContext): string | null =>
  isOwner(ctx.profile) ? null : ctx.profile.id;

const installBody = z.object({
  password: z.string().max(128).optional(),
  label: z.string().trim().min(1).max(40).default('Stremio'),
});

// The link opens streams as this user, so making one asks for their password.
router.post(
  '/AIOStreams/Profile/Stremio',
  self(async (req, res, ctx) => {
    try {
      const { password, label } = installBody.parse(bodyOf(req));
      if (!(await confirmsPassword(req, ctx, password))) {
        res.status(403).json({ Message: 'Invalid password' });
        return;
      }
      const token = await StremioTokenRepository.create(
        {
          uuid: ctx.uuid,
          encryptedPassword: ctx.encryptedPassword,
          persona: ownTokenId(ctx),
        },
        label
      );
      res.json({
        manifestUrl: `${appConfig.bootstrap.baseUrl}/s/${token}/manifest.json`,
      });
    } catch (error) {
      sendError(res, error);
    }
  })
);

router.get(
  '/AIOStreams/Profile/Stremio',
  self(async (_req, res, ctx) => {
    res.json(await StremioTokenRepository.list(ctx.uuid, ownTokenId(ctx)));
  })
);

router.delete(
  '/AIOStreams/Profile/Stremio/:id',
  self(async (req, res, ctx) => {
    const revoked = await StremioTokenRepository.revoke(
      ctx.uuid,
      ownTokenId(ctx),
      String(req.params.id)
    );
    res.status(revoked ? 204 : 404).end();
  })
);

export default router;
