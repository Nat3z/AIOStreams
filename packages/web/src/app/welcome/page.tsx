import React from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { AnimatePresence, motion } from 'motion/react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@aiostreams/ui/button';
import { TextInput } from '@aiostreams/ui/text-input';
import { PasswordInput } from '@aiostreams/ui/password-input';
import { Skeleton } from '@aiostreams/ui/skeleton';
import { cn } from '@aiostreams/ui/core/styling';
import { useSession } from '@/lib/jellyfin/session';
import { AvatarPicker } from '@/components/avatar-picker';
import { ErrorLine, RISE, Screen } from '../sign-in/page';
import {
  PreferencesCard,
  TrackersCard,
  useProfile,
  useSaveProfile,
  useTrackers,
} from '../settings/profile';
import { AppsGuide } from './welcome-apps';

/*
 * Where a setup link lands: the user, signed in by the link, picks their name,
 * picture and preferences, connects a tracker if the server has them, then a
 * password of their own, after which the link only signs this device back in,
 * and last how to add the server to their other apps.
 */

const STEPS = ['you', 'streams', 'tracking', 'password', 'apps'] as const;
type Step = (typeof STEPS)[number] | 'done';

const CARD =
  'mx-auto w-full max-w-lg space-y-5 rounded-2xl border border-white/10 bg-gray-950/80 p-6 shadow-xl';

export function WelcomePage({
  invite,
  onDone,
}: {
  invite: string;
  onDone: () => void;
}) {
  const trackers = useTrackers();
  // Tracking only shows where the server has it and the user keeps their own history.
  const tracks = !!trackers.data?.available && !trackers.data.shared;
  const steps = STEPS.filter((s) => s !== 'tracking' || tracks);
  const [step, setStep] = React.useState<Step>('you');
  const at = steps.indexOf(step as never);
  const next = () => setStep(steps[at + 1] ?? 'done');
  const back = () => setStep(steps[at - 1] ?? 'you');
  return (
    <Screen name="welcome">
      {step !== 'done' && <Progress steps={steps} step={step} />}
      <AnimatePresence mode="wait">
        <motion.div key={step} {...RISE}>
          {step === 'you' && <YouStep onNext={next} />}
          {step === 'streams' && <StreamsStep onBack={back} onNext={next} />}
          {step === 'tracking' && <TrackingStep onBack={back} onNext={next} />}
          {step === 'password' && (
            <PasswordStep invite={invite} onBack={back} onNext={next} />
          )}
          {step === 'apps' && <AppsStep onNext={next} />}
          {step === 'done' && <DoneStep onDone={onDone} />}
        </motion.div>
      </AnimatePresence>
    </Screen>
  );
}

function Progress({ steps, step }: { steps: readonly Step[]; step: Step }) {
  const at = steps.indexOf(step);
  const number = at + 1;
  const total = steps.length;
  return (
    <ol
      aria-label={t`Step ${number} of ${total}`}
      className="mx-auto flex w-full max-w-lg gap-2"
    >
      {steps.map((s, i) => (
        <li
          key={s}
          className={cn(
            'h-1 flex-1 rounded-full transition-colors',
            i <= at ? 'bg-white' : 'bg-white/15'
          )}
        />
      ))}
    </ol>
  );
}

function StepHead({ title, help }: { title: string; help: string }) {
  return (
    <div className="space-y-1">
      <h1 data-ui="page-title" className="text-xl font-semibold">
        {title}
      </h1>
      <p className="text-sm text-[--muted]">{help}</p>
    </div>
  );
}

function StepButtons({
  onBack,
  next,
  busy,
  disabled,
}: {
  onBack?: () => void;
  next: string;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
      {onBack && (
        <Button
          type="button"
          intent="gray-outline"
          className="rounded-full"
          onClick={onBack}
        >
          <Trans>Back</Trans>
        </Button>
      )}
      <Button
        type="submit"
        intent="white"
        className="rounded-full"
        loading={busy}
        disabled={disabled}
      >
        {next}
      </Button>
    </div>
  );
}

function YouStep({ onNext }: { onNext: () => void }) {
  const { user } = useSession();
  const profile = useProfile();
  const save = useSaveProfile();
  const [name, setName] = React.useState<string | null>(null);
  const [avatar, setAvatar] = React.useState<string | null | undefined>();
  if (!profile.data)
    return <Skeleton className="mx-auto h-72 max-w-lg rounded-2xl" />;

  const shownName = (name ?? profile.data.name ?? user.Name ?? '').trim();
  const greeting = shownName || (user.Name ?? '');
  const shownAvatar = avatar === undefined ? profile.data.avatar : avatar;
  return (
    <form
      className={CARD}
      onSubmit={(e) => {
        e.preventDefault();
        if (name === null && avatar === undefined) return onNext();
        save.mutate(
          { name: shownName, avatar: shownAvatar },
          { onSuccess: onNext }
        );
      }}
    >
      <StepHead
        title={t`Welcome, ${greeting}`}
        help={t`You've been added to this server. A few steps and it's yours.`}
      />
      <AvatarPicker name={shownName} src={shownAvatar} onChange={setAvatar} />
      <TextInput
        label={t`Name`}
        help={t`What everyone on this server sees.`}
        value={name ?? profile.data.name ?? user.Name ?? ''}
        maxLength={32}
        onValueChange={setName}
      />
      <StepButtons
        next={t`Continue`}
        busy={save.isPending}
        disabled={!shownName}
      />
    </form>
  );
}

function StreamsStep({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: () => void;
}) {
  const profile = useProfile();
  return (
    <form
      className={CARD}
      onSubmit={(e) => {
        e.preventDefault();
        onNext();
      }}
    >
      <StepHead
        title={t`How you watch`}
        help={t`Optional. Each change saves as you make it, and you can change it later in settings.`}
      />
      {profile.data ? (
        <PreferencesCard preferences={profile.data.preferences} />
      ) : (
        <Skeleton className="h-72 rounded-xl" />
      )}
      <StepButtons onBack={onBack} next={t`Continue`} />
    </form>
  );
}

function TrackingStep({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <form
      className={CARD}
      onSubmit={(e) => {
        e.preventDefault();
        onNext();
      }}
    >
      <StepHead
        title={t`Keep track`}
        help={t`Optional. Connect an account and what you watch here is marked there, and the other way round.`}
      />
      <TrackersCard />
      <StepButtons onBack={onBack} next={t`Continue`} />
    </form>
  );
}

function PasswordStep({
  invite,
  onBack,
  onNext,
}: {
  invite: string;
  onBack: () => void;
  onNext: () => void;
}) {
  const { client } = useSession();
  const profile = useProfile();
  const [password, setPassword] = React.useState('');
  const [again, setAgain] = React.useState('');
  const finish = useMutation({
    mutationFn: () =>
      client.post<void>('/AIOStreams/Profile/Welcome', {
        token: invite,
        password,
      }),
    onSuccess: onNext,
  });
  const min = profile.data?.passwordMin ?? 8;
  const short = password.length > 0 && password.length < min;
  const mismatch = again.length > 0 && again !== password;
  return (
    <form
      className={CARD}
      onSubmit={(e) => {
        e.preventDefault();
        finish.mutate();
      }}
    >
      <StepHead
        title={t`Your password`}
        help={t`You'll sign in with your name and this, here and in Jellyfin apps. Once it's set, this link only opens on this device.`}
      />
      <PasswordInput
        label={t`Password`}
        autoComplete="new-password"
        autoFocus
        value={password}
        error={short ? t`At least ${min} characters` : undefined}
        onValueChange={setPassword}
      />
      <PasswordInput
        label={t`Again`}
        autoComplete="new-password"
        value={again}
        error={mismatch ? t`These don't match` : undefined}
        onValueChange={setAgain}
      />
      <ErrorLine error={finish.error?.message ?? null} />
      <StepButtons
        onBack={onBack}
        next={t`Finish`}
        busy={finish.isPending}
        disabled={password.length < min || again !== password}
      />
    </form>
  );
}

function AppsStep({ onNext }: { onNext: () => void }) {
  return (
    <form
      className={CARD}
      onSubmit={(e) => {
        e.preventDefault();
        onNext();
      }}
    >
      <StepHead
        title={t`Your other apps`}
        help={t`Optional. Watch on your phone or computer by adding this server to an app there.`}
      />
      <AppsGuide />
      <StepButtons next={t`Continue`} />
    </form>
  );
}

function DoneStep({ onDone }: { onDone: () => void }) {
  const { user } = useSession();
  const name = user.Name ?? '';
  return (
    <div className={cn(CARD, 'text-center')}>
      <StepHead
        title={t`You're set, ${name}`}
        help={t`Sign in as ${name} on any device. Stremio links and apps are in Settings, under Profile.`}
      />
      <Button intent="white" className="w-full rounded-full" onClick={onDone}>
        <Trans>Start watching</Trans>
      </Button>
    </div>
  );
}
