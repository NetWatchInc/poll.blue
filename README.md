# poll.blue

Polls for Bluesky, built on the AT Protocol.

- **`web/`** — Astro + Preact + Tailwind frontend: landing page, create-poll page
  with atcute Bluesky **OAuth** (your password never reaches the server), and a
  results page.
- **`server/`** — Node + Hono backend: the API (`/api/poll/register`,
  `/api/poll/:id`), vote recording (`/p/:id/:n`), and the `@`-mention bot. It
  also serves the built frontend, so production is a single app on one port.

## Local development

Requires **Node 20+** and a Postgres database.

```bash
# 1) Backend  →  http://127.0.0.1:8000
cd server
cp -n .env.example .env      # -n: don't clobber an existing .env; then fill in PG_*
npm install
npm run dev

# 2) Frontend →  http://127.0.0.1:4321  (proxies /api etc. to the backend)
cd web
npm install
npm run dev
```

Open **http://127.0.0.1:4321**. (OAuth's loopback flow requires the `127.0.0.1`
IP, not `localhost`.)

The database schema is in [`server/schema.sql`](server/schema.sql). For a managed
DB (e.g. DigitalOcean) set `PG_SSL=require` and `PG_PORT` in `server/.env`.

## Production

A single Docker image (`Dockerfile`) builds `web/` and runs the server, which
serves the static frontend **and** the API on one port. The platform provides
`PORT` and the `PG_*` / `BSKY_*` environment variables.

For a managed database, remember to set **`PG_SSL=require`** and **`PG_PORT`**
(e.g. `25060`) in the platform's env vars — otherwise the defaults assume a plain
local Postgres on `5432`.
