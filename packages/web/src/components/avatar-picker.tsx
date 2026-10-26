import React from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { toast } from 'sonner';
import { Button } from '@aiostreams/ui/button';
import { avatarImage } from '@aiostreams/ui/utils/avatar-image';
import { useSession } from '@/lib/jellyfin/session';
import { UserAvatar } from './user-avatar';

/** A user's picture with a way to upload a new one or clear it. */
export function AvatarPicker({
  name,
  src,
  onChange,
}: {
  name: string;
  src: string | null;
  onChange: (url: string | null) => void;
}) {
  const { client } = useSession();
  const input = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const { url } = await client.post<{ url: string }>(
        '/AIOStreams/Profile/Avatar',
        await avatarImage(file)
      );
      onChange(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        aria-label={t`Upload a picture`}
        onClick={() => input.current?.click()}
        className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
      >
        <UserAvatar name={name} src={src} className="size-16 text-xl" />
      </button>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          intent="gray-subtle"
          loading={busy}
          onClick={() => input.current?.click()}
        >
          <Trans>Upload picture</Trans>
        </Button>
        {src && (
          <Button
            type="button"
            size="sm"
            intent="gray-link"
            disabled={busy}
            onClick={() => onChange(null)}
          >
            <Trans>Remove</Trans>
          </Button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void upload(file);
        }}
      />
    </div>
  );
}
