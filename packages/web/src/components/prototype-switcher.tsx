/* eslint-disable lingui/no-unlocalized-strings -- PROTOTYPE, dev builds only */
import React from 'react';
import { LuChevronLeft, LuChevronRight } from 'react-icons/lu';

/*
 * PROTOTYPE: flips between a prototype's variants, kept in `?variant=` so a
 * reload or a shared link keeps the one picked. Never shown in production.
 */

export function usePrototypeVariant<K extends string>(keys: readonly K[]): K {
  const read = () => {
    const v = new URLSearchParams(window.location.search).get('variant');
    return keys.includes(v as K) ? (v as K) : keys[0];
  };
  const [variant, setVariant] = React.useState(read);
  React.useEffect(() => {
    const sync = () => setVariant(read());
    window.addEventListener('prototype-variant', sync);
    return () => window.removeEventListener('prototype-variant', sync);
  });
  return variant;
}

function choose(key: string) {
  const url = new URL(window.location.href);
  url.searchParams.set('variant', key);
  window.history.replaceState(window.history.state, '', url);
  window.dispatchEvent(new Event('prototype-variant'));
}

export function PrototypeSwitcher<K extends string>({
  variants,
  current,
}: {
  variants: readonly { key: K; name: string }[];
  current: K;
}) {
  const at = Math.max(
    0,
    variants.findIndex((v) => v.key === current)
  );
  const step = (by: number) =>
    choose(variants[(at + by + variants.length) % variants.length].key);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (process.env.NODE_ENV === 'production') return null;
  const button =
    'grid size-8 place-items-center rounded-full hover:bg-black/10 active:bg-black/20';
  return (
    <div className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-[100] flex -translate-x-1/2 items-center gap-1 rounded-full bg-amber-300 p-1 font-mono text-sm text-black shadow-2xl ring-2 ring-black/20">
      <button className={button} onClick={() => step(-1)} aria-label="Previous">
        <LuChevronLeft />
      </button>
      <span className="whitespace-nowrap px-2">
        {variants[at].key} — {variants[at].name}
      </span>
      <button className={button} onClick={() => step(1)} aria-label="Next">
        <LuChevronRight />
      </button>
    </div>
  );
}
