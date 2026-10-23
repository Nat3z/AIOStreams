import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  APIError,
  createLogger,
  decryptString,
  selfStateOf,
  SelfPreferencesSchema,
  StremioTokenRepository,
  config as appConfig,
  updateSelf,
  USER_PASSWORD_MIN,
  type SelfProfilePatch,
} from '@aiostreams/core';
import {
  bodyOf,
  forgetConfig,
  jf,
  userPasswordOf,
  userPasswordOpens,
  type JellyfinRequestContext,
} from './context.js';
import { jellyfinLoginRateLimiter } from '../../middlewares/ratelimit.js';

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
  await updateSelf(ctx.uuid, dec.data, ctx.persona?.id ?? null, patch);
  await forgetConfig(ctx.uuid, ctx.encryptedPassword);
}

/** Re-asks the user's own password for a change that hands something out. */
export async function confirmsPassword(
  req: Request,
  ctx: JellyfinRequestContext,
  password: unknown
): Promise<boolean> {
  // A user without a password of their own signed in with the configuration's.
  if (!userPasswordOf(ctx.userData, ctx.persona)) return true;
  if (!(await jellyfinLoginRateLimiter.tryConsume(req))) return false;
  return userPasswordOpens(
    ctx.uuid,
    ctx.userData,
    ctx.persona,
    String(password ?? '')
  );
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
    const user = ctx.persona ?? ctx.userData.jellyfin?.primary;
    const state = selfStateOf(ctx.userData, ctx.persona);
    res.json({
      name: user?.name ?? null,
      avatar: user?.avatar ?? null,
      hasPin: !!user?.lock,
      hasPassword: !!user?.password,
      passwordMin: USER_PASSWORD_MIN,
      preferences: state.preferences,
      linked: state.addons.map((a) => ({ source: a.source, name: a.name })),
    });
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

router.patch(
  '/AIOStreams/Profile',
  self(async (req, res, ctx) => {
    try {
      const patch: SelfProfilePatch = profileBody.parse(bodyOf(req));
      await saveSelf(ctx, patch);
      logger.info(
        {
          uuid: ctx.uuid,
          persona: ctx.persona?.id,
          fields: Object.keys(patch),
        },
        'user updated their profile'
      );
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
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
          persona: ctx.persona?.id ?? null,
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
    res.json(
      await StremioTokenRepository.list(ctx.uuid, ctx.persona?.id ?? null)
    );
  })
);

router.delete(
  '/AIOStreams/Profile/Stremio/:id',
  self(async (req, res, ctx) => {
    const revoked = await StremioTokenRepository.revoke(
      ctx.uuid,
      ctx.persona?.id ?? null,
      String(req.params.id)
    );
    res.status(revoked ? 204 : 404).end();
  })
);

export default router;
