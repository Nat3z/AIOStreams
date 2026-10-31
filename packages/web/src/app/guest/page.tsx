import React from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { motion } from 'motion/react';
import { LuClock } from 'react-icons/lu';
import { Button } from '@aiostreams/ui/button';
import { TextInput } from '@aiostreams/ui/text-input';
import { cn } from '@aiostreams/ui/core/styling';
import { AUTH_CARD, RISE, Screen } from '@/app/sign-in/page';
import { guestName, setGuestName, type GuestPassInfo } from '@/lib/guest';
import { formatLocale } from '@/lib/i18n';

/** Where a guest link lands once it has expired or its owner ended it. */
export function GuestEnded() {
  return (
    <Screen name="guest-ended">
      <motion.div
        {...RISE}
        data-ui="auth-card"
        className={cn(AUTH_CARD, 'text-center')}
      >
        <h1 data-ui="page-title" className="text-xl font-semibold">
          <Trans>This link has ended</Trans>
        </h1>
        <p className="text-sm text-[--muted]">
          <Trans>
            It expired, or whoever shared it ended it. Ask them for a new one.
          </Trans>
        </p>
      </motion.div>
    </Screen>
  );
}

/** How long a pass has left, roughly. */
function timeLeft(expiresAt: number): string {
  const hours = Math.max(0, (expiresAt - Date.now()) / 3_600_000);
  if (hours >= 48) {
    const days = Math.floor(hours / 24);
    return t`${days} days left`;
  }
  if (hours >= 1) {
    const whole = Math.floor(hours);
    return t`${whole} h left`;
  }
  return t`Ends within the hour`;
}

/** Says the app is a guest's, and until when. */
export function GuestChip({
  pass,
  className,
}: {
  pass: GuestPassInfo;
  className?: string;
}) {
  const until = new Date(pass.ExpiresAt).toLocaleString(formatLocale(), {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    <div
      data-ui="guest-chip"
      title={t`Until ${until}`}
      className={cn(
        'inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-gray-200 backdrop-blur',
        className
      )}
    >
      <LuClock className="size-3.5 flex-none text-[--muted]" />
      <span>
        <Trans>Watching as a guest</Trans>
        <span className="text-[--muted]"> · {timeLeft(pass.ExpiresAt)}</span>
      </span>
    </div>
  );
}

/** Asks once what a party should call this guest. */
export function GuestNamePrompt({ onDone }: { onDone(name: string): void }) {
  const fallback = React.useMemo(() => {
    const number = Math.floor(Math.random() * 90) + 10;
    return t`Guest ${number}`;
  }, []);
  const [name, setName] = React.useState('');
  const save = (value: string) => {
    const chosen = value.trim().slice(0, 32) || fallback;
    setGuestName(chosen);
    onDone(chosen);
  };
  return (
    <form
      data-ui="guest-name"
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save(name);
      }}
    >
      <p className="text-sm text-[--muted]">
        <Trans>What should the party call you?</Trans>
      </p>
      <TextInput
        aria-label={t`Your name`}
        placeholder={fallback}
        value={name}
        onValueChange={setName}
        maxLength={32}
        autoFocus
      />
      <div className="flex gap-2">
        <Button type="submit" intent="white" className="flex-1 rounded-full">
          <Trans>Join</Trans>
        </Button>
        <Button
          type="button"
          intent="gray-outline"
          className="rounded-full"
          onClick={() => save('')}
        >
          <Trans>Skip</Trans>
        </Button>
      </div>
    </form>
  );
}

export const hasGuestName = () => !!guestName();
