# Private Torrent Torznab

Generate a Torznab-compatible RSS feed from Stash scenes and proxy private tracker downloads through your own service. This project is intended to be used as a custom indexer in tools like [Prowlarr](https://github.com/prowlarr/prowlarr).

## What This Repository Does

1. Fetches scenes from your Stash GraphQL API.
2. Filters scene URLs against configured tracker host/path rules.
3. Picks candidate torrents by tracker priority.
4. Exposes Torznab-compatible endpoints for indexer clients.
5. Proxies tracker downloads via local `/download/:tracker/:id` routes.
6. Caches Stash scenes and tracker-derived torrent metadata in SQLite.

## Features

- Torznab endpoints: `/api?t=caps` and `/api?t=search&q=...`
- Tracker priority support (array order in config)
- Download proxy endpoint for private trackers
- Persistent SQLite cache with TTL + maintenance endpoints
- Startup and scheduled cache refresh jobs

## Requirements

- Node.js 20+ (Docker image uses Node 22)
- npm
- Reachable Stash instance with API key
- At least one tracker with a valid `passkey` in `trackers.config.json`

## Quick Start

1. Install dependencies.

```bash
npm install
```

2. Create environment file.

```bash
cp .env.example .env
```

3. Create tracker config.

```bash
cp trackers.example.config.json trackers.config.json
```

4. Fill in `.env` and `trackers.config.json`.

5. Start in development mode.

```bash
npm run dev
```

## Environment Variables

See `.env.example` for the complete template.

Required:

- `PROTOCOL`
- `HOST`
- `PORT`
- `STASH_BASE_URL`
- `STASH_API_KEY`
- `TRACKERS_CONFIG_PATH`

Optional:

- `CACHE_TTL_MS` (default `300000`)
- `CACHE_SQLITE_PATH` (default `./data/cache.sqlite`)
- `CACHE_CRON` (default `0 */6 * * *`)
- `CACHE_MAINTENANCE_CRON` (default `0 3 * * *`)

## Tracker Configuration

See `trackers.example.config.json`.

```json
[
  {
    "name": "tracker-one",
    "host": "tracker-one.example",
    "path": "details.php",
    "passkey": "replace-with-tracker-one-passkey",
    "downloadUrlTemplate": "https://tracker-one.example/download.php?id={id}&passkey={passkey}"
  }
]
```

Field meanings:

- `name`: Unique tracker identifier used by `/download/:tracker/:id`
- `host`: Tracker hostname used for URL matching
- `path`: URL path fragment used to validate scene URLs
- `passkey`: Tracker auth key
- `downloadUrlTemplate`: Direct torrent template with `{id}` and `{passkey}` placeholders

Tracker array order defines priority (first = highest).

## Run Commands

Development:

```bash
npm run dev
```

Type check:

```bash
npm run typecheck
```

Build:

```bash
npm run build
```

Run built app:

```bash
npm start
```

## Add to Prowlarr

1. Start this service.
2. In Prowlarr, go to Add Indexer -> Generic Torznab.
3. Set the Torznab URL to your service URL, for example `http://localhost:3000/api`.
4. Run a test query from Prowlarr.

## Docker

Build image:

```bash
docker build -t stash-torznab:local .
```

Run container:

```bash
docker run --rm -p 3000:3000 --env-file .env stash-torznab:local
```

Notes:

- The image builds TypeScript and starts with `npm run start`.
- `TRACKERS_CONFIG_PATH` defaults to `./trackers.config.json` in the image.

## Docker Compose

This project includes `docker-compose.yml`.

Start:

```bash
docker compose up --build -d
```

Logs:

```bash
docker compose logs -f app
```

Stop:

```bash
docker compose down
```

Notes:

- Compose loads variables from `.env`.
- Compose mounts `./trackers.config.json` as read-only to `/app/trackers.config.json`.

## API Endpoints

### `GET /api?t=caps`

Returns Torznab capabilities XML.

### `GET /api?t=search&q=<query>`

Returns Torznab RSS XML containing scenes that match the query and have valid tracker URLs.

Example:

```bash
curl "http://127.0.0.1:3000/api?t=search&q=example"
```

### `GET /download/:tracker/:id`

Proxies torrent download from the configured tracker template.

Example:

```bash
curl -L "http://localhost:3000/download/tracker-one/1234" -o torrent.torrent
```

### `GET /list`

Returns mapped scene data as JSON.

### `GET /maintenance/cache/stats`

Returns cache stats for `stash-scenes` and `tracker-scene-torrents`.

### `POST /maintenance/cache/prune`

Prunes expired cache entries and returns updated stats.

### `POST /maintenance/cache/optimize`

Runs SQLite WAL checkpoint (`TRUNCATE`) and `VACUUM` on opened cache databases.

## Project Structure

```text
src/
  app.ts                     # Express server + routes
  components/
    stash-extractor.ts       # Stash GraphQL client + scene cache
    trackers.ts              # Tracker loader + URL resolution
    torznab.ts               # Torznab XML response builder
    cache.ts                 # Generic cache wrapper
    scheduler.ts             # Startup + cron scheduling
  types.d.ts                 # Shared types
trackers.config.json         # Tracker definitions (priority order)
```

## Notes

- `seeders` and `peers` are currently static values in RSS output.
- Torrent cache prewarming runs at startup, then on `CACHE_CRON`.
- SQLite maintenance runs at startup, then on `CACHE_MAINTENANCE_CRON`.
- TypeScript path aliases (`@components/*`) are rewritten at build time using `tsc-alias`.
