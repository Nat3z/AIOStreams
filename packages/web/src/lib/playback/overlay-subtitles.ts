import type { ServerSubtitle } from './engine';

/**
 * A server subtitle the page draws itself rather than as a `<track>`: a
 * styled script through libass, or pictures. Plain text stays a `<track>`.
 */
export type OverlayKind = 'ass' | 'pgs';

/** How often a subtitle the remux is still reading is checked on. */
const REFRESH_MS = 5_000;
/** It is asked for again once playback is this close to what was read. */
const LOOKAHEAD_S = 20;

/** The overlay a server subtitle takes, from the address the server gave it. */
export function overlayKind(subtitle: ServerSubtitle): OverlayKind | null {
  const path = subtitle.stream.DeliveryUrl?.split('?')[0] ?? '';
  if (/\/remux\/Stream\.ass$/i.test(path)) return 'ass';
  if (/\/remux\/Stream\.sup$/i.test(path)) return 'pgs';
  return null;
}

/** The subtitle's own address, which the page's `<track>` rewrite turns to WebVTT. */
function nativeUrl(subtitle: ServerSubtitle, kind: OverlayKind): URL {
  return new URL(
    subtitle.url.replace(
      /Stream\.vtt(?=\?|$)/,
      kind === 'ass' ? 'Stream.ass' : 'Stream.sup'
    )
  );
}

/** The version's fonts, which a styled script names and the file carries. */
async function attachedFonts(
  subtitle: ServerSubtitle,
  signal: AbortSignal
): Promise<string[]> {
  const url = new URL(subtitle.url);
  const list = new URL(
    url.pathname.replace(/\/Subtitles\/.*$/, '/Attachments') + url.search,
    url
  );
  const res = await fetch(list, { signal }).catch(() => null);
  if (!res?.ok) return [];
  const fonts = (await res.json()) as { index: number }[];
  return fonts.map((f) => {
    const font = new URL(list);
    font.pathname += `/${f.index}`;
    return font.href;
  });
}

interface Fetched {
  body: ArrayBuffer;
  readTo: number;
  complete: boolean;
}

/** The subtitle as far as the remux has read the file around `at`. */
async function fetchSubtitle(
  url: URL,
  at: number,
  signal: AbortSignal
): Promise<Fetched | null> {
  const asked = new URL(url);
  asked.searchParams.set('At', at.toFixed(3));
  const res = await fetch(asked, { signal }).catch(() => null);
  if (!res?.ok) return null;
  return {
    body: await res.arrayBuffer(),
    readTo: Number(res.headers.get('X-Read-To') ?? 0),
    complete: res.headers.get('X-Read-Complete') === '1',
  };
}

export interface Overlay {
  /** Moves the subtitle by `ms`, later when positive. */
  setDelay(ms: number): void;
  destroy(): void;
}

/** What either renderer does with each newer copy of the subtitle. */
interface Renderer {
  load(body: ArrayBuffer): Promise<void> | void;
  setDelay(ms: number): void;
  destroy(): void;
}

async function createRenderer(
  video: HTMLVideoElement,
  subtitle: ServerSubtitle,
  kind: OverlayKind,
  first: ArrayBuffer,
  delayMs: number,
  signal: AbortSignal
): Promise<Renderer | null> {
  if (kind === 'ass') {
    const [{ default: JASSUB }, fonts] = await Promise.all([
      import('jassub'),
      attachedFonts(subtitle, signal),
    ]);
    if (signal.aborted) return null;
    const text = (body: ArrayBuffer) => new TextDecoder().decode(body);
    const renderer = new JASSUB({
      video,
      subContent: text(first),
      fonts,
      // libass's offset runs the other way: a later subtitle is drawn earlier.
      timeOffset: -delayMs / 1000,
    });
    return {
      load: async (body) => {
        await renderer.ready;
        await renderer.renderer.setTrack(text(body));
      },
      setDelay: (ms) => (renderer.timeOffset = -ms / 1000),
      destroy: () => void renderer.destroy(),
    };
  }
  const { PgsRenderer } = await import('libpgs');
  if (signal.aborted) return null;
  const renderer = new PgsRenderer({
    workerUrl: new URL('libpgs/dist/libpgs.worker.js', import.meta.url).href,
    video,
  });
  renderer.timeOffset = -delayMs / 1000;
  // Its canvas is already over the video, so one that fails must go.
  await renderer.loadFromBuffer(first).catch((error: unknown) => {
    renderer.dispose();
    throw error;
  });
  return {
    load: (body) => renderer.loadFromBuffer(body),
    setDelay: (ms) => (renderer.timeOffset = -ms / 1000),
    destroy: () => renderer.dispose(),
  };
}

/**
 * Draws a styled or picture subtitle over `video`, on a canvas beside it.
 * The remux reads a subtitle as it reads the video, so this asks for it
 * again as playback moves past what was read, until it is all there.
 */
export async function startOverlay(
  video: HTMLVideoElement,
  subtitle: ServerSubtitle,
  kind: OverlayKind,
  delayMs: number,
  signal: AbortSignal
): Promise<Overlay | null> {
  const url = nativeUrl(subtitle, kind);
  const first = await fetchSubtitle(url, video.currentTime, signal);
  if (!first || signal.aborted) return null;
  const renderer = await createRenderer(
    video,
    subtitle,
    kind,
    first.body,
    delayMs,
    signal
  );
  if (!renderer) return null;
  let { readTo, complete } = first;
  let size = first.body.byteLength;
  let busy = false;
  const refresh = async () => {
    // Asks again once playback nears what was read, the remux having read
    // further by then, or once it seeks before or past it.
    const ahead = readTo - video.currentTime;
    if (complete || busy || ahead > LOOKAHEAD_S) return;
    busy = true;
    const next = await fetchSubtitle(url, video.currentTime, signal).catch(
      () => null
    );
    busy = false;
    if (!next || signal.aborted) return;
    ({ readTo, complete } = next);
    if (next.body.byteLength === size) return;
    size = next.body.byteLength;
    await renderer.load(next.body);
  };
  const timer = setInterval(() => void refresh(), REFRESH_MS);
  video.addEventListener('seeked', refresh);
  return {
    setDelay: renderer.setDelay,
    destroy: () => {
      clearInterval(timer);
      video.removeEventListener('seeked', refresh);
      renderer.destroy();
    },
  };
}
