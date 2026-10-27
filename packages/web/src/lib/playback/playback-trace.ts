/* eslint-disable lingui/no-unlocalized-strings -- a log for the server, never shown */
import type Hls from 'hls.js';

/** Lines kept, enough for the half minute before something goes wrong. */
const KEEP = 400;
/** A jump back further than this, unasked, is the player recovering. */
const JUMP_BACK_S = 2;

/**
 * Records what the video and hls.js report while a remux plays, and sends it
 * to the server when playback errors or jumps back on its own, so a failure
 * on a phone can be read from the server's log.
 */
export function tracePlayback(
  el: HTMLVideoElement,
  hls: Hls | null,
  send: (text: string) => void
): () => void {
  const lines: string[] = [];
  const t0 = performance.now();
  let lastTime = 0;
  let seekingTo: number | null = null;
  let sent = 0;
  const ranges = (r: TimeRanges) =>
    Array.from(
      { length: r.length },
      (_, i) => `${r.start(i).toFixed(2)}-${r.end(i).toFixed(2)}`
    ).join(',');
  const log = (text: string) => {
    lines.push(
      `${((performance.now() - t0) / 1000).toFixed(2)} t=${el.currentTime.toFixed(2)} buf=${ranges(el.buffered)} ${text}`
    );
    if (lines.length > KEEP) lines.shift();
  };
  const flush = (why: string) => {
    // A few reports a play, as one failure tends to repeat.
    if (sent >= 4) return;
    sent++;
    log(`REPORT ${why}`);
    send(
      [
        'aiostreams-playback',
        navigator.userAgent,
        `media source: ${'ManagedMediaSource' in window ? 'managed' : 'MediaSource' in window ? 'mse' : 'native'}`,
        ...lines,
      ].join('\n')
    );
  };

  const events = [
    'loadedmetadata',
    'playing',
    'pause',
    'waiting',
    'stalled',
    'seeking',
    'seeked',
    'ended',
    'emptied',
    'error',
  ];
  const onEvent = (e: Event) => {
    if (e.type === 'seeking') {
      seekingTo = el.currentTime;
      // Where from, as a recovery seeks just like the user does.
      log(`seeking from ${lastTime.toFixed(2)}`);
      return;
    }
    if (e.type === 'seeked') seekingTo = null;
    const err = e.type === 'error' && el.error;
    log(err ? `error ${err.code} ${err.message}` : e.type);
    if (err) flush('video error');
    if (e.type === 'ended') flush('ended');
  };
  const onTime = () => {
    const now = el.currentTime;
    if (seekingTo === null && now < lastTime - JUMP_BACK_S) {
      log(`JUMPED BACK from ${lastTime.toFixed(2)}`);
      flush('jumped back');
    }
    lastTime = now;
  };
  for (const e of events) el.addEventListener(e, onEvent);
  el.addEventListener('timeupdate', onTime);

  const offs: (() => void)[] = [];
  if (hls) {
    const on = <E extends Parameters<Hls['on']>[0]>(
      event: E,
      fn: Parameters<Hls['on']>[1]
    ) => {
      hls.on(event, fn as never);
      offs.push(() => hls.off(event, fn as never));
    };
    const Events = (hls.constructor as typeof Hls).Events;
    on(Events.ERROR, ((
      _: unknown,
      d: {
        type: string;
        details: string;
        fatal: boolean;
        frag?: { sn: number | string; start: number };
        error?: Error;
        reason?: string;
      }
    ) => {
      log(
        `hls ${d.type} ${d.details} fatal=${d.fatal}${d.frag ? ` sn=${d.frag.sn}@${d.frag.start.toFixed(2)}` : ''} ${d.error?.message ?? d.reason ?? ''}`.trim()
      );
      if (
        d.fatal ||
        d.details === 'bufferAppendError' ||
        d.details === 'bufferStalledError'
      )
        flush(`hls ${d.details}`);
    }) as never);
    on(Events.FRAG_BUFFERED, ((
      _: unknown,
      d: { frag: { sn: number | string; start: number; duration: number } }
    ) =>
      log(
        `frag ${d.frag.sn} ${d.frag.start.toFixed(2)}+${d.frag.duration.toFixed(2)}`
      )) as never);
    on(Events.BUFFER_FLUSHED, ((_: unknown, d: { type?: string }) =>
      log(`flushed ${d.type ?? ''}`)) as never);
    on(Events.FRAG_LOADING, ((
      _: unknown,
      d: { frag: { sn: number | string; start: number } }
    ) => log(`loading ${d.frag.sn} @${d.frag.start.toFixed(2)}`)) as never);
    on(Events.MEDIA_ENDED, (() => log('hls media ended')) as never);
  }
  log('start');
  return () => {
    // Whatever went wrong, the user closes the player after it.
    if (performance.now() - t0 > 5_000) flush('closed');
    for (const e of events) el.removeEventListener(e, onEvent);
    el.removeEventListener('timeupdate', onTime);
    for (const off of offs) off();
  };
}
