import React from 'react';
import { t } from '@lingui/core/macro';
import { useSession } from '../../lib/session';
import { useLibraryHeads, useViews } from '../../lib/queries';
import { backdropUrl, posterUrl } from '../../lib/images';

/*
 * A section's example: a mock of what its quick answers change, held beside
 * them on wide screens and above them on narrow ones. Pointing at an answer
 * draws it before it's picked.
 */

export interface ExampleQuestion {
  id: string;
  title: string;
  body: React.ReactNode;
  /** Called when the question is pointed at or focused. */
  onAt(): void;
}

export function Example({
  frame,
  note,
  peeking,
  questions,
}: {
  frame: React.ReactNode;
  /** What the example shows, in words. */
  note: string;
  peeking: boolean;
  questions: ExampleQuestion[];
}) {
  return (
    <div
      data-ui="settings-example"
      className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr),minmax(0,3fr)] lg:gap-10"
    >
      <div className="space-y-2 lg:sticky lg:top-6 lg:order-last lg:h-fit">
        {frame}
        <p className="min-h-10 text-sm text-[--muted]">
          {peeking && (
            <span className="me-1.5 font-medium text-[--brand]">
              {t`If you pick it:`}
            </span>
          )}
          {note}
        </p>
      </div>
      <div className="space-y-5">
        {questions.map((q) => (
          <div
            key={q.id}
            onPointerEnter={q.onAt}
            onFocusCapture={q.onAt}
            className="space-y-2"
          >
            <p className="text-sm font-semibold">{q.title}</p>
            {q.body}
          </div>
        ))}
      </div>
    </div>
  );
}

export interface Art {
  name: string;
  year?: number | null;
  poster: string | null;
  backdrop: string | null;
}

/** Titles from the user's first libraries to draw examples with; none until they load, or on an empty server. */
export function useArt(): Art[] {
  const { client } = useSession();
  const views = useViews();
  const heads = useLibraryHeads((views.data?.Items ?? []).slice(0, 2), 8);
  return heads.flatMap((head) =>
    (head.data?.Items ?? []).map((item) => ({
      name: item.Name ?? '',
      year: item.ProductionYear,
      poster: posterUrl(client, item, { maxWidth: 160 }),
      backdrop: backdropUrl(client, item, { maxWidth: 960 }),
    }))
  );
}

/** An image as a CSS background, or nothing so the placeholder colour shows. */
export const cover = (url: string | null | undefined) =>
  url ? { backgroundImage: `url("${url}")` } : undefined;
