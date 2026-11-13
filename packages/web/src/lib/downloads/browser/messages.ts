/** A file the worker saves under the page's own storage, at `path`. */
export interface SaveFile {
  url: string;
  path: string;
  /** The export, which answers a resume by skipping rather than with a range. */
  skips: boolean;
}

export type ToWorker =
  | { type: 'start'; id: string; files: SaveFile[] }
  | { type: 'stop'; id: string }
  | { type: 'delete'; paths: string[] };

export type FromWorker =
  | { type: 'progress'; id: string; bytes: number; total: number | null }
  | { type: 'done'; id: string; bytes: number }
  /** `lost` for the connection, rather than the server refusing. */
  | { type: 'failed'; id: string; bytes: number; error: string; lost: boolean }
  /** Stopped as asked, with what it has so far. */
  | { type: 'stopped'; id: string; bytes: number };
