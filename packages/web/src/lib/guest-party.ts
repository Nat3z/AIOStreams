import React from 'react';
import { useSession } from '@/lib/jellyfin/session';
import { useFeature } from '@/lib/jellyfin/server-info';
import { useGuestPass, useCanShare } from './guest';
import { partyKeys } from '@/lib/party/crypto';
import { relayBase } from '@/lib/party/invite';
import { playingEntry, useParty } from '@/lib/party/party';

/*
 * A guest's pass opens what its party plays now, so they can follow it onto
 * another title. Who shared it says so as the party moves on; their server
 * only listens for passes of their own, bound to that party.
 */

/** Once, in the layout of whoever may have shared a pass. */
export function useGuestPartyPlaying(): void {
  const { client } = useSession();
  const sharing = useCanShare();
  const state = useParty();
  const here = !!state && state.invite.relay === relayBase(client.base);
  const entry = sharing && here ? playingEntry(state) : null;
  const itemId = entry?.item?.id ?? null;
  const code = sharing && here ? state.invite.code : null;
  const told = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!code) return;
    const key = `${code}|${itemId ?? ''}`;
    if (told.current === key) return;
    told.current = key;
    void partyKeys(code)
      .then(({ id }) =>
        client.post('/AIOStreams/GuestPasses/Playing', {
          Party: id,
          ItemId: itemId,
        })
      )
      .catch(() => {
        told.current = null;
      });
  }, [client, code, itemId]);
}
