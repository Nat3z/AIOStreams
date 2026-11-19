import React from 'react';
import type { IconType } from 'react-icons';
import { Card } from '@aiostreams/ui/card';
import { cn } from '@aiostreams/ui/core/styling';
import { t } from '@lingui/core/macro';
import { useSettingsLayer, type Layer } from '@/lib/settings';

const fold = (text: string) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export const searchWords = (query: string): string[] =>
  fold(query).split(/\s+/).filter(Boolean);

export const hasWords = (
  text: string | null | undefined,
  words: readonly string[]
) => {
  const folded = fold(text ?? '');
  return words.every((word) => folded.includes(word));
};

export const SettingsSearch = React.createContext<readonly string[]>([]);

/**
 * Where a card's settings are kept: with the profile, on the device with a
 * default for every device, or on the device alone. The server's playback
 * preferences are the profile's too, and reach other Jellyfin apps.
 */
export type Holds = 'profile' | 'server' | 'device' | 'local';

/** Another profile's settings are the profile's alone; everyone's also hold device defaults. */
export function holdsIn(layer: Layer | null, holds: Holds | undefined) {
  if (!layer) return true;
  return (
    holds === 'profile' ||
    holds === 'server' ||
    (layer.everyone && holds === 'device')
  );
}

export function holdsText(layer: Layer | null, holds: Holds, locked?: boolean) {
  if (holds === 'device' || holds === 'local') {
    return layer?.everyone
      ? t`The default for every device. A device that changes it keeps its own.`
      : t`Kept on this device.`;
  }
  if (layer?.everyone)
    return t`The default for every profile. A profile that changes it keeps its own.`;
  if (layer) return t`Saved to this profile, on every device it signs in on.`;
  if (holds === 'server')
    return locked
      ? t`This server doesn't let your account change these.`
      : t`Saved to your account, so your other devices and Jellyfin apps use it too.`;
  return t`Saved to your account, so it follows you to every device.`;
}

/**
 * Hides the lines under `root` that the search's words miss, and `root` when
 * none are left. By the text each line shows, so a search covers whatever this
 * device lists.
 */
export function useSearchHiding(
  root: React.RefObject<HTMLElement | null>,
  title: string | undefined,
  lines: string
) {
  const words = React.useContext(SettingsSearch);
  React.useLayoutEffect(() => {
    const card = root.current;
    if (!card || !words.length) return;
    const items = [...card.querySelectorAll<HTMLElement>(lines)];
    const whole = hasWords(title, words);
    for (const item of items)
      item.hidden = !whole && !hasWords(item.textContent, words);
    card.hidden = items.every((item) => item.hidden);
    return () => {
      card.hidden = false;
      for (const item of items) item.hidden = false;
    };
  });
}

export function SettingsCard({
  name,
  title,
  description,
  holds,
  locked,
  plain,
  children,
}: {
  /** `data-name`, which custom CSS matches, so it stays in English. */
  name?: string;
  title?: string;
  description?: React.ReactNode;
  holds?: Holds;
  /** The server keeps the profile from changing what it holds. */
  locked?: boolean;
  /** Says nothing of where it is kept, as the card before it does. */
  plain?: boolean;
  children: React.ReactNode;
}) {
  const layer = useSettingsLayer();
  const root = React.useRef<HTMLDivElement>(null);
  useSearchHiding(root, title, '[data-ui=settings-card-item]');
  if (!holdsIn(layer, holds)) return null;
  const where = holds && !plain && holdsText(layer, holds, locked);
  if (where)
    description = description ? (
      <>
        {description} {where}
      </>
    ) : (
      where
    );
  return (
    <div
      ref={root}
      data-ui="settings-card"
      data-name={name}
      className="space-y-3"
    >
      {(title || description) && (
        <div>
          {title && (
            <p data-ui="settings-card-title" className="font-semibold">
              {title}
            </p>
          )}
          {description && (
            <p
              data-ui="settings-card-description"
              className="text-sm text-[--muted]"
            >
              {description}
            </p>
          )}
        </div>
      )}
      <Card
        data-ui="settings-card-body"
        className="divide-y-2 divide-gray-700/40 overflow-clip rounded-xl border-white/[0.08] bg-transparent"
      >
        {React.Children.map(children, (child) =>
          child ? (
            <div
              data-ui="settings-card-item"
              className="px-4 py-3.5 transition-colors hover:bg-gray-900 empty:hidden"
            >
              {child}
            </div>
          ) : null
        )}
      </Card>
    </div>
  );
}

/** The open section's title; `leading` (a back button) takes the icon's place. */
export function SettingsPageHeader({
  title,
  description,
  icon: Icon,
  leading,
}: {
  title: string;
  description: string;
  icon?: IconType;
  leading?: React.ReactNode;
}) {
  const lead =
    leading ??
    (Icon && (
      <div className="rounded-lg border border-brand-500/15 bg-gradient-to-br from-brand-500/10 to-purple-500/10 p-2">
        <Icon className="text-2xl text-brand-400" />
      </div>
    ));
  return (
    <div data-ui="settings-header" className="flex items-center gap-3">
      {lead}
      <div>
        <h2 data-ui="section-title" className="text-xl font-semibold">
          {title}
        </h2>
        <p
          data-ui="settings-header-description"
          className="text-sm text-[--muted]"
        >
          {description}
        </p>
      </div>
    </div>
  );
}

export function SettingsRow({
  label,
  help,
  children,
  className,
}: {
  label: React.ReactNode;
  help?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6',
        className
      )}
    >
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label}</p>
        {help && <p className="text-sm text-[--muted]">{help}</p>}
      </div>
      <div className="flex-none">{children}</div>
    </div>
  );
}
