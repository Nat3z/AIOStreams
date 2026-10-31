import { t } from '@lingui/core/macro';
import type React from 'react';
import { currentHost } from '@/lib/hosts';
import type { VideoFit } from '@/lib/settings';
import {
  embeddedSubtitles,
  readsOwnSubtitles,
  type EmbeddedSubtitles,
} from '@/lib/subtitles/embedded';
import type { FileSubtitle } from '@/lib/subtitles/file-subtitle';
import {
  checkSubtitleFile,
  readSubtitleFile,
  READABLE_SUBTITLE_TYPES,
} from '@/lib/subtitles/files';
import { subtitleHeight, subtitleLine } from '@/lib/subtitles/style';
import { videoSurface, type SubtitleLayer } from '@/lib/subtitles/surface';
import type {
  EngineFactory,
  EngineFile,
  EngineState,
  EngineTrack,
  ServerSubtitle,
} from './engine';
import { ownTrackLabel } from './controller';
import {
  canFullscreen,
  isFullscreen,
  onFullscreenChange,
  toggleDocumentFullscreen,
} from './fullscreen';
import {
  drawSubtitle,
  ownLines,
  ownSubtitleTrack,
  ownTrackLost,
} from './page-subtitles';
import { remuxAudio, remuxTracks, remuxUrl } from './remux';
import {
  followText,
  overlayKind,
  readByRemux,
  startOverlay,
  type Overlay,
} from './overlay-subtitles';
import { parseCues } from '../subtitles/cues';

/** A cue would show `{\an8}`-style tags as text. */
const cueText = (text: string) => text.replace(/\{\\[^}]*\}/g, '');

/** HLS through a script, for a browser with no player for it, until the next file. */
async function openHls(
  el: HTMLVideoElement,
  file: EngineFile,
  current: () => boolean,
  failed: (error: string) => void
): Promise<{ destroy(): void } | null> {
  const { default: Hls } = await import('hls.js/light');
  if (!current()) return null;
  if (!Hls.isSupported()) {
    failed(browserCannot());
    return null;
  }
  const hls = new Hls({
    startPosition: file.source.IsInfiniteStream ? -1 : file.startMs / 1000,
  });
  hls.on(Hls.Events.ERROR, (_, data) => {
    if (data.fatal)
      failed(
        t({
          comment: 'Follows "Playback failed:"',
          message: 'the stream stopped loading',
        })
      );
  });
  hls.loadSource(file.url);
  hls.attachMedia(el);
  return hls;
}

/** Null before the video says. */
function bufferedAhead(el: HTMLVideoElement): number | null {
  const { buffered, currentTime } = el;
  for (let i = 0; i < buffered.length; i++)
    if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i))
      return (buffered.end(i) - currentTime) * 1000;
  return buffered.length ? 0 : null;
}

const browserCannot = () =>
  t({
    comment: 'Follows "Playback failed:"',
    message:
      'this browser cannot play this version. Nothing is converted on the server, so try another version, an external player or the desktop app.',
  });

const HLS = 'application/vnd.apple.mpegurl';

const LINK_TYPES = new Map([
  ['m3u8', HLS],
  ['m3u', HLS],
  ['ts', 'video/mp2t'],
]);

function linkType(url: string): string | undefined {
  const name = url.split(/[?#]/)[0].split('/').pop() ?? '';
  return LINK_TYPES.get(name.slice(name.lastIndexOf('.') + 1).toLowerCase());
}

/** A failed load from another site hides its cause, but a link's type can be asked about. */
function declinesLink(el: HTMLVideoElement, url: string): boolean {
  const type = linkType(url);
  return !!type && !el.canPlayType(type);
}

interface AudioTrack {
  enabled: boolean;
  label: string;
  language: string;
}

interface AudioTrackList extends EventTarget {
  readonly length: number;
  [index: number]: AudioTrack;
}

const audioTracksOf = (video: HTMLVideoElement) =>
  (video as { audioTracks?: AudioTrackList }).audioTracks;

const listed = (list: AudioTrackList) =>
  Array.from({ length: list.length }, (_, i) => list[i]);

interface FileTrack {
  id: string;
  label: string;
  track: TextTrack;
  text: string;
}

function trackElement(
  video: HTMLVideoElement,
  subtitle: ServerSubtitle
): HTMLTrackElement {
  const track = document.createElement('track');
  track.kind = 'subtitles';
  // A drawn subtitle keeps an empty track, so the lists still line up;
  // a remux's text one fills its own as the remux reads it.
  if (!readByRemux(subtitle)) track.src = subtitle.url;
  track.label = subtitle.label;
  if (subtitle.lang) track.srclang = subtitle.lang;
  video.append(track);
  return track;
}

/**
 * The page's own `<video>`. Styled scripts and a file's own pictures draw in
 * layers over it; text shows as its text tracks. A remux's styled and picture
 * subtitles are drawn over the video too. A version the server remuxes
 * plays its HLS through hls.js, one audio track at a time.
 */
export function videoEngine(
  video: React.RefObject<HTMLVideoElement | null>
): EngineFactory {
  return (emit) => {
    let file: EngineFile | null = null;
    let subtitles: ServerSubtitle[] = [];
    let elements: HTMLTrackElement[] = [];
    let files: FileTrack[] = [];
    let delayMs = 0;
    let height = subtitleHeight();
    let fit: VideoFit | undefined;
    let line = subtitleLine();
    let layer: SubtitleLayer | null = null;
    let assFailed = false;
    let embedded: EmbeddedSubtitles | null = null;
    let ownTracks: FileSubtitle[] = [];
    // The one shown as text goes through this track; a video's text tracks can't be removed.
    let ownText: { el: HTMLVideoElement; track: TextTrack } | null = null;
    let stopOwnText = () => {};
    let detach = () => {};
    let hls: { destroy(): void } | null = null;
    const dropHls = () => {
      hls?.destroy();
      hls = null;
    };
    // The remux playing, and the audio track it was asked for.
    let remux: { stop(): void } | null = null;
    let remuxedAudio: string | null = null;
    // The subtitle drawn over the video, and what stops it starting late.
    let overlay: Overlay | null = null;
    let overlayStart: AbortController | null = null;
    // A remux's text subtitle grows as it reads, so its cues are fetched again.
    let following: (() => void) | null = null;
    // The subtitle picked, which a reload for another audio track shows again.
    let subtitle: string | null = null;
    // The one text track meant to show. Any other the browser shows on its
    // own, as Safari does by language or hls.js does for captions, would draw
    // over it, so it is turned back off.
    let chosen: TextTrack | null = null;
    // A text track's cues load late, so each one remembers the shift it has.
    const shifted = new WeakMap<TextTrack, number>();
    // Browsers disagree on where a cue the file leaves unplaced goes.
    const placed = new WeakSet<VTTCue>();

    const textTracks = () => [
      ...elements.map((e) => e.track),
      ...files.map((f) => f.track),
      ...(ownText ? [ownText.track] : []),
    ];
    const shiftCues = () => {
      for (const track of textTracks()) {
        const cues = track.cues;
        if (!cues?.length) continue;
        const by = (delayMs - (shifted.get(track) ?? 0)) / 1000;
        if (!by) continue;
        for (const cue of Array.from(cues)) {
          cue.startTime += by;
          cue.endTime += by;
        }
        shifted.set(track, delayMs);
      }
    };
    const placeCue = (vtt: VTTCue) => {
      if (vtt.line !== 'auto' && !placed.has(vtt)) return;
      placed.add(vtt);
      vtt.snapToLines = false;
      vtt.line = line;
      vtt.lineAlign = 'end';
    };
    const placeCues = () => {
      for (const track of textTracks())
        for (const cue of Array.from(track.cues ?? [])) placeCue(cue as VTTCue);
    };
    const hideOwnText = () => {
      stopOwnText();
      stopOwnText = () => {};
      const track = ownText?.track;
      if (!track) return;
      // A disabled track has no cues to remove.
      track.mode = 'hidden';
      for (const cue of Array.from(track.cues ?? [])) track.removeCue(cue);
      track.mode = 'disabled';
      shifted.delete(track);
    };
    const showOwnText = (
      el: HTMLVideoElement,
      reading: EmbeddedSubtitles,
      number: number
    ) => {
      if (ownText?.el !== el)
        ownText = { el, track: el.addTextTrack('subtitles') };
      const { track } = ownText;
      const stop = reading.read(number, {
        events(events) {
          const by = (shifted.get(track) ?? 0) / 1000;
          for (const event of events) {
            const text = cueText(event.text);
            if (!text) continue;
            const cue = new VTTCue(
              event.startMs / 1000 + by,
              event.endMs / 1000 + by,
              text
            );
            track.addCue(cue);
            placeCue(cue);
          }
          shiftCues();
        },
        lost: ownTrackLost,
      });
      if (!stop) return false;
      stopOwnText = stop;
      track.mode = 'showing';
      return true;
    };
    const listTracks = () => {
      if (remux && file) {
        emit({
          type: 'tracks',
          tracks: [
            ...remuxTracks(file.source),
            ...files.map(({ id, label }) => ({
              id,
              type: 'subtitle' as const,
              label,
              external: true,
            })),
          ],
        });
        set({ audio: remuxedAudio });
        return;
      }
      const audio = video.current && audioTracksOf(video.current);
      const audioTracks = audio ? listed(audio) : [];
      const tracks: EngineTrack[] = [
        ...audioTracks.map((t, i) => ({
          id: String(i),
          type: 'audio' as const,
          label: ownTrackLabel(t.label, t.language, i + 1),
          lang: t.language,
          title: t.label,
        })),
        ...ownTracks.map(ownSubtitleTrack),
        ...files.map(({ id, label }) => ({
          id,
          type: 'subtitle' as const,
          label,
          external: true,
        })),
      ];
      emit({ type: 'tracks', tracks });
      const on = audioTracks.findIndex((t) => t.enabled);
      set({ audio: on < 0 ? null : String(on) });
    };
    const onlyChosen = () => {
      const el = video.current;
      if (!el) return;
      for (const track of Array.from(el.textTracks))
        if (track !== chosen && track.mode === 'showing')
          track.mode = 'disabled';
    };
    const onTrackLoad = () => {
      placeCues();
      shiftCues();
    };
    const stopOverlay = () => {
      overlayStart?.abort();
      overlayStart = null;
      overlay?.destroy();
      overlay = null;
      following?.();
      following = null;
    };
    /** Puts what the remux has read of a text subtitle into its track. */
    const fillTrack = (track: TextTrack, vtt: string) => {
      for (const cue of Array.from(track.cues ?? [])) track.removeCue(cue);
      for (const cue of parseCues(vtt))
        track.addCue(
          new VTTCue(cue.startMs / 1000, cue.endMs / 1000, cue.text)
        );
      shifted.delete(track);
      placeCues();
      shiftCues();
    };
    const setSubtitle = (id: string | null) => {
      subtitle = id;
      stopOverlay();
      const at = subtitles.findIndex((s) => s.id === id);
      layer?.destroy();
      layer = null;
      hideOwnText();
      const el = video.current;
      const drawn = at >= 0 ? overlayKind(subtitles[at]) : null;
      if (drawn && el) {
        // Its <track> stays off; the overlay draws it in its place.
        chosen = null;
        for (const e of elements) e.track.mode = 'disabled';
        for (const f of files) f.track.mode = 'disabled';
        onlyChosen();
        const start = new AbortController();
        overlayStart = start;
        void startOverlay(el, subtitles[at], drawn, delayMs, start.signal)
          .then((started) => {
            if (start.signal.aborted) started?.destroy();
            else overlay = started;
          })
          .catch(() => {});
        set({ subtitle: id });
        return;
      }
      const picked = drawSubtitle(
        id,
        { own: ownTracks, embedded, server: subtitles },
        el && videoSurface(el),
        { delayMs, height },
        {
          assFailed,
          onAssFail() {
            assFailed = true;
            setSubtitle(id);
          },
        }
      );
      layer = picked.layer;
      const own = picked.own;
      if (!picked.drawn && el && own && embedded && own.kind !== 'pgs')
        showOwnText(el, embedded, own.number);
      const shown = layer ? undefined : elements[at];
      if (shown && shown.readyState >= HTMLTrackElement.LOADED) {
        const fresh = shown.cloneNode() as HTMLTrackElement;
        fresh.addEventListener('load', onTrackLoad);
        shown.removeEventListener('load', onTrackLoad);
        // Chrome keeps drawing a track removed while showing, over its fresh copy.
        shown.track.mode = 'disabled';
        shown.replaceWith(fresh);
        elements[at] = fresh;
      }
      elements.forEach((e, i) => {
        e.track.mode =
          !layer && subtitles[i]?.id === id ? 'showing' : 'disabled';
      });
      for (const f of files)
        f.track.mode = f.id === id ? 'showing' : 'disabled';
      chosen =
        elements[at]?.track ?? files.find((f) => f.id === id)?.track ?? null;
      onlyChosen();
      shiftCues();
      if (at >= 0 && el && readByRemux(subtitles[at])) {
        const track = elements[at].track;
        const start = new AbortController();
        overlayStart = start;
        void followText(
          el,
          subtitles[at],
          (vtt) => fillTrack(track, vtt),
          start.signal
        )
          .then((stop) => {
            if (start.signal.aborted) stop?.();
            else following = stop;
          })
          .catch(() => {});
      }
      set({ subtitle: id });
    };
    const set = (state: EngineState) => emit({ type: 'state', state });
    const removeElements = () => {
      for (const e of elements) {
        e.track.mode = 'disabled';
        e.remove();
      }
      elements = [];
      layer?.destroy();
      layer = null;
      hideOwnText();
      embedded?.close();
      embedded = null;
      ownTracks = [];
    };

    const stopRemux = () => {
      remux?.stop();
      remux = null;
    };

    /** `switching` reloads for another audio track, which the picks were already made for. */
    const load = (next: EngineFile, switching = false) => {
      const el = video.current;
      if (!el) return;
      detach();
      stopOverlay();
      stopRemux();
      dropHls();
      removeElements();
      chosen = null;
      file = next;
      subtitles = next.subtitles;
      delayMs = next.subtitleDelayMs;
      elements = subtitles.map((s) => trackElement(el, s));
      if (next.volume) {
        el.volume = Math.min(1, next.volume.volume);
        el.muted = next.volume.muted;
      }
      if (readsOwnSubtitles(next.source)) {
        const opened = embeddedSubtitles(
          next.url,
          next.headers,
          currentHost().fetchFile
        );
        embedded = opened;
        void opened.subtitles.then((found) => {
          if (embedded !== opened) return;
          ownTracks = found;
          if (ownTracks.length) listTracks();
        });
      }
      const loaded = () => {
        const reading = embedded;
        if (!reading) return emit({ type: 'loaded' });
        void reading.listed().then(() => {
          if (embedded === reading) emit({ type: 'loaded' });
        });
      };
      // Each read is a new snapshot, whose ranges may have merged since the last.
      const buffered = () => {
        const ranges = el.buffered;
        return Array.from({ length: ranges.length }, (_, i) => ({
          startMs: ranges.start(i) * 1000,
          endMs: ranges.end(i) * 1000,
        }));
      };
      // Asked once it can play, as a browser that refuses autoplay, as on a
      // page it reloaded, would leave it paused behind the cover for good.
      let asked = next.paused;
      // Once, as a remux that recovers reattaches and loads its metadata again.
      let first = true;
      const handlers: Record<string, () => void> = {
        loadedmetadata: () => {
          if (first && next.startMs) el.currentTime = next.startMs / 1000;
          set({ durationMs: el.duration * 1000 || 0 });
          listTracks();
          if (first && !switching) loaded();
          first = false;
        },
        // One opened paused, as a party member's is until the party plays,
        // shows its first frame rather than staying behind the cover.
        loadeddata: () => {
          if (next.paused) set({ started: true, waiting: false });
        },
        durationchange: () => set({ durationMs: el.duration * 1000 || 0 }),
        playing: () => {
          embedded?.setPlaying(true);
          set({ started: true, paused: false, waiting: false });
        },
        pause: () => {
          asked = true;
          set({ paused: true });
        },
        play: () => set({ paused: false }),
        waiting: () => set({ waiting: true }),
        canplay: () => {
          set({ waiting: false });
          if (asked) return;
          asked = true;
          void el.play().catch((error: unknown) => {
            if ((error as Error)?.name === 'NotAllowedError')
              set({ started: true, paused: true, waiting: false });
          });
        },
        timeupdate: () => {
          embedded?.setPosition(el.currentTime * 1000, bufferedAhead(el));
          emit({
            type: 'position',
            positionMs: el.currentTime * 1000,
            buffered: buffered(),
          });
        },
        progress: () => emit({ type: 'position', buffered: buffered() }),
        volumechange: () => set({ volume: el.volume, muted: el.muted }),
        ratechange: () => set({ rate: el.playbackRate }),
        ended: () => emit({ type: 'ended' }),
        error: () => {
          // A remux recovers from its own errors, failing only when it can't.
          if (remux) return;
          // A file the browser can't read may still play as the server converts it.
          if (
            !next.source.IsInfiniteStream &&
            el.error?.code !== MediaError.MEDIA_ERR_NETWORK
          )
            return emit({
              type: 'unplayable',
              reason: browserCannot(),
              positionMs: el.currentTime ? el.currentTime * 1000 : undefined,
            });
          emit({
            type: 'failed',
            error: browserCannot(),
            unsupported: declinesLink(el, next.url),
          });
        },
      };
      for (const [event, handler] of Object.entries(handlers))
        el.addEventListener(event, handler);
      const audio = audioTracksOf(el);
      const audioEvents = ['addtrack', 'removetrack', 'change'];
      for (const event of audioEvents)
        audio?.addEventListener(event, listTracks);
      for (const e of elements) e.addEventListener('load', onTrackLoad);
      const textEvents = ['addtrack', 'change'];
      for (const event of textEvents)
        el.textTracks.addEventListener(event, onlyChosen);
      const onFullscreen = () => set({ fullscreen: isFullscreen() });
      const stopFullscreen = onFullscreenChange(onFullscreen);
      detach = () => {
        for (const [event, handler] of Object.entries(handlers))
          el.removeEventListener(event, handler);
        for (const event of audioEvents)
          audio?.removeEventListener(event, listTracks);
        for (const e of elements) e.removeEventListener('load', onTrackLoad);
        for (const event of textEvents)
          el.textTracks.removeEventListener(event, onlyChosen);
        stopFullscreen();
      };
      onFullscreen();
      el.autoplay = !next.paused;
      if (next.paused) set({ paused: true });
      const remuxed = remuxUrl(next.source, next.url);
      if (remuxed) {
        remuxedAudio ??= remuxAudio(next.source, next.prefs);
        remux = remuxed.play(el, {
          audio: remuxedAudio,
          startMs: next.startMs,
          onError: (error) => emit({ type: 'failed', error }),
        });
      } else if (linkType(next.url) === HLS && !el.canPlayType(HLS))
        void openHls(
          el,
          next,
          () => file === next,
          // One that never loaded, as from a site without CORS, is the link's fault.
          (error) =>
            emit({ type: 'failed', error, unsupported: !el.readyState })
        ).then((opened) => {
          if (file === next) hls = opened;
          else opened?.destroy();
        });
      else el.src = next.url;
      // The picks aren't made again, so the subtitle shown carries over.
      if (switching) setSubtitle(subtitle);
    };

    return {
      load: (next) => load(next),
      // Browsers keep a closed player in their media controls until its video drops the stream.
      close() {
        detach();
        detach = () => {};
        stopOverlay();
        stopRemux();
        remuxedAudio = null;
        dropHls();
        removeElements();
        file = null;
        const el = video.current;
        if (!el) return;
        el.pause();
        el.removeAttribute('src');
        el.load();
      },
      setPaused(paused) {
        const el = video.current;
        if (!el) return;
        if (paused) el.pause();
        else void el.play().catch(() => {});
      },
      seek(ms) {
        if (video.current) video.current.currentTime = ms / 1000;
      },
      setVolume(volume, muted) {
        const el = video.current;
        if (!el) return;
        el.volume = Math.min(1, volume);
        el.muted = muted;
      },
      setRate(rate) {
        if (video.current) video.current.playbackRate = rate;
      },
      setAudio(id) {
        const el = video.current;
        if (remux && file && el && id !== remuxedAudio) {
          // Each audio track is a remux of its own, which picks up where this left off.
          remuxedAudio = id;
          const at = el.currentTime * 1000;
          const paused = el.paused;
          load({ ...file, subtitles, startMs: at, paused }, true);
          return;
        }
        if (remux) return;
        const audio = video.current && audioTracksOf(video.current);
        if (!audio) return;
        listed(audio).forEach((t, i) => (t.enabled = String(i) === id));
        set({ audio: id });
      },
      setSubtitle,
      setSubtitles(next) {
        const el = video.current;
        if (!file || !el) return;
        for (const s of next.slice(subtitles.length)) {
          const track = trackElement(el, s);
          track.addEventListener('load', onTrackLoad);
          elements.push(track);
        }
        subtitles = next;
      },
      setSubtitleDelay(ms) {
        delayMs = ms;
        overlay?.setDelay(ms);
        shiftCues();
        layer?.setDelay(ms);
      },
      setStyle({ subtitleStyle, fit: nextFit, height: next }) {
        height = next;
        line = subtitleLine(subtitleStyle, next);
        placeCues();
        layer?.setHeight(next);
        if (nextFit !== fit) layer?.place();
        fit = nextFit;
      },
      toggleFullscreen: canFullscreen() ? toggleDocumentFullscreen : undefined,
      ...(document.pictureInPictureEnabled && {
        togglePictureInPicture() {
          const el = video.current;
          if (!el) return;
          if (document.pictureInPictureElement === el)
            void document.exitPictureInPicture().catch(() => {});
          else void el.requestPictureInPicture().catch(() => {});
        },
      }),
      ownText: (id) => files.find((f) => f.id === id)?.text ?? null,
      ...ownLines(() => embedded),
      subtitleFiles: {
        types: READABLE_SUBTITLE_TYPES,
        add: async (added) => {
          checkSubtitleFile(added, READABLE_SUBTITLE_TYPES);
          const { text, cues } = await readSubtitleFile(added);
          const el = video.current;
          if (!el) return;
          const track = el.addTextTrack('subtitles', added.name);
          track.mode = 'hidden';
          for (const cue of cues)
            track.addCue(
              new VTTCue(cue.startMs / 1000, cue.endMs / 1000, cue.text)
            );
          const id = `file:${files.length}`;
          files = [...files, { id, label: added.name, track, text }];
          listTracks();
          placeCues();
          setSubtitle(id);
        },
      },
      fits: true,
    };
  };
}
