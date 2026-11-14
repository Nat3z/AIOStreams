import React from 'react';
import { useLatest } from '@/hooks/use-latest';

export const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

/** YouTube's states, as its embed posts them. */
const PLAYING = 1;
const ENDED = 0;

interface EmbedEvents {
  onPlaying?: () => void;
  onEnded(): void;
  onFailed(): void;
}

/** The embed's address, which posts its states to the page with `enablejsapi`. */
export function embedUrl(id: string, params: Record<string, string>): string {
  const query = new URLSearchParams({
    autoplay: '1',
    playsinline: '1',
    rel: '0',
    iv_load_policy: '3',
    ...params,
    enablejsapi: '1',
    origin: location.origin,
  });
  return `${EMBED_ORIGIN}/embed/${id}?${query}`;
}

/** Listens to the embed in `frame`; the returned handler goes on its `onLoad`. */
export function useEmbedEvents(
  frame: React.RefObject<HTMLIFrameElement | null>,
  id: string,
  events: EmbedEvents
): () => void {
  const latest = useLatest(events);
  React.useEffect(() => {
    const listen = (e: MessageEvent) => {
      if (
        e.origin !== EMBED_ORIGIN ||
        e.source !== frame.current?.contentWindow
      )
        return;
      let data: { event?: string; info?: unknown };
      try {
        data = JSON.parse(String(e.data));
      } catch {
        return;
      }
      const state =
        data.event === 'onStateChange'
          ? data.info
          : data.event === 'infoDelivery'
            ? (data.info as { playerState?: number } | undefined)?.playerState
            : undefined;
      if (state === PLAYING) latest.current.onPlaying?.();
      else if (state === ENDED) latest.current.onEnded();
      if (data.event === 'onError') latest.current.onFailed();
    };
    addEventListener('message', listen);
    return () => removeEventListener('message', listen);
  }, [frame, latest]);
  return () =>
    frame.current?.contentWindow?.postMessage(
      JSON.stringify({ event: 'listening', id, channel: 'widget' }),
      EMBED_ORIGIN
    );
}
