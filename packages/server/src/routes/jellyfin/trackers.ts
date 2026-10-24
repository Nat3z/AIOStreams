import { createHmac } from 'crypto';
import { Router, type Request, type Response } from 'express';
import {
  AIOMetadata,
  APIError,
  Cache,
  config as appConfig,
  constants,
  createLogger,
  decryptString,
  selfStateOf,
  serialQueue,
  TRACKER_PROVIDERS,
  updateSelf,
  UserRepository,
  type SelfAddon,
  type TrackerProvider,
  type UserData,
} from '@aiostreams/core';
import { forgetConfig, jf, type JellyfinRequestContext } from './context.js';

/*
 * Signing in to a tracker from the profile. Each user gets a configuration of
 * their own on the instance's AIOMetadata, linked to them as a tracker addon:
 * the profile opens the provider's sign-in, the provider returns to
 * /trackers/<provider>/callback here, and the link is made before the page
 * that says so has loaded.
 */

const logger = createLogger('jellyfin');
const SOURCE = 'aiometadata';
const PENDING_TTL = 600;

interface Pending {
  uuid: string;
  encryptedPassword: string;
  persona: string | null;
  provider: TrackerProvider;
}

const pending = Cache.getInstance<string, Pending>('tracker-sign-in', 1000);
// A user's sign-ins and sign-outs read and rewrite one configuration, so one at a time.
const serialised = serialQueue();
const userKey = (uuid: string, persona: string | null) =>
  `${uuid}:${persona ?? ''}`;

const isProvider = (value: string): value is TrackerProvider =>
  (TRACKER_PROVIDERS as readonly string[]).includes(value);

/** The user's AIOMetadata password, derived so nothing more is stored. */
function passwordFor(uuid: string, persona: string | null): string {
  return createHmac('sha256', appConfig.bootstrap.secretKey)
    .update(`aiometadata:${uuid}:${persona ?? ''}`)
    .digest('base64url');
}

function linkedOf(
  userData: UserData,
  persona: string | null
): SelfAddon | undefined {
  const found = persona
    ? userData.jellyfin?.personas?.find((p) => p.id === persona)
    : null;
  return selfStateOf(userData, found ?? null).addons.find(
    (a) => a.source === SOURCE
  );
}

function configPassword(encryptedPassword: string): string {
  const dec = decryptString(encryptedPassword);
  if (!dec.success || !dec.data) throw new Error('Unreadable session');
  return dec.data;
}

function service(): AIOMetadata {
  const aiom = AIOMetadata.fromConfig();
  if (!aiom) {
    throw new APIError(
      constants.ErrorCode.BAD_REQUEST,
      404,
      'Tracking is not set up on this server'
    );
  }
  return aiom;
}

/** Saves the user's link, or removes it when `userUUID` is null. */
async function link(
  aiom: AIOMetadata,
  who: Pick<Pending, 'uuid' | 'encryptedPassword' | 'persona'>,
  userUUID: string | null
): Promise<void> {
  const addons: SelfAddon[] = userUUID
    ? [
        {
          source: SOURCE,
          name: 'Tracker',
          manifestUrl: aiom.manifestUrl(userUUID),
          tracker: true,
          // Only its tracking: the owner's addons already give everything else.
          resources: [constants.WATCH_STATE_RESOURCE],
        },
      ]
    : [];
  await updateSelf(
    who.uuid,
    configPassword(who.encryptedPassword),
    who.persona,
    { addons: { source: SOURCE, addons } }
  );
  await forgetConfig(who.uuid, who.encryptedPassword);
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof APIError) {
    res.status(error.statusCode ?? 400).json({ Message: error.message });
    return;
  }
  throw error;
}

export const trackersRouter: Router = Router({ mergeParams: true });

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
    try {
      await handler(req, res, ctx);
    } catch (error) {
      sendError(res, error);
    }
  });
}

trackersRouter.get(
  '/AIOStreams/Profile/Trackers',
  self(async (_req, res, ctx) => {
    const aiom = AIOMetadata.fromConfig();
    const shared = ctx.persona?.history === 'shared';
    const persona = ctx.persona?.id ?? null;
    const linked = linkedOf(ctx.userData, persona);
    const userUUID = linked && aiom?.userOf(linked.manifestUrl);
    const accounts =
      aiom && userUUID
        ? await aiom.accounts(userUUID, passwordFor(ctx.uuid, persona))
        : { simkl: null, anilist: null };
    res.json({ available: !!aiom, shared, accounts });
  })
);

// Answers with the sign-in page, which the profile opens in a new window.
trackersRouter.post(
  '/AIOStreams/Profile/Trackers/:provider',
  self(async (req, res, ctx) => {
    const provider = String(req.params.provider);
    if (!isProvider(provider)) {
      res.status(404).json({ Message: 'Unknown tracker' });
      return;
    }
    // A shared history syncs with the primary user's trackers, never its own.
    if (ctx.persona?.history === 'shared') {
      res.status(400).json({
        Message: 'You share the main history, so its trackers are yours',
      });
      return;
    }
    const { url, state } = await service().authorize(provider);
    // Read once, straight after the provider returns, so it skips the write buffer.
    await pending.set(
      state,
      {
        uuid: ctx.uuid,
        encryptedPassword: ctx.encryptedPassword,
        persona: ctx.persona?.id ?? null,
        provider,
      },
      PENDING_TTL,
      true
    );
    res.json({ url });
  })
);

trackersRouter.delete(
  '/AIOStreams/Profile/Trackers/:provider',
  self(async (req, res, ctx) => {
    const provider = String(req.params.provider);
    const aiom = service();
    const persona = ctx.persona?.id ?? null;
    if (!isProvider(provider)) {
      res.status(404).json({ Message: 'Not signed in' });
      return;
    }
    const password = passwordFor(ctx.uuid, persona);
    const done = await serialised(userKey(ctx.uuid, persona), async () => {
      // Read here, as a sign-in queued before this one may have relinked them.
      const raw = await UserRepository.getRawUser(
        ctx.uuid,
        configPassword(ctx.encryptedPassword)
      );
      const linked = raw && linkedOf(raw, persona);
      const userUUID = linked && aiom.userOf(linked.manifestUrl);
      if (!userUUID) return false;
      await aiom.disconnect(provider, userUUID, password);
      // Nothing left to track with, so it stops being their tracker.
      const accounts = await aiom.accounts(userUUID, password);
      if (!Object.values(accounts).some(Boolean)) {
        await link(aiom, { ...ctx, persona }, null);
      }
      return true;
    });
    if (done) res.status(204).end();
    else res.status(404).json({ Message: 'Not signed in' });
  })
);

/** Where the providers return, outside the Jellyfin API as no session comes with it. */
export const trackerCallbackRouter: Router = Router();

trackerCallbackRouter.get('/:provider/callback', async (req, res) => {
  const provider = String(req.params.provider);
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const who = state ? await pending.get(state) : undefined;
  // Each sign-in finishes once: only the delete that removes it counts.
  if (!who || who.provider !== provider || !(await pending.delete(state))) {
    res
      .status(400)
      .type('html')
      .send(
        page(false, 'This sign-in expired. Start it again from your profile.')
      );
    return;
  }
  const label = provider === 'simkl' ? 'Simkl' : 'AniList';
  try {
    const aiom = service();
    const query = req.originalUrl.split('?')[1] ?? '';
    const tokenId = await aiom.finishAuthorize(who.provider, query);
    await serialised(userKey(who.uuid, who.persona), async () => {
      const raw = await UserRepository.getRawUser(
        who.uuid,
        configPassword(who.encryptedPassword)
      );
      if (!raw) throw new Error('Your account changed; sign in again');
      const linked = linkedOf(raw, who.persona);
      const userUUID = await aiom.connect(
        who.provider,
        tokenId,
        passwordFor(who.uuid, who.persona),
        (linked && aiom.userOf(linked.manifestUrl)) ?? undefined
      );
      await link(aiom, who, userUUID);
    });
    const name = await aiom.username(tokenId);
    logger.info(
      { uuid: who.uuid, persona: who.persona, provider },
      'user signed in to a tracker'
    );
    res
      .type('html')
      .send(
        page(
          true,
          name ? `${label} is connected as ${name}.` : `${label} is connected.`
        )
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      { uuid: who.uuid, provider, err: message },
      'tracker sign-in failed'
    );
    res.status(502).type('html').send(page(false, message));
  }
});

function page(ok: boolean, message: string): string {
  const text = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${ok ? 'Connected' : 'Not connected'}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 1.5rem; background: #09090b; color: #f4f4f5; font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 26rem; }
  h1 { margin: 0 0 .25rem; font-size: 1.125rem; font-weight: 600; }
  p { margin: 0; color: #a1a1aa; }
</style>
</head>
<body>
<main>
  <h1>${ok ? 'All set' : 'That didn&#39;t work'}</h1>
  <p>${text} ${ok ? 'You can close this window.' : ''}</p>
</main>
<script>
  // The profile listens on this; the provider's pages cut the window off from it.
  new BroadcastChannel('aiostreams-trackers').postMessage(${ok});
  ${ok ? 'setTimeout(() => window.close(), 1500);' : ''}
</script>
</body>
</html>`;
}
