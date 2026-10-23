import { createHmac } from 'crypto';
import { Router, type Request, type Response } from 'express';
import {
  Cache,
  config as appConfig,
  createLogger,
  decryptString,
  traktServices,
  traktStateOf,
  updateSelf,
  type SelfAddon,
} from '@aiostreams/core';
import { forgetConfig } from '../jellyfin/context.js';

/*
 * Linking Trakt is two Trakt approvals, one for each service: the bridge that
 * tracks plays, then AIOMetadata for the user's lists. Both services name this
 * server as their public callback, so a pending link is keyed by the `state`
 * Trakt hands back and finished here.
 */

const logger = createLogger('jellyfin');
const router: Router = Router();

const PENDING_TTL_SECONDS = 10 * 60;

export interface PendingLink {
  uuid: string;
  /** The session's, never the plain one: the cache may be shared storage. */
  encryptedPassword: string;
  personaId: string | null;
  bridgeProfile: string;
  /** Where the user goes back to: their web app's profile settings. */
  returnTo: string;
}

const pending = Cache.getInstance<string, PendingLink>('trakt-link', 1000);

export const TRAKT_SOURCES = ['trakt', 'trakt-lists'];

/** Starts a link; the user's browser is sent to the URL this returns. */
export async function startTraktLink(
  link: Omit<PendingLink, 'bridgeProfile'>,
  name: string
): Promise<string> {
  const services = traktServices();
  if (!services) throw new Error('Trakt linking is not set up');
  const bridgeProfile = await services.bridge.createProfile(name);
  const url = await services.bridge.authorizeUrl(bridgeProfile);
  await pending.set(
    `bridge:${traktStateOf(url)}`,
    { ...link, bridgeProfile },
    PENDING_TTL_SECONDS
  );
  return url;
}

/** Derived, so unlinking can delete the lists' configuration without storing it. */
export function metadataPasswordFor(bridgeProfile: string): string {
  return createHmac('sha256', appConfig.bootstrap.secretKey)
    .update(`trakt-lists:${bridgeProfile}`)
    .digest('base64url');
}

/** Taken once, so a replayed callback finds nothing. */
async function take(key: string): Promise<PendingLink | undefined> {
  const link = await pending.get(key);
  if (link) await pending.delete(key);
  return link;
}

async function save(link: PendingLink, metadataManifest: string | null) {
  const services = traktServices()!;
  const addons: SelfAddon[] = [
    {
      source: 'trakt',
      name: 'Trakt',
      manifestUrl: services.bridge.manifestUrl(link.bridgeProfile),
      tracker: true,
    },
  ];
  if (metadataManifest) {
    addons.push({
      source: 'trakt-lists',
      name: 'Trakt lists',
      manifestUrl: metadataManifest,
      tracker: false,
    });
  }
  const configPassword = decryptString(link.encryptedPassword);
  if (!configPassword.success || !configPassword.data) {
    throw new Error('Unreadable session');
  }
  await updateSelf(link.uuid, configPassword.data, link.personaId, {
    addons: { sources: TRAKT_SOURCES, addons },
  });
  await forgetConfig(link.uuid, link.encryptedPassword);
  logger.info(
    { uuid: link.uuid, persona: link.personaId, lists: !!metadataManifest },
    'user linked trakt'
  );
}

function back(res: Response, link: PendingLink, outcome: string): void {
  const url = new URL(link.returnTo);
  url.hash = `/settings?tab=profile&trakt=${outcome}`;
  res.redirect(302, url.toString());
}

function params(req: Request): { code: string; state: string } | null {
  const { code, state } = req.query;
  return typeof code === 'string' && typeof state === 'string' && code && state
    ? { code, state }
    : null;
}

// The bridge's PUBLIC_BASE_URL is /bridge, so its callback lands here.
router.get('/bridge/oauth/callback', async (req, res) => {
  const p = params(req);
  const link = p && (await take(`bridge:${p.state}`));
  if (!p || !link) {
    res
      .status(400)
      .send('This Trakt link expired. Start it again from your profile.');
    return;
  }
  const services = traktServices();
  try {
    if (!services) throw new Error('Trakt linking is not set up');
    await services.bridge.finish(link.bridgeProfile, p.code, p.state);
    if (!services.metadata) {
      await save(link, null);
      back(res, link, 'linked');
      return;
    }
    const url = await services.metadata.authorizeUrl();
    await pending.set(`aiom:${traktStateOf(url)}`, link, PENDING_TTL_SECONDS);
    res.redirect(302, url);
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'trakt link failed at the bridge'
    );
    back(res, link, 'failed');
  }
});

router.get('/aiom/callback', async (req, res) => {
  const p = params(req);
  const link = p && (await take(`aiom:${p.state}`));
  if (!p || !link) {
    res
      .status(400)
      .send('This Trakt link expired. Start it again from your profile.');
    return;
  }
  try {
    const metadata = traktServices()?.metadata;
    if (!metadata) throw new Error('AIOMetadata is not set up');
    const manifest = await metadata.finish(
      p.code,
      p.state,
      metadataPasswordFor(link.bridgeProfile)
    );
    await save(link, manifest);
    back(res, link, 'linked');
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'trakt link failed at the metadata addon'
    );
    // Tracking already works; the lists can be relinked later.
    await save(link, null).catch(() => undefined);
    back(res, link, 'partial');
  }
});

export default router;
