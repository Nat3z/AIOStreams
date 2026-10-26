import React from 'react';
import { Card } from '@aiostreams/ui/card';
import { cn } from '@aiostreams/ui/core/styling';

export function SettingsCard({
  name,
  title,
  description,
  children,
}: {
  /** `data-name`, which custom CSS matches, so it stays in English. */
  name?: string;
  title?: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div data-ui="settings-card" data-name={name} className="space-y-3">
      {(title || description) && (
        <div>
          {title && (
            <p data-ui="settings-card-title" className="font-semibold">
              {title}
            </p>
          )}
          {description && (
            <p
              data-ui="settings-card-description"
              className="text-sm text-[--muted]"
            >
              {description}
            </p>
          )}
        </div>
      )}
      <Card
        data-ui="settings-card-body"
        className="divide-y-2 divide-gray-700/40 overflow-clip rounded-xl border-white/[0.08] bg-transparent"
      >
        {React.Children.map(children, (child) =>
          child ? (
            <div
              data-ui="settings-card-item"
              className="px-4 py-3.5 transition-colors hover:bg-gray-900"
            >
              {child}
            </div>
          ) : null
        )}
      </Card>
    </div>
  );
}

export function SettingsPageHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div data-ui="settings-header">
      <h2 data-ui="section-title" className="text-xl font-semibold">
        {title}
      </h2>
      <p
        data-ui="settings-header-description"
        className="text-sm text-[--muted]"
      >
        {description}
      </p>
    </div>
  );
}

export function SettingsRow({
  label,
  help,
  children,
  className,
}: {
  label: React.ReactNode;
  help?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6',
        className
      )}
    >
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label}</p>
        {help && <p className="text-sm text-[--muted]">{help}</p>}
      </div>
      <div className="flex-none">{children}</div>
    </div>
  );
}
