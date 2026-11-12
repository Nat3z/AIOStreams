import React from 'react';
import { plural, t } from '@lingui/core/macro';
import {
  LuArrowDown,
  LuArrowUp,
  LuX,
  LuGripVertical,
  LuCheck,
} from 'react-icons/lu';
import { Trans } from '@lingui/react/macro';
import { toast } from 'sonner';
import { Select } from '@aiostreams/ui/select';
import { Button, IconButton } from '@aiostreams/ui/button';
import { BasicField } from '@aiostreams/ui/basic-field';
import { cn } from '@aiostreams/ui/core/styling';
import { LANGUAGES, languageName } from '@/lib/languages';
import { focusOn } from '@/lib/input';
import { SettingsRow } from './settings-card';

export const onDevice = () => t`Kept on this device.`;
export const onAccount = () =>
  t`Saved to your account, so your other devices and Jellyfin apps use it too.`;
export const followsYou = () =>
  t`Saved to your account, so it follows you to every device.`;

export const DOCS_URL = 'https://aiostreams.org';

export const seconds = (count: number) =>
  plural(count, { one: '# second', other: '# seconds' });

export const languageOptions = () =>
  LANGUAGES.map((l) => ({ value: l.code, label: languageName(l) }));

/** Languages in order, each movable by its buttons or by dragging, with a picker for another. */
export function LanguageList({
  label,
  help,
  options,
  value,
  max,
  fixed,
  actions,
  muted,
  onChange,
}: {
  label: string;
  help: string;
  options: { value: string; label: string }[];
  value: string[];
  /** One for a server that keeps only Jellyfin's single language. */
  max?: number;
  /** Every option always listed, only reordered. */
  fixed?: boolean;
  /** More buttons for a row, before its arrows. */
  actions?: (code: string, name: string) => React.ReactNode;
  /** Rows shown dimmed, such as hidden ones. */
  muted?: (code: string) => boolean;
  onChange: (next: string[]) => void;
}) {
  const list = React.useRef<HTMLOListElement>(null);
  const add = React.useRef<HTMLButtonElement>(null);
  const nameOf = (code: string) =>
    options.find((o) => o.value === code)?.label ?? code;
  const move = (from: number, to: number) => {
    if (to < 0 || to >= value.length) return;
    const next = [...value];
    next.splice(to, 0, ...next.splice(from, 1));
    onChange(next);
  };
  // Dragged in a draft of its own, so the order is only saved once dropped.
  const [draft, setDraft] = React.useState<string[] | null>(null);
  const dragged = React.useRef<number | null>(null);
  const shown = draft ?? value;
  const grab = (i: number) => (e: React.PointerEvent<HTMLElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragged.current = i;
    setDraft(value);
  };
  const drag = (e: React.PointerEvent<HTMLElement>) => {
    const from = dragged.current;
    if (from === null || !draft) return;
    const rows = [...(list.current?.children ?? [])];
    const to = rows.findIndex((row) => {
      const { top, bottom } = row.getBoundingClientRect();
      return e.clientY >= top && e.clientY < bottom;
    });
    if (to === -1 || to === from) return;
    const next = [...draft];
    next.splice(to, 0, ...next.splice(from, 1));
    dragged.current = to;
    setDraft(next);
  };
  const drop = () => {
    if (draft && draft.some((code, i) => code !== value[i])) onChange(draft);
    dragged.current = null;
    setDraft(null);
  };
  // A removed row takes focus with it, so the next row's button takes it over.
  const removed = React.useRef<number | null>(null);
  React.useLayoutEffect(() => {
    const at = removed.current;
    if (at === null) return;
    removed.current = null;
    const left =
      list.current?.querySelectorAll<HTMLElement>('[data-name=remove]');
    const next = left?.[Math.min(at, left.length - 1)] ?? add.current;
    if (next) focusOn(next);
  }, [value]);
  const remove = (at: number) => {
    removed.current = at;
    onChange(value.filter((_, i) => i !== at));
  };
  const button = (
    name: string,
    label: string,
    icon: React.ReactElement,
    onClick: () => void,
    dim = false
  ) => (
    <IconButton
      data-name={name}
      size="sm"
      intent={name === 'remove' ? 'alert-subtle' : 'gray-subtle'}
      // Enabled at the ends, as a remote's focus can't rest on a disabled button.
      className={cn('size-8 rounded-full', dim && 'opacity-40')}
      icon={icon}
      aria-label={label}
      aria-disabled={dim || undefined}
      onClick={onClick}
    />
  );
  return (
    <BasicField label={label} help={help}>
      {shown.length > 0 && (
        <ol ref={list} data-ui="language-list" className="space-y-1">
          {shown.map((code, i) => {
            const name = nameOf(code);
            return (
              <li
                key={code}
                className={cn(
                  'flex items-center gap-2 rounded-xl bg-[--subtle] py-1 ps-1 pe-1',
                  draft && dragged.current === i && 'ring-1 ring-[--brand]'
                )}
              >
                <span
                  data-name="grip"
                  aria-hidden
                  className="flex size-8 cursor-grab touch-none items-center justify-center text-[--muted] active:cursor-grabbing"
                  onPointerDown={grab(i)}
                  onPointerMove={drag}
                  onPointerUp={drop}
                  onPointerCancel={drop}
                >
                  <LuGripVertical />
                </span>
                <span className="w-4 text-sm tabular-nums text-[--muted]">
                  {i + 1}
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-sm',
                    muted?.(code) && 'text-[--muted] line-through'
                  )}
                >
                  {name}
                </span>
                {actions?.(code, name)}
                {button(
                  'up',
                  t`Move ${name} up`,
                  <LuArrowUp />,
                  () => move(i, i - 1),
                  i === 0
                )}
                {button(
                  'down',
                  t`Move ${name} down`,
                  <LuArrowDown />,
                  () => move(i, i + 1),
                  i === value.length - 1
                )}
                {!fixed &&
                  button('remove', t`Remove ${name}`, <LuX />, () => remove(i))}
              </li>
            );
          })}
        </ol>
      )}
      {!fixed && (max === undefined || value.length < max) && (
        <Select
          ref={add}
          // A picker that adds, not a field: nothing to clear, nothing a form waits on.
          clearable={false}
          placeholder={
            value.length ? t`Add another language` : t`Add a language`
          }
          options={options.filter((o) => !value.includes(o.value))}
          value=""
          onValueChange={(v) => v && onChange([...value, v])}
        />
      )}
    </BasicField>
  );
}

export function ShaderFilesRow({
  help,
  accept,
  read,
  add,
  remove,
}: {
  help: string;
  accept: string;
  read(): Promise<string[]>;
  add(name: string, text: string): Promise<string[]>;
  remove(name: string): Promise<string[]>;
}) {
  const [names, setNames] = React.useState<string[] | null>(null);
  const picker = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    read().then(setNames, () => setNames([]));
  }, [read]);
  const failed = (e: Error) => toast.error(e.message);
  return (
    <div className="flex flex-col gap-3">
      <SettingsRow label={t`Shaders`} help={help}>
        <input
          ref={picker}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            file
              .text()
              .then((text) => add(file.name, text))
              .then(setNames, failed);
          }}
        />
        <Button
          intent="gray-outline"
          className="w-full rounded-full sm:w-auto"
          disabled={names === null}
          onClick={() => picker.current?.click()}
        >
          <Trans>Add a shader</Trans>
        </Button>
      </SettingsRow>
      {names?.map((name) => (
        <div key={name} className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate font-mono text-sm">{name}</span>
          <Button
            intent="gray-outline"
            size="sm"
            className="flex-none rounded-full"
            onClick={() => remove(name).then(setNames, failed)}
          >
            <Trans>Remove</Trans>
          </Button>
        </div>
      ))}
    </div>
  );
}

/** A headed group of answers, each labelled to its side on wider screens. */
export function AnswerGroup({
  name,
  title,
  description,
  children,
}: {
  /** `data-name`, which custom CSS matches, so it stays in English. */
  name: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section data-ui="settings-card" data-name={name} className="space-y-5">
      <div>
        <p data-ui="settings-card-title" className="font-semibold">
          {title}
        </p>
        <p
          data-ui="settings-card-description"
          className="text-sm text-[--muted]"
        >
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}

export function Answer({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-ui="settings-answer"
      className="grid grid-cols-1 gap-3 border-t border-white/10 pt-5 md:grid-cols-[9rem,minmax(0,1fr)] md:gap-6"
    >
      <p className="text-sm font-medium text-[--muted] md:pt-1.5">{label}</p>
      <div className="min-w-0 space-y-4">
        {children}
        {help && <p className="-mt-2 text-sm text-[--muted]">{help}</p>}
      </div>
    </div>
  );
}

/** Choices as pills, several on when `multiple`; the one pointed at or focused is passed to `onPeek`. */
export function Pills({
  label,
  options,
  isOn,
  onPick,
  onPeek,
  multiple = false,
  stacked = false,
}: {
  label: string;
  options: { value: string; label: string }[];
  isOn: (value: string) => boolean;
  onPick: (value: string) => void;
  /** Null once none is. */
  onPeek?: (value: string | null) => void;
  multiple?: boolean;
  /** One under another, in two columns when there are many. */
  stacked?: boolean;
}) {
  return (
    <div
      role={multiple ? 'group' : 'radiogroup'}
      aria-label={label}
      onMouseLeave={() => onPeek?.(null)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onPeek?.(null);
      }}
      className={cn(
        stacked
          ? cn('grid gap-2', options.length > 3 && 'grid-cols-2')
          : 'flex flex-wrap gap-2'
      )}
    >
      {options.map((o) => {
        const on = isOn(o.value);
        return (
          <button
            key={o.value}
            type="button"
            role={multiple ? undefined : 'radio'}
            aria-checked={multiple ? undefined : on}
            aria-pressed={multiple ? on : undefined}
            onClick={() => {
              onPick(o.value);
              onPeek?.(null);
            }}
            onMouseEnter={() => onPeek?.(o.value)}
            onFocus={() => onPeek?.(o.value)}
            className={cn(
              'flex items-center gap-2 rounded-full border text-start text-sm font-medium transition active:scale-[0.98]',
              stacked ? 'px-4 py-2.5' : 'px-4 py-1.5',
              on
                ? 'border-[--brand] bg-brand-500/15'
                : 'border-white/15 hover:bg-white/10'
            )}
          >
            {stacked ? (
              <>
                <span className="flex-1">{o.label}</span>
                {on && <LuCheck className="flex-none" />}
              </>
            ) : (
              <>
                {on && <LuCheck />}
                {o.label}
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
