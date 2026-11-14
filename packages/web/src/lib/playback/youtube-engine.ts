import { t } from '@lingui/core/macro';
import type React from 'react';
import type { EngineFactory, EngineState } from './engine';
import {
  canFullscreen,
  isFullscreen,
  onFullscreenChange,
  toggleDocumentFullscreen,
} from './fullscreen';
import { embedUrl, EMBED_ORIGIN } from './youtube-embed';

/** YouTube's player states, as its embed posts them. */
const ENDED = 0;
const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;

interface Info {
  playerState?: number;
  currentTime?: number;
  duration?: number;
  volume?: number;
  muted?: boolean;
  playbackRate?: number;
}

/** The embed's errors that mean it will never play here, as for an owner who turned embeds off. */
const blocked = (code: unknown) => code === 101 || code === 150;

/**
 * A YouTube video in `frame`, with YouTube's own controls off so the page's
 * drive it: play, seek, volume and speed go over the embed's message API,
 * and full screen takes the page with it.
 */
export function youTubeEngine(
  frame: React.RefObject<HTMLIFrameElement | null>
): EngineFactory {
  return (emit) => {
    let id: string | null = null;
    let ready = false;
    let volume: { volume: number; muted: boolean } | null = null;
    // Opened paused, it waits ready for the page's play.
    let held = false;
    let listening: ReturnType<typeof setInterval> | undefined;
    let stop = () => {};
    const set = (state: EngineState) => emit({ type: 'state', state });
    const command = (func: string, args: unknown[] = []) =>
      frame.current?.contentWindow?.postMessage(
        JSON.stringify({ event: 'command', func, args, id, channel: 'widget' }),
        EMBED_ORIGIN
      );

    const onInfo = (info: Info) => {
      const state: EngineState = {};
      if (info.duration) state.durationMs = info.duration * 1000;
      if (info.volume !== undefined) state.volume = info.volume / 100;
      if (info.muted !== undefined) state.muted = info.muted;
      if (info.playbackRate) state.rate = info.playbackRate;
      switch (info.playerState) {
        case PLAYING:
          Object.assign(state, {
            started: true,
            paused: false,
            waiting: false,
          });
          break;
        case PAUSED:
          Object.assign(state, { paused: true, waiting: false });
          break;
        case BUFFERING:
          state.waiting = true;
          break;
      }
      if (Object.keys(state).length) set(state);
      if (info.currentTime !== undefined)
        emit({ type: 'position', positionMs: info.currentTime * 1000 });
      if (info.playerState === ENDED) emit({ type: 'ended' });
    };

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
      // Both can come, and the picks run once.
      if (
        !ready &&
        (data.event === 'onReady' || data.event === 'initialDelivery')
      ) {
        ready = true;
        clearInterval(listening);
        // Captions the viewer's YouTube settings turn on would sit under the controls.
        command('unloadModule', ['captions']);
        // The page's volume, which only a ready player takes.
        if (volume) {
          command('setVolume', [Math.round(Math.min(1, volume.volume) * 100)]);
          command(volume.muted ? 'mute' : 'unMute');
        }
        if (held) set({ paused: true, waiting: false });
        emit({ type: 'loaded' });
      }
      if (data.event === 'infoDelivery' || data.event === 'initialDelivery')
        onInfo((data.info ?? {}) as Info);
      else if (data.event === 'onStateChange')
        onInfo({ playerState: data.info as number });
      else if (data.event === 'onError')
        emit({
          type: 'failed',
          error: blocked(data.info)
            ? t({
                comment: 'Follows "Playback failed:"',
                message: 'this video only plays on YouTube',
              })
            : t({
                comment: 'Follows "Playback failed:"',
                message: 'YouTube could not play this video',
              }),
        });
    };

    return {
      load(file) {
        stop();
        ready = false;
        id = file.url.replace(/^youtube:/, '');
        const el = frame.current;
        if (!el) return;
        addEventListener('message', listen);
        const stopFullscreen = onFullscreenChange(() =>
          set({ fullscreen: isFullscreen() })
        );
        // The embed only starts posting once told the page listens, which it may miss while it loads.
        const hello = () =>
          el.contentWindow?.postMessage(
            JSON.stringify({ event: 'listening', id, channel: 'widget' }),
            EMBED_ORIGIN
          );
        el.addEventListener('load', hello);
        listening = setInterval(hello, 250);
        stop = () => {
          removeEventListener('message', listen);
          el.removeEventListener('load', hello);
          clearInterval(listening);
          stopFullscreen();
        };
        volume = file.volume;
        held = !!file.paused;
        el.src = embedUrl(id, {
          autoplay: held ? '0' : '1',
          controls: '0',
          disablekb: '1',
          fs: '0',
          modestbranding: '1',
          cc_load_policy: '0',
          start: String(Math.floor(file.startMs / 1000)),
          mute: volume?.muted ? '1' : '0',
        });
      },
      close() {
        stop();
        stop = () => {};
        command('stopVideo');
        frame.current?.removeAttribute('src');
      },
      setPaused(paused) {
        held = false;
        command(paused ? 'pauseVideo' : 'playVideo');
      },
      seek: (ms) => command('seekTo', [ms / 1000, true]),
      setVolume(next, muted) {
        volume = { volume: next, muted };
        command('setVolume', [Math.round(Math.min(1, next) * 100)]);
        command(muted ? 'mute' : 'unMute');
      },
      setRate: (rate) => command('setPlaybackRate', [rate]),
      setAudio() {},
      setSubtitle() {},
      toggleFullscreen: canFullscreen() ? toggleDocumentFullscreen : undefined,
    };
  };
}
