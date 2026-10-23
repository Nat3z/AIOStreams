/*
 * Clients for the two services a Link Trakt goes through, reached on the
 * instance's private network: homedocker-trakt-bridge, which scrobbles and
 * reads back progress, and AIOMetadata, which serves Trakt catalogs. Both
 * send the browser to Trakt themselves; this server stands in for their
 * public callback, so neither has to be exposed.
 */
import { createHash, createHmac } from 'crypto';
import { config as appConfig } from '../config/index.js';
import { makeRequest } from '../utils/http.js';

const TIMEOUT_MS = 15_000;

async function call(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<Response> {
  return makeRequest(url, {
    ...init,
    timeout: TIMEOUT_MS,
    ignoreRecursion: true,
    ignoreCooldown: true,
    rawOptions: { redirect: 'manual' },
  });
}

function locationOf(res: Response, base: string): URL {
  const location = res.headers.get('location');
  if (res.status < 300 || res.status >= 400 || !location) {
    throw new Error(`expected a redirect, got ${res.status}`);
  }
  return new URL(location, base);
}

/** The `state` Trakt will hand back, which is how a callback finds its link. */
export function traktStateOf(authorizeUrl: string): string {
  const state = new URL(authorizeUrl).searchParams.get('state');
  if (!state) throw new Error('authorize url without a state');
  return state;
}

export class TraktBridge {
  constructor(
    private readonly url: string,
    private readonly adminKey: string,
    private readonly secret: string
  ) {}

  /** Mirrors the bridge's own `deriveProfileKey`. */
  private key(purpose: 'setup' | 'addon', id: string): string {
    return createHmac(
      'sha256',
      createHash('sha256').update(this.secret).digest()
    )
      .update(`${purpose}:${id}`)
      .digest('base64url');
  }

  async createProfile(name: string): Promise<string> {
    const res = await call(
      `${this.url}/setup?key=${encodeURIComponent(this.adminKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ name }).toString(),
      }
    );
    const id = locationOf(res, this.url).pathname.match(
      /^\/u\/([a-f0-9]{24})\/setup$/
    )?.[1];
    if (!id) throw new Error('bridge did not create a profile');
    return id;
  }

  /** The Trakt page that authorizes this profile. */
  async authorizeUrl(id: string): Promise<string> {
    const setup = encodeURIComponent(this.key('setup', id));
    const res = await call(`${this.url}/u/${id}/oauth/start?key=${setup}`);
    return locationOf(res, this.url).toString();
  }

  /** Hands Trakt's answer to the bridge; resolves once `id` holds its tokens. */
  async finish(id: string, code: string, state: string): Promise<void> {
    const query = new URLSearchParams({ code, state });
    const res = await call(`${this.url}/oauth/callback?${query}`);
    const next = locationOf(res, this.url);
    if (
      next.pathname !== `/u/${id}/setup` ||
      next.searchParams.get('connected') !== '1'
    ) {
      throw new Error(`bridge did not connect (${res.status})`);
    }
  }

  /** Clears the profile's tokens; the bridge has no way to delete it. */
  async disconnect(id: string): Promise<void> {
    const setup = encodeURIComponent(this.key('setup', id));
    const res = await call(`${this.url}/u/${id}/disconnect?key=${setup}`, {
      method: 'POST',
    });
    if (res.status >= 400) throw new Error(`bridge disconnect ${res.status}`);
  }

  manifestUrl(id: string): string {
    return `${this.url}/u/${id}/${this.key('addon', id)}/manifest.json`;
  }

  /** The profile a manifest from `manifestUrl` belongs to. */
  profileOf(manifestUrl: string): string | null {
    if (!manifestUrl.startsWith(`${this.url}/u/`)) return null;
    return (
      manifestUrl.slice(this.url.length).match(/^\/u\/([a-f0-9]{24})\//)?.[1] ??
      null
    );
  }
}

/** Trakt's personal lists, as AIOMetadata names them. */
const TRAKT_CATALOGS = [
  { id: 'trakt.upnext', type: 'series', name: 'Trakt Up Next', cacheTTL: 300 },
  {
    id: 'trakt.recommendations.movies',
    type: 'movie',
    name: 'Trakt Recommendations',
  },
  {
    id: 'trakt.recommendations.shows',
    type: 'series',
    name: 'Trakt Recommendations',
  },
  { id: 'trakt.watchlist', type: 'all', name: 'Trakt Watchlist' },
].map((c) => ({ ...c, source: 'trakt', enabled: true, showInHome: true }));

export class MetadataAddon {
  constructor(
    private readonly url: string,
    private readonly adminKey: string
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.adminKey) headers['X-Admin-Key'] = this.adminKey;
    return headers;
  }

  async authorizeUrl(): Promise<string> {
    const res = await call(`${this.url}/api/auth/trakt/authorize`, {
      headers: this.headers(),
    });
    return locationOf(res, this.url).toString();
  }

  /**
   * Trades Trakt's answer for a token and saves a configuration with that
   * user's lists, guarded by `password`. Returns its manifest URL.
   */
  async finish(code: string, state: string, password: string): Promise<string> {
    const query = new URLSearchParams({ code, state });
    const page = await call(`${this.url}/api/auth/trakt/callback?${query}`, {
      headers: this.headers(),
    });
    // It answers with a page for people to copy the token from.
    const tokenId = (await page.text()).match(
      /<code\b[^>]*\bid="tokenId"[^>]*>([0-9a-f-]{36})<\/code>/i
    )?.[1];
    if (page.status !== 200 || !tokenId) {
      throw new Error(`metadata addon did not authorize (${page.status})`);
    }
    const res = await call(`${this.url}/api/config/save`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        password,
        config: {
          apiKeys: { traktTokenId: tokenId },
          catalogs: TRAKT_CATALOGS,
        },
      }),
    });
    const saved = (await res.json().catch(() => null)) as {
      userUUID?: string;
    } | null;
    if (!res.ok || !saved?.userUUID) {
      throw new Error(`metadata addon did not save (${res.status})`);
    }
    return this.manifestUrl(saved.userUUID);
  }

  /**
   * Deletes the configuration. The Trakt token stays: the addon shares one per
   * Trakt account, so revoking it could cut off someone else's lists.
   */
  async delete(manifestUrl: string, password: string): Promise<void> {
    const uuid = this.configOf(manifestUrl);
    if (!uuid) return;
    const res = await call(`${this.url}/api/config/delete-user/${uuid}`, {
      method: 'DELETE',
      headers: this.headers(),
      body: JSON.stringify({ password }),
    });
    if (res.status >= 400 && res.status !== 404) {
      throw new Error(`metadata addon delete ${res.status}`);
    }
  }

  manifestUrl(uuid: string): string {
    return `${this.url}/stremio/${uuid}/manifest.json`;
  }

  configOf(manifestUrl: string): string | null {
    if (!manifestUrl.startsWith(`${this.url}/stremio/`)) return null;
    return (
      manifestUrl.slice(this.url.length).match(/^\/stremio\/([^/]+)\//)?.[1] ??
      null
    );
  }
}

/** The services this instance links Trakt through; no bridge, no Link Trakt. */
export function traktServices(): {
  bridge: TraktBridge;
  metadata: MetadataAddon | null;
} | null {
  const t = appConfig.jellyfin.trakt;
  if (!t.bridgeUrl || !t.bridgeAdminKey || !t.bridgeSecretKey) return null;
  return {
    bridge: new TraktBridge(t.bridgeUrl, t.bridgeAdminKey, t.bridgeSecretKey),
    metadata: t.metadataUrl
      ? new MetadataAddon(t.metadataUrl, t.metadataAdminKey)
      : null,
  };
}
