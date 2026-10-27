import type { JellyfinClient } from '../client';
import type { PlayerEngine, Thumbnail } from './engine';

/** The seek bar's picture: the newest answer to the positions it asks for, cleared when it stops asking. */
export interface ThumbnailFeed {
  /** Asks for the keyframe at or before `ms`, or with null, for none. */
  want(ms: number | null): void;
  current(): Thumbnail | null;
  subscribe(listener: () => void): () => void;
}

/** Faster pictures don't look smoother, and each costs the app a decode and the page a draw. */
const ASK_MS = 80;

type Open = (
  onThumbnail: (thumbnail: Thumbnail | null) => void
) => ReturnType<NonNullable<PlayerEngine['thumbnails']>>;

export function thumbnailFeed(
  open: Open
): ThumbnailFeed & { prepare(): void; stop(): void } {
  const listeners = new Set<() => void>();
  let current: Thumbnail | null = null;
  let wanted: number | null = null;
  let none = false;
  let asked = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = (next: Thumbnail | null) => {
    if (next === current) return;
    current = next;
    for (const listener of listeners) listener();
  };
  const requests = open((thumbnail) => {
    if (!thumbnail) none = true;
    show(wanted === null ? null : thumbnail);
  });
  return {
    want(ms) {
      wanted = ms;
      if (ms === null) return show(null);
      if (none || timer) return;
      const ask = () => {
        timer = undefined;
        asked = performance.now();
        if (wanted !== null) requests.want(wanted, current?.positionMs);
      };
      const wait = asked + ASK_MS - performance.now();
      if (wait <= 0) ask();
      else timer = setTimeout(ask, wait);
    },
    prepare() {
      if (!none) requests.prepare();
    },
    current: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    stop() {
      clearTimeout(timer);
      requests.stop();
    },
  };
}

/**
 * The server's pictures of a version, for a player that makes none itself.
 * Each answer is an object URL, freed once a newer picture replaces it.
 */
export function serverThumbnails(
  client: JellyfinClient,
  itemId: string,
  sourceId: string
): Open {
  return (onThumbnail) => {
    let abort: AbortController | null = null;
    let shown: string | null = null;
    let stopped = false;
    const show = (thumbnail: Thumbnail | null) => {
      if (shown) URL.revokeObjectURL(shown);
      shown = thumbnail?.src ?? null;
      onThumbnail(thumbnail);
    };
    return {
      want(ms, showingMs) {
        abort?.abort();
        const request = new AbortController();
        abort = request;
        const url = client.url(`/Videos/${itemId}/${sourceId}/Thumbnail`, {
          At: Math.round(ms),
          Showing: showingMs,
          ApiKey: client.token,
        });
        void fetch(url, { signal: request.signal })
          .then(async (res) => {
            if (res.status === 204) return;
            if (res.status === 404) return show(null);
            if (!res.ok) return;
            const positionMs = Number(res.headers.get('X-Position-Ms') ?? ms);
            const blob = await res.blob();
            if (stopped || request.signal.aborted) return;
            show({ positionMs, src: URL.createObjectURL(blob) });
          })
          .catch(() => {});
      },
      // The server reads the file's index with the first picture asked for.
      prepare() {},
      stop() {
        stopped = true;
        abort?.abort();
        if (shown) URL.revokeObjectURL(shown);
      },
    };
  };
}
