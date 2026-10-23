# aio.natfor.work

One shared configuration, run by its owner, with each person signing in as their own user on the web app and in Jellyfin apps. Each person edits themselves and makes Stremio links from Settings → Profile.

| Service | Reached at | Role |
| --- | --- | --- |
| `aiostreams` | `100.87.64.61:3000` (Tailscale) | this fork |
| `redis` | compose network only | cache |

## First run

Docker from snap can't read hidden directories, so run these from a clone outside one (not under `~/.t3`).

1. `cp deploy/.env.example deploy/.env` and fill it in, leaving `ALIASED_CONFIGURATIONS` empty.
2. `docker compose -f deploy/compose.yaml up -d --build`
3. Add `deploy/Caddyfile`'s block to oci-selfhosted and reload Caddy.
4. Sign in at `https://aio.natfor.work/stremio/configure` with `AIOSTREAMS_AUTH`. Build the configuration, add users under Save & Install → Jellyfin → Users, and save it.
5. Put `home:<uuid>:<encryptedPassword>` from the saved install URL in `ALIASED_CONFIGURATIONS`, then run `docker compose -f deploy/compose.yaml up -d`.

People then sign in at `https://aio.natfor.work/` (the web app) or add `https://aio.natfor.work/jellyfin` as a server in a Jellyfin app.
