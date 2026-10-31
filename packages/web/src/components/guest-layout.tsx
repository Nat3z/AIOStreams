import React from 'react';
import { t } from '@lingui/core/macro';
import {
  Outlet,
  useChildMatches,
  useRouterState,
} from '@tanstack/react-router';
import { BiCog, BiGroup } from 'react-icons/bi';
import { IconButton } from '@aiostreams/ui/button';
import { Tooltip } from '@aiostreams/ui/tooltip';
import { cn } from '@aiostreams/ui/core/styling';
import { navigate, to } from '@/lib/paths';
import { useParty } from '@/lib/party/party';
import type { GuestPassInfo } from '@/lib/guest';
import { usePendingStops } from '@/lib/playback/reporter';
import { GuestChip } from '@/app/guest/page';
import { VersionPickerProvider } from '@/features/versions/version-picker';
import { ItemMenuHost } from '@/components/media/item-menu';
import { GlideLayers } from '@/components/shell/glide-layers';
import { PageStack } from '@/components/shell/page-stack';
import { PartyHost } from '@/features/party/party-host';
import { openPartySheet } from '@/features/party/sheet-state';

/**
 * The app as a guest sees it: the shared title and its player, with no
 * libraries, search or account around them. Home is the shared title.
 */
export function GuestLayout({ pass }: { pass: GuestPassInfo }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const playing = useChildMatches({
    select: (matches) => !!matches[0]?.pathname.startsWith('/play/'),
  });
  usePendingStops();
  const inParty = !!useParty();
  // Anywhere but the title, its player and settings goes back to the title.
  const allowed =
    pathname.startsWith('/item/') ||
    pathname.startsWith('/play/') ||
    pathname.startsWith('/settings');
  React.useEffect(() => {
    if (!allowed) navigate(to.item(pass.ItemId), { replace: true });
  }, [allowed, pass.ItemId]);

  return (
    <>
      <div
        data-ui="shell"
        data-guest
        inert={playing}
        className={cn(playing && 'invisible [content-visibility:hidden]')}
      >
        <div
          data-ui="guest-bar"
          className="fixed inset-x-0 top-0 z-30 flex items-center justify-between gap-2 px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] lg:px-10"
        >
          <GuestChip pass={pass} />
          <div className="flex items-center gap-2">
            <Tooltip
              trigger={
                <IconButton
                  intent="gray-subtle"
                  className="rounded-full backdrop-blur"
                  icon={<BiGroup />}
                  aria-label={inParty ? t`Watch party` : t`Watch together`}
                  onClick={() => openPartySheet()}
                />
              }
            >
              {inParty ? t`Watch party` : t`Watch together`}
            </Tooltip>
            <Tooltip
              trigger={
                <IconButton
                  intent="gray-subtle"
                  className="rounded-full backdrop-blur"
                  icon={<BiCog />}
                  aria-label={t`Settings`}
                  onClick={() =>
                    navigate(
                      pathname.startsWith('/settings')
                        ? to.item(pass.ItemId)
                        : to.settings()
                    )
                  }
                />
              }
            >
              {t`Settings`}
            </Tooltip>
          </div>
        </div>
        <VersionPickerProvider>
          <ItemMenuHost>
            <GlideLayers name="page">
              {allowed && (
                <PageStack
                  className="relative ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)] lg:ps-10"
                  covered={playing}
                />
              )}
            </GlideLayers>
          </ItemMenuHost>
        </VersionPickerProvider>
      </div>
      {playing && <Outlet />}
      <PartyHost />
    </>
  );
}
