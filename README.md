# Private Torrent Torznab

Generate a Torznab-compatible RSS feed from [Stash](https://github.com/stashapp/stash) scenes and proxy private tracker downloads.
This project is intended to be used as a custom indexer in tools like [Prowlarr](https://github.com/prowlarr/prowlarr).

## What This Repository Does

1. Fetches scenes from your Stash GraphQL API.
2. Filters scene URLs against configured tracker host/path rules.
3. Picks candidate torrents by tracker priority.
4. Exposes Torznab-compatible endpoints for indexer clients.
5. Proxies tracker downloads via local `/download/:tracker/:id` routes.
6. Caches Stash scenes and tracker-derived torrent metadata in SQLite.

## Features
- Automate torrents searchs for Stash scenes
- Torznab endpoints: `/api?t=caps` and `/api?t=search&q=...`
- Tracker priority support (array order in config)
- Download proxy endpoint for private trackers
- Persistent SQLite cache with TTL + maintenance endpoints
- Startup and scheduled cache refresh jobs

## Support
<hr/>
<br/>
<p align="center">
  <strong>Found this project useful? You can support its development!</strong>
</p>
<p align="center">
  <a href="https://buymeacoffee.com/zikhad">
    <img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-yellow?logo=buymeacoffee" alt="Buy Me a Coffee">
  </a>
</p>
<hr/>

## Running through Docker
Follow bellow steps to run this project through docker

### Configure Environment Variables

1. Create a `.env` file.

See [.env.example](.env.example) for the complete template.

```dotenv
PROTOCOL=http
HOST=localhost
PORT=3000
STASH_BASE_URL=http://your-stash-host:9999
STASH_API_KEY=replace_with_your_stash_api_key
TRACKERS_CONFIG_PATH=/app/trackers.config.json

# Optional
# CACHE_TTL_MS=300000
# CACHE_SQLITE_PATH=/app/data/cache.sqlite
# CACHE_CRON=0 */6 * * *
# CACHE_MAINTENANCE_CRON=0 3 * * *
```

2. Create a `trackers.config.json`.

See [trackers.config.json](./trackers.example.config.json) for the complete template.

```json
[
  {
    "name": "tracker-one",
    "host": "tracker-one.example",
    "path": "details.php",
    "passkey": "replace_with_tracker_one_passkey",
    "downloadUrlTemplate": "https://tracker-one.example/download.php?id={id}&passkey={passkey}"
  }
]
```
Fields meanings:
- `name`: Unique tracker identifier used by `/download/:tracker/:id`
- `host`: Tracker hostname used for URL matching
- `path`: URL path fragment used to validate scene URLs
- `passkey`: Tracker auth key. (Usually found in your profile page on the tracker website)
- `downloadUrlTemplate`: Direct torrent template with `{id}` and `{passkey}` placeholders

Tracker array order defines priority (first = highest).

### Docker
In the same folder as `.env` and `trackers.config.json`:

Pull image:

```bash
docker pull ghcr.io/zikhad/stash-torznab:latest
```

Run container:

```bash
docker run --rm -p 3000:3000 \
  --env-file .env \
  -e TRACKERS_CONFIG_PATH=/app/trackers.config.json \
  -v "$PWD/trackers.config.json:/app/trackers.config.json:ro" \
  ghcr.io/zikhad/stash-torznab:latest
```

Notes:

- The image builds TypeScript and starts with `npm run start`.
- The container expects `TRACKERS_CONFIG_PATH=/app/trackers.config.json`.
- You must provide and mount `trackers.config.json` at runtime, otherwise startup fails.

### Docker Compose

create a `docker-compose.yml` in the same folder as `.env` and `trackers.config.json`:

```yaml
services:
  app:
    image: ghcr.io/zikhad/stash-torznab:latest
    container_name: stash-torznab
    ports:
      - "3000:3000"
    env_file:
      - .env
    environment:
      TRACKERS_CONFIG_PATH: /app/trackers.config.json
    volumes:
      - ./trackers.config.json:/app/trackers.config.json:ro
    restart: unless-stopped
```

Then start it:

```bash
docker compose up -d
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


## Add to Prowlarr

1. Once this service is up and running.
2. In Prowlarr, go to Add Indexer -> Generic Torznab.
3. Set the Torznab URL to your service URL, for example `http://localhost:3000/api`.
4. Run a test query from Prowlarr.

---

## Local Development)

Use this section if you cloned the repository and want to run from source code.

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

### Requirements

- Node.js 20+ (Docker image uses Node 22)
- npm
- Reachable Stash instance with API key
- At least one tracker with a valid `passkey` in `trackers.config.json`

### Docker (Locally)

Build image locally (optional):

```bash
docker build -t stash-torznab:local .
```

Run local image:

```bash
docker run --rm -p 3000:3000 \
  --env-file .env \
  -e TRACKERS_CONFIG_PATH=/app/trackers.config.json \
  -v "$PWD/trackers.config.json:/app/trackers.config.json:ro" \
  stash-torznab:local
```

### Docker compose (locally)
Run local docker compose
```bash
docker compose up --build -d
```

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
