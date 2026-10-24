import { config as appConfig } from '../config/index.js';
import { APIError, ErrorCode } from '../utils/constants.js';
import { makeRequest } from '../utils/http.js';

/*
 * The instance's own AIOMetadata, which tracks for its users: each one gets a
 * configuration on it holding their Simkl or AniList sign-in, linked to them as
 * a tracker addon. Its sign-in pages end on a token to copy, so the callback is
 * routed through us and the token read from that page instead.
 */

export const TRACKER_PROVIDERS = ['simkl', 'anilist'] as const;
export type TrackerProvider = (typeof TRACKER_PROVIDERS)[number];

const PROVIDERS: Record<
  TrackerProvider,
  {
    authorize: string;
    callback: string;
    disconnect: string;
    key: string;
    tracking: string;
  }
> = {
  simkl: {
    authorize: '/api/auth/simkl/authorize',
    callback: '/api/auth/simkl/callback',
    disconnect: '/api/auth/simkl/disconnect',
    key: 'simklTokenId',
    tracking: 'simklWatchTracking',
  },
  anilist: {
    authorize: '/anilist/auth',
    callback: '/anilist/callback',
    disconnect: '/anilist/disconnect',
    key: 'anilistTokenId',
    tracking: 'anilistWatchTracking',
  },
};

const TIMEOUT_MS = 15000;

type AIOMetadataConfig = Record<string, any> & {
  apiKeys?: Record<string, string | undefined>;
};

export class AIOMetadata {
  private constructor(private readonly base: string) {}

  /** Null until an instance is configured. */
  static fromConfig(): AIOMetadata | null {
    const url = appConfig.watchState.aiometadataUrl;
    return url ? new AIOMetadata(url) : null;
  }

  manifestUrl(userUUID: string): string {
    return `${this.base}/stremio/${userUUID}/manifest.json`;
  }

  /** The configuration a manifest URL from {@link manifestUrl} names. */
  userOf(manifestUrl: string): string | null {
    const prefix = `${this.base}/stremio/`;
    if (!manifestUrl.startsWith(prefix)) return null;
    return (
      /^([0-9a-f-]{36})\/manifest\.json$/.exec(
        manifestUrl.slice(prefix.length)
      )?.[1] ?? null
    );
  }

  /**
   * The provider's sign-in page, and the state it returns to the callback with,
   * which only this instance can verify.
   */
  async authorize(
    provider: TrackerProvider
  ): Promise<{ url: string; state: string }> {
    const res = await this.request(PROVIDERS[provider].authorize);
    const location = res.headers.get('location');
    const state = location?.startsWith('https://')
      ? new URL(location).searchParams.get('state')
      : null;
    if (res.status >= 300 && res.status < 400 && location && state) {
      return { url: location, state };
    }
    throw this.failure(provider, await this.errorOf(res));
  }

  /** Finishes the sign-in with the provider's callback query, returning the token id. */
  async finishAuthorize(
    provider: TrackerProvider,
    query: string
  ): Promise<string> {
    const res = await this.request(`${PROVIDERS[provider].callback}?${query}`);
    const page = await res.text();
    const token = /id="tokenId"[^>]*>([0-9a-f-]{36})</.exec(page)?.[1];
    if (res.ok && token) return token;
    const said = (cls: string) =>
      new RegExp(`class="${cls}">([^<]*)<`).exec(page)?.[1];
    throw this.failure(
      provider,
      decodeEntities(said('message') ?? `HTTP ${res.status}`)
    );
  }

  async username(tokenId: string): Promise<string | null> {
    const res = await this.request('/api/oauth/token/info', { tokenId });
    if (!res.ok) return null;
    const info = (await res.json()) as { username?: unknown };
    return typeof info.username === 'string' ? info.username : null;
  }

  /** The configuration, or null when it is gone or the password no longer opens it. */
  async load(
    userUUID: string,
    password: string
  ): Promise<AIOMetadataConfig | null> {
    const res = await this.request(`/api/config/load/${userUUID}`, {
      password,
    });
    if (res.status === 401 || res.status === 404) return null;
    const body = (await this.json(res)) as { config: AIOMetadataConfig };
    return body.config;
  }

  /** Signs a configuration in to the provider, creating it when there is none. */
  async connect(
    provider: TrackerProvider,
    tokenId: string,
    password: string,
    userUUID?: string
  ): Promise<string> {
    const existing = userUUID ? await this.load(userUUID, password) : null;
    const { key, tracking } = PROVIDERS[provider];
    const config: AIOMetadataConfig = {
      ...(existing ?? { catalogs: [] }),
      // Plays are reported by us, so tracking never guesses from subtitle requests.
      playbackReporting: true,
      apiKeys: { ...existing?.apiKeys, [key]: tokenId },
      [tracking]: true,
    };
    if (existing && userUUID) {
      await this.json(
        await this.request(
          `/api/config/update/${userUUID}`,
          { config, password },
          'PUT'
        )
      );
      return userUUID;
    }
    const body = (await this.json(
      await this.request('/api/config/save', { config, password })
    )) as { userUUID: string };
    return body.userUUID;
  }

  async disconnect(
    provider: TrackerProvider,
    userUUID: string,
    password: string
  ): Promise<void> {
    await this.json(
      await this.request(PROVIDERS[provider].disconnect, { userUUID, password })
    );
  }

  /** Who each provider is signed in as, null where it is not. */
  async accounts(
    userUUID: string,
    password: string
  ): Promise<Record<TrackerProvider, string | null>> {
    const config = await this.load(userUUID, password);
    const entries = await Promise.all(
      TRACKER_PROVIDERS.map(async (provider) => {
        const tokenId = config?.apiKeys?.[PROVIDERS[provider].key];
        // A sign-in whose name cannot be read is still one.
        const name = tokenId
          ? ((await this.username(tokenId)) ?? provider)
          : null;
        return [provider, name] as const;
      })
    );
    return Object.fromEntries(entries) as Record<
      TrackerProvider,
      string | null
    >;
  }

  private request(path: string, body?: unknown, method?: string) {
    return makeRequest(`${this.base}${path}`, {
      timeout: TIMEOUT_MS,
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      ignoreRecursion: true,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      rawOptions: { redirect: 'manual' },
    });
  }

  private async json(res: Response): Promise<unknown> {
    if (!res.ok) throw this.failure(null, await this.errorOf(res));
    return res.json();
  }

  private async errorOf(res: Response): Promise<string> {
    const text = await res.text().catch(() => '');
    try {
      const error = (JSON.parse(text) as { error?: unknown }).error;
      if (typeof error === 'string') return error;
    } catch {}
    return `HTTP ${res.status}`;
  }

  private failure(provider: TrackerProvider | null, reason: string): APIError {
    const who =
      provider === 'simkl'
        ? 'Simkl'
        : provider === 'anilist'
          ? 'AniList'
          : 'AIOMetadata';
    return new APIError(ErrorCode.BAD_REQUEST, 502, `${who}: ${reason}`);
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
