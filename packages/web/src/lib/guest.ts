import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JellyfinClient } from '@/lib/jellyfin/client';
import { useSession } from '@/lib/jellyfin/session';
import { storage } from './storage';
import { parseInvite, type Invite } from '@/lib/party/invite';
import type { AuthenticationResult } from '@/lib/jellyfin/types';

/*
 * A guest pass: a link that lets someone without an account watch one title
 * on its owner's configuration. The link is `#/guest?pass=<code>`, with the
 * party's invite after it when it carries one; the fragment never reaches a
 * server.
 */

export interface GuestPassInfo {
  Id: string;
  ItemId: string;
  ItemName: string;
  ExpiresAt: number;
  MaxStreams: number;
}

/** What the owner sees of a pass they made. */
export interface OwnedPass extends GuestPassInfo {
  Label: string | null;
  CreatedAt: number;
  Party: boolean;
  Watching: number;
}

export interface OwnedPasses {
  Passes: OwnedPass[];
  /** False until the configuration has a proxy to send guests through. */
  CanCreate: boolean;
  Limits: { MaxActive: number; MaxStreams: number; LifetimesHours: number[] };
}

export interface GuestLink {
  code: string;
  invite: Invite | null;
}

/** A guest link this page was opened with. */
export function guestLink(): GuestLink | null {
  const [path, query = ''] = window.location.hash.slice(1).split('?');
  if (path !== '/guest') return null;
  const params = new URLSearchParams(query);
  const code = params.get('pass');
  if (!code) return null;
  const party = params.get('party');
  const relay = params.get('relay');
  return {
    code,
    invite: party && relay ? parseInvite(party, relay) : null,
  };
}

export function guestLinkUrl(
  base: string,
  code: string,
  invite?: Invite | null
): string {
  const params = new URLSearchParams({ pass: code });
  if (invite) {
    params.set('party', invite.code);
    params.set('relay', invite.relay);
  }
  return `${base}/web/#/guest?${params}`;
}

const PASS_KEY = (base: string) => `aiostreams-web-guest:${base}`;
const NAME_KEY = 'aiostreams-web-guest-name';

/** The pass this device watches on here, kept beside its sign-in. */
export const savedPass = (base: string) =>
  storage.get<GuestPassInfo>(PASS_KEY(base));

export const forgetPass = (base: string) => storage.remove(PASS_KEY(base));

export async function signInAsGuest(
  anonymous: JellyfinClient,
  code: string
): Promise<AuthenticationResult & { Pass: GuestPassInfo }> {
  const auth = await anonymous.post<
    AuthenticationResult & { Pass: GuestPassInfo }
  >('/AIOStreams/Guest', { Code: code });
  storage.set(PASS_KEY(anonymous.base), auth.Pass);
  return auth;
}

/** The name a guest goes by in a party, asked once on this device. */
export const guestName = () => storage.get<string>(NAME_KEY);
export const setGuestName = (name: string) => storage.set(NAME_KEY, name);

/** The pass this session watches on, or null when it is someone's own account. */
export function useGuestPass(): GuestPassInfo | null {
  const { client } = useSession();
  return React.useMemo(
    () => (client.token ? (savedPass(client.base) ?? null) : null),
    [client]
  );
}

export function useOwnedPasses(enabled = true) {
  const { client, user } = useSession();
  return useQuery({
    queryKey: ['jf', client.base, user.Id, 'guest-passes'],
    queryFn: () => client.get<OwnedPasses>('/AIOStreams/GuestPasses'),
    enabled,
    staleTime: 30_000,
  });
}

export interface NewPass {
  itemId: string;
  hours: number;
  maxStreams: number;
  label?: string;
  /** The party the guest joins, by its id on this server's relay. */
  party?: string;
}

export function useCreatePass() {
  const { client, user } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pass: NewPass) =>
      client.post<OwnedPass & { Code: string }>('/AIOStreams/GuestPasses', {
        ItemId: pass.itemId,
        Hours: pass.hours,
        MaxStreams: pass.maxStreams,
        Label: pass.label,
        Party: pass.party,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['jf', client.base, user.Id, 'guest-passes'],
      }),
  });
}

export function useRevokePass() {
  const { client, user } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      client.delete(`/AIOStreams/GuestPasses/${encodeURIComponent(id)}`),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['jf', client.base, user.Id, 'guest-passes'],
      }),
  });
}
