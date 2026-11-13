import type { FromWorker, SaveFile, ToWorker } from './messages';

/*
 * Saves downloads into the origin's private file system, written through a
 * sync handle as they arrive, so a film never has to fit in memory. Safari
 * only writes OPFS files from a worker.
 */

const scope = self as unknown as Worker;

/** Only in a worker, which the page's DOM types leave out. */
interface SyncHandle {
  getSize(): number;
  truncate(size: number): void;
  write(data: Uint8Array, opts: { at: number }): number;
  flush(): void;
  close(): void;
}

const syncHandle = (file: FileSystemFileHandle) =>
  (
    file as FileSystemFileHandle & {
      createSyncAccessHandle(): Promise<SyncHandle>;
    }
  ).createSyncAccessHandle();
const running = new Map<string, AbortController>();

const post = (message: FromWorker) => scope.postMessage(message);

async function fileAt(
  path: string,
  create: boolean
): Promise<FileSystemFileHandle> {
  const parts = path.split('/');
  let dir = await navigator.storage.getDirectory();
  for (const name of parts.slice(0, -1))
    dir = await dir.getDirectoryHandle(name, { create });
  return dir.getFileHandle(parts[parts.length - 1], { create });
}

/** A server's answer, not a dropped connection, which trying again won't change. */
class Refused extends Error {}

/** The server's own words where it gave some, as for a version it can't export. */
async function refusal(res: Response): Promise<Error> {
  const said = await res
    .json()
    .then((body: { Message?: string }) => body.Message)
    .catch(() => undefined);
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a worker has no catalog
  return new Refused(said ?? `the server answered ${res.status}`);
}

/** Appends the rest of `file` to what is already saved; returns its size. */
async function save(
  file: SaveFile,
  signal: AbortSignal,
  progress: (bytes: number, total: number | null) => void
): Promise<number> {
  const handle = await syncHandle(await fileAt(file.path, true));
  try {
    const have = handle.getSize();
    const url = new URL(file.url);
    const headers: Record<string, string> = {};
    if (have && file.skips) url.searchParams.set('Skip', String(have));
    else if (have) headers.Range = `bytes=${have}-`;
    const res = await fetch(url, { headers, signal });
    // A finished file answers a range past its end so.
    if (res.status === 416) return have;
    if (!res.ok || !res.body) throw await refusal(res);
    // A host that ignores the range sends it all again.
    let at = have && !file.skips && res.status !== 206 ? 0 : have;
    if (!at) handle.truncate(0);
    const length = Number(res.headers.get('content-length')) || 0;
    const total = length ? at + length : null;
    const reader = res.body.getReader();
    let reported = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      handle.write(value, { at });
      at += value.length;
      if (at - reported >= 1 << 20) {
        reported = at;
        handle.flush();
        progress(at, total);
      }
    }
    handle.flush();
    if (total && at < total) throw new Error('the download stopped early');
    return at;
  } finally {
    handle.close();
  }
}

async function start(id: string, files: SaveFile[]) {
  const abort = new AbortController();
  running.set(id, abort);
  let before = 0;
  try {
    for (const file of files) {
      before += await save(file, abort.signal, (bytes, total) =>
        post({
          type: 'progress',
          id,
          bytes: before + bytes,
          total: total && before + total,
        })
      );
    }
    post({ type: 'done', id, bytes: before });
  } catch (error) {
    post(
      abort.signal.aborted
        ? { type: 'stopped', id, bytes: before }
        : {
            type: 'failed',
            id,
            bytes: before,
            error: error instanceof Error ? error.message : String(error),
            lost: !(error instanceof Refused),
          }
    );
  } finally {
    if (running.get(id) === abort) running.delete(id);
  }
}

async function remove(paths: string[]) {
  for (const path of paths) {
    const parts = path.split('/');
    try {
      let dir = await navigator.storage.getDirectory();
      for (const name of parts.slice(0, -1))
        dir = await dir.getDirectoryHandle(name);
      await dir.removeEntry(parts[parts.length - 1]);
    } catch {}
  }
}

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'start') void start(m.id, m.files);
  else if (m.type === 'stop') running.get(m.id)?.abort();
  else void remove(m.paths);
};
