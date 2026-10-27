import { t } from '@lingui/core/macro';
import type { Host, NowPlaying } from '.';

/** The bridge apps hosting jellyfin-web inject, any member of which may be missing. */
export interface NativeShell {
  AppHost?: {
    appName?(): string;
    deviceName?(): string;
    supports?(feature: string): boolean;
    exit?(): void;
  };
  selectServer?(): void;
  openClientSettings?(): void;
  enableFullscreen?(): void;
  disableFullscreen?(): void;
  updateMediaSession?(info: Record<string, unknown>): void;
  hideMediaSession?(): void;
}

declare global {
  interface Window {
    NativeShell?: NativeShell;
  }
}

/** The media session update jellyfin-web sends an app. */
export function mediaInfo(now: NowPlaying): Record<string, unknown> {
  return {
    action: 'timeupdate',
    isLocalPlayer: true,
    canSeek: true,
    album: '',
    itemId: now.itemId,
    title: now.title,
    artist: now.artist,
    imageUrl: now.imageUrl,
    position: Math.round(now.positionMs),
    duration: Math.round(now.durationMs),
    isPaused: now.paused,
  };
}

/** What an app's `NativeShell` offers, used as jellyfin-web uses it. */
export function nativeShellParts(shell: NativeShell): Omit<Host, 'name'> {
  const app = shell.AppHost;
  return {
    // Not its id, which would change once a late shell arrives.
    device: () => {
      const name = app?.deviceName?.();
      return name ? { name } : null;
    },
    selectServer: shell.selectServer && (() => shell.selectServer?.()),
    exit:
      app?.exit && app.supports?.('exit') !== false
        ? () => app.exit?.()
        : undefined,
    settings:
      shell.openClientSettings && app?.supports?.('clientsettings') !== false
        ? {
            // Read when shown, after the language is set.
            get label() {
              return app?.appName?.() || t`App`;
            },
            get description() {
              return t`The app's own settings`;
            },
            get help() {
              return t`Options the app keeps for itself.`;
            },
            open: () => shell.openClientSettings?.(),
          }
        : undefined,
    // jellyfin-web tells the app only where the browser has no media session.
    mediaSession:
      shell.updateMediaSession && !('mediaSession' in navigator)
        ? {
            update: (now) => shell.updateMediaSession?.(mediaInfo(now)),
            clear: () => shell.hideMediaSession?.(),
          }
        : undefined,
  };
}

const hosts = new WeakMap<NativeShell, Host>();
let fullscreen = false;

/**
 * Full screen as the app gives it, since an iPhone's web view has no
 * fullscreen API: the iOS app hides its status and tab bars and turns
 * landscape itself, as it does for jellyfin-web's player.
 */
function fullscreenOf(shell: NativeShell): Host['fullscreen'] {
  if (!shell.enableFullscreen || !shell.disableFullscreen) return undefined;
  return {
    active: () => fullscreen,
    set(on) {
      if (on) shell.enableFullscreen?.();
      else shell.disableFullscreen?.();
      fullscreen = on;
      document.dispatchEvent(new Event('fullscreenchange'));
    },
  };
}

/** Any other app that hosts jellyfin-web, playing in the page. */
export function nativeShellHost(): Host | null {
  const shell = window.NativeShell;
  if (!shell) return null;
  let host = hosts.get(shell);
  if (!host) {
    host = {
      name: 'jellyfin-app',
      ...nativeShellParts(shell),
      fullscreen: fullscreenOf(shell),
    };
    hosts.set(shell, host);
  }
  return host;
}
