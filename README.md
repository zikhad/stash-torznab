# Private Torrent Torznab

Generate a Torznab-compatible RSS feed from Stash scenes and proxy torrent downloads through your own service.

## Features

- Exposes Torznab endpoints (`/api?t=caps` and `/api?t=search&q=...`)
- Uses Stash GraphQL as the scene source
- Filters scene URLs by tracker host + valid torrent path
- Prioritizes trackers in configured order
- Proxies torrent downloads via `/download/:tracker/:id`
- In-memory caching for Stash scene queries

## Requirements

- Node.js 20+
- npm
- A reachable Stash instance with API key
- At least one tracker with `passkey` configured in `trackers.config.json`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your environment file:

```bash
cp .env.example .env
```

3. Fill in `.env` values.

## Environment Variables

See `.env.example`.

Required:

- `PROTOCOL`
- `HOST`
- `PORT`
- `STASH_BASE_URL`
- `STASH_API_KEY`
- `TRACKERS_CONFIG_PATH`

Optional:

- `CACHE_TTL_MS` (default `21600000`)
- `CACHE_CRON` (default `0 */6 * * *`)

## Run

Development:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Start built app:

```bash
npm start
```

Type check:

```bash
npm run typecheck
```

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

- The Dockerfile runs `npm run build` and starts with `npm run start`.
- `TRACKERS_CONFIG_PATH` defaults to `./trackers.config.json` in the image.

## Docker Compose

This project includes `docker-compose.yml`.

Start:

```bash
docker-compose up --build -d
```

Logs:

```bash
docker-compose logs -f app
```

Stop:

```bash
docker-compose down
```

Notes:

- Compose loads environment values from `.env`.
- Compose mounts `./trackers.config.json` to `/app/trackers.config.json` as read-only.
- If your machine supports the plugin command, you can use `docker compose` instead of `docker-compose`.

## API Endpoints

### `GET /api?t=caps`

Returns Torznab capabilities XML.

### `GET /api?t=search&q=<query>`

Returns Torznab RSS XML with matched scenes.

Example:

```bash
curl "http://127.0.0.1:3000/api?t=search&q=example"
```

### `GET /download/:tracker/:id`

Proxies torrent file download from tracker using configured passkey.

Example:

```bash
curl -L "http://127.0.0.1:3000/download/tracker/1488" -o torrent.torrent
```

### `GET /list`

Returns raw mapped scene data as JSON.

## Project Structure

```text
src/
  app.ts                     # Express server + routes
  components/
    stash-extractor.ts       # Stash GraphQL client + scene cache
    trackers.ts              # Tracker loader + URL resolution
    cache.ts                 # Generic cache wrapper
    utils.ts                 # Date and small helpers
  types.d.ts                 # Shared types
trackers.config.json         # Tracker definitions (priority order)
```

## Tracker Extension

Add or edit trackers in `trackers.config.json`.

Each entry supports:

- `name`
- `host`
- `path`
- `passkey`
- `downloadUrlTemplate` (supports `{id}` and `{passkey}`)

Array order defines priority (first = highest).

## Notes

- `seeders` and `peers` are currently static in RSS output.
- Torrent cache prewarming runs at startup and then on the `CACHE_CRON` schedule.
- URL aliases are enabled via TypeScript paths (`@components/*`) and rewritten on build using `tsc-alias`.
