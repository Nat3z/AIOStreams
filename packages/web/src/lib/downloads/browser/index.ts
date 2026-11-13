import type { DownloadsHost, HostEvent, HostJob } from '../types';
import type { FromWorker, SaveFile } from './messages';

/*
 * Downloads for a browser with no app around it, an installed web app above
 * all: the worker saves into the origin's private storage, which the player
 * opens offline. Only while the page is open, as a browser runs no download
 * for a page it closed; an unfinished one carries on when it opens again.
 */

type JobState = 'queued' | 'downloading' | 'paused' | 'failed' | 'done';

interface Job {
  job: HostJob;
  state: JobState;
  bytes: number;
  total: number | null;
  error: string | null;
  /** Failed for the connection, which coming back to the app tries again. */
  lost?: boolean;
}

const STORE = 'aiostreams-web-browser-downloads';
const ROOT = 'downloads';

let jobs: Job[] = load();
let concurrent = 1;
let worker: Worker | null = null;
const listeners = new Set<(event: HostEvent) => void>();
/** Times in a row each download's connection dropped. */
const tries = new Map<string, number>();
const RETRIES = 5;
/** Bytes a second of each running download, measured between reports. */
const lastReport = new Map<string, { bytes: number; at: number }>();

function load(): Job[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? '[]') as Job[];
    // A download the page was closed in the middle of waits its turn again.
    return saved.map((j) =>
      j.state === 'downloading' ? { ...j, state: 'queued' } : j
    );
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(jobs));
  } catch {}
}

const pathOf = (job: HostJob, path: string) => `${ROOT}/${job.id}/${path}`;

const videoOf = (job: HostJob) => job.files.find((f) => f.kind === 'video');

function emit(event: HostEvent): void {
  listeners.forEach((l) => l(event));
}

function announce(): void {
  persist();
  emit({
    type: 'state',
    folder: '',
    jobs: jobs.map((j) => {
      const video = videoOf(j.job);
      return {
        id: j.job.id,
        state: j.state,
        bytes: j.bytes,
        total: j.total,
        error: j.error,
        ...(j.state === 'done' && {
          video: video && pathOf(j.job, video.path),
          subtitles: j.job.files
            .filter((f) => f.kind === 'subtitle')
            .map((f) => pathOf(j.job, f.path)),
        }),
      };
    }),
  });
}

function workerOf(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url));
  worker.onmessage = (e: MessageEvent<FromWorker>) => onWorker(e.data);
  return worker;
}

function update(id: string, patch: Partial<Job>): void {
  jobs = jobs.map((j) => (j.job.id === id ? { ...j, ...patch } : j));
}

function onWorker(m: FromWorker): void {
  if (m.type === 'progress') {
    const now = performance.now();
    const last = lastReport.get(m.id);
    lastReport.set(m.id, { bytes: m.bytes, at: now });
    const speed =
      last && now > last.at
        ? ((m.bytes - last.bytes) * 1000) / (now - last.at)
        : 0;
    const job = jobs.find((j) => j.job.id === m.id);
    const total = m.total ?? job?.total ?? null;
    update(m.id, { bytes: m.bytes, total });
    emit({ type: 'progress', id: m.id, bytes: m.bytes, total, speed });
    return;
  }
  lastReport.delete(m.id);
  if (m.type !== 'failed') tries.delete(m.id);
  if (m.type === 'done')
    update(m.id, {
      state: 'done',
      bytes: m.bytes,
      total: m.bytes,
      error: null,
    });
  else if (m.type === 'failed' && m.lost && (tries.get(m.id) ?? 0) < RETRIES) {
    // A dropped connection, as when the phone puts the app away, goes on from there.
    tries.set(m.id, (tries.get(m.id) ?? 0) + 1);
    update(m.id, { state: 'queued', bytes: m.bytes });
  } else if (m.type === 'failed')
    update(m.id, {
      state: 'failed',
      bytes: m.bytes,
      error: m.error,
      lost: m.lost,
    });
  else if (jobs.find((j) => j.job.id === m.id)?.state === 'downloading')
    update(m.id, { state: 'paused', bytes: m.bytes });
  announce();
  pump();
}

/** Starts what waits while fewer than `concurrent` run. */
function pump(): void {
  let free = concurrent - jobs.filter((j) => j.state === 'downloading').length;
  for (const j of jobs) {
    if (free <= 0) break;
    if (j.state !== 'queued') continue;
    free--;
    update(j.job.id, { state: 'downloading', error: null });
    const files: SaveFile[] = j.job.files.map((f) => ({
      url: f.url,
      path: pathOf(j.job, f.path),
      skips: f.kind === 'video' && /\/Export\.mp4(\?|$)/.test(f.url),
    }));
    workerOf().postMessage({ type: 'start', id: j.job.id, files });
  }
  announce();
  // Saved files are kept when space runs low, rather than cleared first.
  if (jobs.length) void navigator.storage?.persist?.().catch(() => {});
}

function stop(id: string): void {
  worker?.postMessage({ type: 'stop', id });
}

async function fileAt(path: string): Promise<File> {
  const parts = path.split('/');
  let dir = await navigator.storage.getDirectory();
  for (const name of parts.slice(0, -1))
    dir = await dir.getDirectoryHandle(name);
  return (await dir.getFileHandle(parts[parts.length - 1])).getFile();
}

/**
 * Where the browser can keep files of its own. The sync handles the worker
 * writes through exist only in workers, so the page checks for the private
 * file system itself.
 */
export function canSaveInBrowser(): boolean {
  return (
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof Worker === 'function' &&
    typeof (globalThis as { FileSystemFileHandle?: unknown })
      .FileSystemFileHandle === 'function'
  );
}

// Back in front, or back online, what the drop stopped starts again.
const again = () => {
  if (document.visibilityState !== 'visible') return;
  let woke = false;
  for (const j of jobs)
    if (j.state === 'failed' && j.lost) {
      update(j.job.id, { state: 'queued', error: null, lost: false });
      woke = true;
    }
  if (woke) pump();
};
document.addEventListener('visibilitychange', again);
window.addEventListener('online', again);

export const browserDownloads: DownloadsHost = {
  add(added) {
    const known = new Set(jobs.map((j) => j.job.id));
    const fresh = added.filter((job) => !known.has(job.id));
    jobs = [
      ...jobs,
      ...fresh.map((job) => ({
        job,
        state: 'queued' as const,
        bytes: 0,
        total: job.size ?? null,
        error: null,
      })),
    ];
    pump();
  },
  control(id, action) {
    const job = jobs.find((j) => j.job.id === id);
    if (!job) return;
    if (action === 'pause') {
      if (job.state === 'downloading') stop(id);
      else if (job.state === 'queued') update(id, { state: 'paused' });
    } else if (job.state === 'paused' || job.state === 'failed') {
      update(id, { state: 'queued', error: null });
    }
    pump();
  },
  remove(id, files) {
    const job = jobs.find((j) => j.job.id === id);
    if (!job) return;
    if (job.state === 'downloading') stop(id);
    jobs = jobs.filter((j) => j.job.id !== id);
    if (files)
      workerOf().postMessage({
        type: 'delete',
        paths: job.job.files.map((f) => pathOf(job.job, f.path)),
      });
    pump();
  },
  list: () => announce(),
  configure(opts) {
    concurrent = opts.concurrent;
    pump();
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  playable: {
    async open(path) {
      return URL.createObjectURL(await fileAt(path));
    },
    release: (url) => URL.revokeObjectURL(url),
    async share({ id, title }) {
      const job = jobs.find((j) => j.job.id === id);
      const video = job && videoOf(job.job);
      if (!job || !video) return;
      const file = await fileAt(pathOf(job.job, video.path));
      const named = new File([file], `${title}.mp4`, { type: 'video/mp4' });
      if (navigator.canShare?.({ files: [named] }))
        return navigator.share({ files: [named], title });
      // Without a share sheet, as on a computer, the browser saves it.
      const url = URL.createObjectURL(named);
      const link = document.createElement('a');
      link.href = url;
      link.download = named.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  },
};
