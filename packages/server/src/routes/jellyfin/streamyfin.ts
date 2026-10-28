import { Router } from 'express';
import { jf, type JellyfinRequestContext } from './context.js';
import { viewItems } from './items.js';

/*
 * Streamyfin reads its companion plugin's settings from these routes, and a
 * `home` value there replaces its stock home screen. Answering as the plugin
 * lays each library out as its own row, as the web app does, rather than
 * hiding them behind "Recently added in" rows Streamyfin builds per library.
 */
const router: Router = Router({ mergeParams: true });

type Section = {
  title: string;
  orientation: 'vertical' | 'horizontal';
  items?: {
    parentId?: string;
    filters?: string[];
    includeItemTypes?: string[];
  };
  nextUp?: Record<string, never>;
};

/** Continue Watching and Next Up, then every library the user hasn't hidden. */
async function homeSections(ctx: JellyfinRequestContext): Promise<Section[]> {
  const libraries = (await viewItems(ctx))
    // Without a genre these list nothing, and a row can't pick one.
    .filter(
      (v) =>
        !(v as { aiostreams?: { genreRequired?: boolean } }).aiostreams
          ?.genreRequired
    )
    .map<Section>((v) => ({
      title: v.Name ?? '',
      orientation: 'vertical',
      items: { parentId: v.Id },
    }));
  return [
    {
      title: 'Continue Watching',
      orientation: 'horizontal',
      items: {
        filters: ['IsResumable'],
        includeItemTypes: ['Episode', 'Movie'],
      },
    },
    { title: 'Next Up', orientation: 'horizontal', nextUp: {} },
    ...libraries,
  ];
}

/* Locked, or the app would keep a stale copy once the libraries change. */
async function settings(ctx: JellyfinRequestContext) {
  return {
    home: { locked: true, value: { sections: await homeSections(ctx) } },
  };
}

router.get(
  '/Streamyfin/v1/config/resolved',
  jf(async (_req, res, ctx) => {
    res.json(await settings(ctx));
  })
);
/* What plugins without the resolved route serve, the stored configuration. */
router.get(
  '/Streamyfin/config',
  jf(async (_req, res, ctx) => {
    res.json({ settings: await settings(ctx) });
  })
);

export default router;
