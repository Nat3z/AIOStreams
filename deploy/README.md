# aio.natfor.work

One shared configuration, run by its owner, with each person signing in as their own user on the web app and in Jellyfin apps. Each person edits themselves and makes Stremio links from Settings → Profile.

| Service | Reached at | Role |
| --- | --- | --- |
| `aiostreams` | `127.0.0.1:3000` | this fork |
| `redis` | compose network only | cache |
| `aiometadata` | compose network only | tracks for each user who signs in to Simkl or AniList |
| `aiometadata-redis` | compose network only | its cache (Redis 8) |

## First run

It runs on oci-selfhosted beside Caddy, from `/srv/stacks/aio/aiostreams`, with the AIOMetadata fork at `/srv/stacks/aio/aiometadata`. The machine is arm64, so both images are built there.

1. `cp deploy/.env.example deploy/.env` and fill it in, leaving `ALIASED_CONFIGURATIONS` empty.
2. `docker compose -f deploy/compose.yaml up -d --build`
3. Add `deploy/Caddyfile`'s block to `/etc/caddy/Caddyfile` and `sudo systemctl reload caddy`.
4. Sign in at `https://aio.natfor.work/stremio/configure` with `AIOSTREAMS_AUTH`. Build the configuration, add users under Save & Install → Jellyfin → Users, and save it.
5. Put `home:<uuid>:<encryptedPassword>` from the saved install URL in `ALIASED_CONFIGURATIONS`, then run `docker compose -f deploy/compose.yaml up -d`.

For tracking, make a Simkl and an AniList app with the redirect URIs in `.env.example`, fill in their credentials, and run `docker compose -f deploy/compose.yaml up -d`. Each person then connects their own account from Settings → Profile → Tracking.

People then sign in at `https://aio.natfor.work/` (the web app) or add `https://aio.natfor.work/jellyfin` as a server in a Jellyfin app.
