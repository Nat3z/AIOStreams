import React from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { toast } from 'sonner';
import { LuLink, LuQrCode, LuShare2 } from 'react-icons/lu';
import { Drawer } from '@aiostreams/ui/drawer';
import { Button, IconButton } from '@aiostreams/ui/button';
import { Switch } from '@aiostreams/ui/switch';
import { TextInput } from '@aiostreams/ui/text-input';
import { cn } from '@aiostreams/ui/core/styling';
import { copyToClipboard } from '@aiostreams/ui/utils/clipboard';
import { currentHost } from '@/lib/hosts';
import { useRestoreFocus } from '@/lib/input';
import { useSession } from '@/lib/jellyfin/session';
import { fullTitle } from '@/lib/format';
import { formatLocale } from '@/lib/i18n';
import {
  guestLinkUrl,
  useCreatePass,
  useOwnedPasses,
  type OwnedPass,
} from '@/lib/guest';
import { usePartyActions, usePartyRelays } from '@/lib/party/actions';
import { partyKeys } from '@/lib/party/crypto';
import { relayBase, type Invite } from '@/lib/party/invite';
import { party, useParty } from '@/lib/party/party';
import type { BaseItemDto } from '@/lib/jellyfin/types';
import { PillTabs } from './pill-tabs';
import { QrCode } from '@/features/party/qr-code';

/*
 * Makes a guest link: someone without an account watches the title through
 * this configuration, until it expires, and can join a party with it.
 */

interface Opening {
  item: BaseItemDto;
  /** The season on show, which a show's link can be narrowed to. */
  season?: BaseItemDto;
}

let sheet: { open: boolean; opening: Opening | null } = {
  open: false,
  opening: null,
};
const listeners = new Set<() => void>();

function setSheet(next: Partial<typeof sheet>): void {
  sheet = { ...sheet, ...next };
  for (const listener of listeners) listener();
}

export const openGuestShare = (opening: Opening) =>
  setSheet({ open: true, opening });

const closeGuestShare = () => setSheet({ open: false });

function useSheet() {
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => sheet
  );
}

const GUTTER = 'ps-4 pe-[max(1rem,env(safe-area-inset-right))]';

export function GuestShareSheet() {
  const { open, opening } = useSheet();
  const restoreFocus = useRestoreFocus(open);
  return (
    <Drawer
      data-ui="dialog"
      data-name="guest-share"
      open={open}
      onOpenChange={(next) => !next && closeGuestShare()}
      onCloseAutoFocus={restoreFocus}
      title={t`Share with a guest`}
      side="right"
      size="sm"
      overlayClass="bg-black/40"
      contentClass="flex flex-col gap-0 overflow-hidden p-0"
      headerClass={cn(GUTTER, 'pb-3 pt-[calc(1rem+env(safe-area-inset-top))]')}
      closeClass="end-[max(0.5rem,env(safe-area-inset-right))] top-[calc(0.75rem+env(safe-area-inset-top))]"
    >
      <div
        data-nav-group
        className={cn(
          GUTTER,
          'min-h-0 flex-1 overflow-y-auto pb-[calc(1rem+env(safe-area-inset-bottom))]'
        )}
      >
        {/* Keyed, so a new title starts a new form. */}
        {opening && <ShareForm key={opening.item.Id} opening={opening} />}
      </div>
    </Drawer>
  );
}

function Section({
  title,
  children,
  name,
}: {
  title?: string;
  children: React.ReactNode;
  name: string;
}) {
  return (
    <section
      data-ui="guest-section"
      data-name={name}
      className="space-y-3 py-4"
    >
      {title && (
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[--muted]">
          {title}
        </h3>
      )}
      {children}
    </section>
  );
}

const lifetimeLabel = (hours: number) =>
  hours % 24 === 0
    ? plural(hours / 24, { one: '# day', other: '# days' })
    : plural(hours, { one: '# hour', other: '# hours' });

function ShareForm({ opening }: { opening: Opening }) {
  const { client } = useSession();
  const passes = useOwnedPasses();
  const create = useCreatePass();
  const actions = usePartyActions();
  const relays = usePartyRelays();
  const state = useParty();
  const own = relayBase(client.base);
  // A guest's pass opens the party only on this server's relay, which knows the pass.
  const ownRelay = relays.find((r) => r.own);
  const partyHere = !!state && state.invite.relay === own;
  const limits = passes.data?.Limits;
  const [hours, setHours] = React.useState<number | null>(null);
  const [people, setPeople] = React.useState(2);
  const [together, setTogether] = React.useState(!!ownRelay);
  const [scope, setScope] = React.useState<'show' | 'season'>('show');
  const [label, setLabel] = React.useState('');
  const [made, setMade] = React.useState<{
    pass: OwnedPass;
    url: string;
  } | null>(null);

  const { item, season } = opening;
  const target =
    item.Type === 'Series' && scope === 'season' && season ? season : item;
  const title = fullTitle(target);
  const lifetime = hours ?? limits?.LifetimesHours[0] ?? 24;
  const maxPeople = limits?.MaxStreams ?? 5;

  const make = async () => {
    try {
      let invite: Invite | null = null;
      if (together && ownRelay) {
        if (!partyHere) await actions.start(ownRelay.base);
        invite = party.state()?.invite ?? null;
      }
      const partyId = invite ? (await partyKeys(invite.code)).id : undefined;
      const pass = await create.mutateAsync({
        itemId: target.Id!,
        hours: lifetime,
        maxStreams: people,
        label: label.trim() || undefined,
        party: partyId,
      });
      setMade({ pass, url: guestLinkUrl(client.base, pass.Code, invite) });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t`Could not make the link`
      );
    }
  };

  if (made) return <Made pass={made.pass} url={made.url} />;

  if (passes.data && !passes.data.CanCreate)
    return (
      <Section name="no-proxy">
        <p className="rounded-xl bg-white/5 p-3 text-sm text-[--muted]">
          <Trans>
            A guest watches through this configuration's proxy, so the debrid
            service only ever sees one address. Set up a proxy on the
            configuration page first.
          </Trans>
        </p>
      </Section>
    );

  return (
    <>
      <Section name="what">
        <p className="text-sm">
          <Trans>
            Anyone with the link can watch{' '}
            <span className="font-semibold">{title}</span> without an account,
            through your configuration.
          </Trans>
        </p>
        {item.Type === 'Series' && season && (
          <PillTabs
            name="guest-scope"
            options={[
              { value: 'show' as const, label: t`Whole show` },
              {
                value: 'season' as const,
                label: season.Name ?? t`This season`,
              },
            ]}
            value={scope}
            onChange={setScope}
          />
        )}
      </Section>
      <Section name="lifetime" title={t`Lasts`}>
        <PillTabs
          name="guest-lifetime"
          options={(limits?.LifetimesHours ?? [24]).map((h) => ({
            value: h,
            label: lifetimeLabel(h),
          }))}
          value={lifetime}
          onChange={setHours}
        />
      </Section>
      <Section name="people" title={t`Devices at once`}>
        <PillTabs
          name="guest-people"
          options={Array.from({ length: maxPeople }, (_, i) => ({
            value: i + 1,
            label: String(i + 1),
          }))}
          value={Math.min(people, maxPeople)}
          onChange={setPeople}
        />
        <p className="text-xs text-[--muted]">
          <Trans>
            Anyone can open the link, so this caps how many play at once.
          </Trans>
        </p>
      </Section>
      {ownRelay && (
        <Section name="together">
          <Switch
            side="right"
            label={t`Watch together`}
            help={
              partyHere
                ? t`The link brings them into the party you're in.`
                : t`Starts a party here, which the link brings them into.`
            }
            value={together}
            onValueChange={setTogether}
          />
        </Section>
      )}
      <Section name="label">
        <TextInput
          label={t`Label`}
          placeholder={t`For Alex`}
          help={t`Only you see it, in Settings, to tell links apart.`}
          value={label}
          onValueChange={setLabel}
          maxLength={64}
        />
      </Section>
      <Section name="make">
        <Button
          intent="white"
          className="w-full rounded-full"
          loading={create.isPending}
          disabled={!passes.data}
          onClick={() => void make()}
        >
          <Trans>Make the link</Trans>
        </Button>
      </Section>
    </>
  );
}

function Made({ pass, url }: { pass: OwnedPass; url: string }) {
  const [showQr, setShowQr] = React.useState(!!currentHost().tv);
  const until = new Date(pass.ExpiresAt).toLocaleString(formatLocale(), {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    <Section name="made" title={t`Link`}>
      <div className="space-y-2 rounded-xl bg-white/5 p-4 text-center">
        <p className="text-sm font-semibold">{pass.ItemName}</p>
        <p className="text-xs text-[--muted]">
          {pass.Party ? t`Until ${until}, with your party` : t`Until ${until}`}
        </p>
        {showQr && (
          <div className="mx-auto mt-2 w-44 overflow-hidden rounded-lg">
            <QrCode text={url} className="h-auto w-full" />
          </div>
        )}
      </div>
      <p className="text-xs text-[--muted]">
        <Trans>
          The link is shown only now. You can end it any time in Settings.
        </Trans>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          intent="white"
          size="sm"
          className="rounded-full"
          leftIcon={<LuLink />}
          onClick={() =>
            copyToClipboard(url, {
              onSuccess: () => toast.success(t`Link copied`),
              onError: () => toast.error(t`Could not copy the link`),
            })
          }
        >
          <Trans>Copy link</Trans>
        </Button>
        <Button
          intent="gray-outline"
          size="sm"
          className="rounded-full"
          leftIcon={<LuQrCode />}
          onClick={() => setShowQr((v) => !v)}
        >
          {showQr ? t`Hide QR code` : t`QR code`}
        </Button>
        {typeof navigator.share === 'function' && (
          <IconButton
            intent="gray-outline"
            size="sm"
            className="rounded-full"
            icon={<LuShare2 />}
            aria-label={t`Share the link`}
            onClick={() =>
              void navigator
                .share({ title: pass.ItemName, url })
                .catch(() => {})
            }
          />
        )}
      </div>
    </Section>
  );
}
