import React from 'react';
import { toast } from 'sonner';
import { BiError, BiPause, BiStopCircle, BiTransfer } from 'react-icons/bi';
import { Card } from '@aiostreams/ui/card';
import { Stat } from '@aiostreams/ui/charts';
import { IconButton } from '@aiostreams/ui/button';
import { Tooltip } from '@aiostreams/ui/tooltip';
import {
  ConfirmationDialog,
  useConfirmationDialog,
} from '@aiostreams/ui/shared/confirmation-dialog';
import { cn } from '@aiostreams/ui/core/styling';
import { formatBytes, formatClock } from '@aiostreams/ui/core/format';
import { DashboardQueryBoundary } from '@/components/shared/dashboard-query-boundary';
import {
  useRemuxSessions,
  useStopRemux,
  type RemuxRunState,
  type RemuxSessionInfo,
} from './queries';
import { ClientIpPill, Pill } from './_components/shared';

const STATES: Record<RemuxRunState, { label: string; hint: string }> = {
  reading: { label: 'reading', hint: 'ffmpeg is reading the file' },
  throttled: {
    label: 'ahead',
    hint: 'ffmpeg is far enough ahead of the player and waits for it',
  },
  stopped: {
    label: 'idle',
    hint: 'No ffmpeg running; the next segment the player asks for starts one',
  },
};

function channelsLabel(n: number | undefined): string {
  if (!n) return '';
  return n === 6 ? ' 5.1' : n === 8 ? ' 7.1' : n === 2 ? ' stereo' : ` ${n}ch`;
}

/** Live view of the Jellyfin remuxes this instance is running. */
export function StreamsRemuxPage() {
  const remux = useRemuxSessions();
  const data = remux.data;
  const sessions = data?.sessions ?? [];
  const served = sessions.reduce((n, s) => n + s.bytesServed, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat
          label="Remuxing"
          value={data ? `${sessions.length} of ${data.maxSessions}` : '0'}
          hint={
            data?.opening
              ? `${data.opening} indexing their file`
              : 'ffmpeg sessions running on this instance'
          }
        />
        <Stat
          label="Reading"
          value={String(sessions.filter((s) => s.state === 'reading').length)}
          hint="Pulling the file from its source right now"
        />
        <Stat
          label="Served"
          className="col-span-2 lg:col-span-1"
          value={formatBytes(served)}
          hint="Sent to players by the running remuxes"
        />
      </div>

      <DashboardQueryBoundary query={remux} errorTitle="Failed to load remuxes">
        {() =>
          sessions.length === 0 ? (
            <Card className="p-8">
              <p className="text-center text-sm text-[--muted]">
                {data?.enabled === false
                  ? 'Remuxing is turned off, so browsers only get versions they can play as they are.'
                  : "Nothing remuxing right now — a row appears when the web app plays an MKV a browser can't play as it is."}
              </p>
            </Card>
          ) : (
            <div className="space-y-2">
              {sessions.map((s) => (
                <RemuxRow key={s.id} session={s} />
              ))}
            </div>
          )
        }
      </DashboardQueryBoundary>
    </div>
  );
}

function RemuxRow({ session: s }: { session: RemuxSessionInfo }) {
  const stop = useStopRemux();
  const state = STATES[s.state];
  const pct = (seconds: number | undefined) =>
    s.durationSeconds && seconds !== undefined
      ? Math.min(100, Math.max(0, (seconds / s.durationSeconds) * 100))
      : 0;

  const confirmStop = useConfirmationDialog({
    title: 'Stop this remux',
    description: (
      <>
        End the remux of <span className="break-all">{s.title}</span>. The
        player fails on its next segment.
      </>
    ),
    actionText: 'Stop',
    actionIntent: 'alert-subtle',
    onConfirm: () =>
      void stop
        .mutateAsync(s.id)
        .then(() => toast.success('Remux stopped'))
        .catch((e: any) => toast.error(e?.message ?? 'Action failed')),
  });

  return (
    <div className="space-y-1.5 rounded-lg border border-[--border] bg-[--paper] p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-fuchsia-500/40 bg-fuchsia-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fuchsia-300">
          <BiTransfer className="text-xs" />
          Remux
        </span>
        <span
          className="order-last w-full min-w-0 truncate text-sm font-medium sm:order-none sm:w-auto sm:flex-1"
          title={s.title}
        >
          {s.title}
        </span>
        <span
          className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-[--muted]"
          title={state.hint}
        >
          {s.state !== 'reading' && <BiPause />}
          {state.label}
        </span>
        <Tooltip
          trigger={
            <IconButton
              size="sm"
              intent="alert-subtle"
              icon={<BiStopCircle />}
              aria-label="Stop remux"
              disabled={stop.isPending}
              onClick={confirmStop.open}
            />
          }
        >
          Stop this remux
        </Tooltip>
      </div>

      {/* The player's position over how far ffmpeg has cut. */}
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-[--subtle]">
        <div
          className="absolute inset-y-0 bg-brand/30"
          style={{
            left: `${pct(s.playhead)}%`,
            width: `${Math.max(0, pct(s.readTo) - pct(s.playhead))}%`,
          }}
        />
        <div
          className={cn(
            'absolute inset-y-0 left-0 bg-brand',
            s.state === 'reading' && 'animate-pulse'
          )}
          style={{ width: `${pct(s.playhead)}%` }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-[--muted]">
        {s.viewer && <Pill>{s.viewer.name}</Pill>}
        {s.viewer?.ip && <ClientIpPill ip={s.viewer.ip} />}
        {s.viewer?.client && (
          <span>
            {s.viewer.client}
            {s.viewer.device ? ` · ${s.viewer.device}` : ''}
          </span>
        )}
        <Pill className="font-mono">
          {s.videoCodec ?? 'video'} copy · {s.audio.codec ?? 'audio'}
          {channelsLabel(s.audio.channels)} → aac
          {channelsLabel(s.audio.outputChannels)}
          {s.subtitles ? ` · ${s.subtitles} subs` : ''}
        </Pill>
        <span>
          {formatClock(s.playhead * 1000)} of{' '}
          {formatClock(s.durationSeconds * 1000)}
          {s.readTo !== undefined &&
            ` · ${formatClock(Math.max(0, s.readTo - s.playhead) * 1000)} ahead`}
        </span>
        <span>
          {formatBytes(s.bytesRead)} read · {formatBytes(s.bytesServed)} served
        </span>
        {(s.failedRuns > 0 || s.droppedFrames > 0) && (
          <Tooltip
            trigger={
              <Pill className="border-amber-500/40 bg-amber-500/10 text-amber-300">
                <BiError />
                {[
                  s.failedRuns && `${s.failedRuns} failed`,
                  s.droppedFrames && `${s.droppedFrames} dropped`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Pill>
            }
          >
            ffmpeg runs that failed and were retried, and damaged video frames
            dropped from the output.
          </Tooltip>
        )}
        <span>{formatClock(Date.now() - s.startedAt)} elapsed</span>
        {s.idleMs > 10_000 && (
          <span>last request {formatClock(s.idleMs)} ago</span>
        )}
      </div>

      <ConfirmationDialog {...confirmStop} />
    </div>
  );
}
