import express, { NextFunction, Request, Response } from "express";
import { create } from "xmlbuilder2";
import { config } from "dotenv";

import { SqliteCacheDatabase } from "@components/database";
import { Scheduler } from "@components/scheduler";
import { StashExtractor } from "@components/stash-extractor";
import { normalizeDate } from "@components/utils";
import { Trackers } from "@components/trackers";

/** Sends Torznab capabilities metadata response. */
function sendCaps(res: Response) {
  const xml = create({ version: "1.0" })
    .ele("caps")
    .ele("server", {
      version: "1.0",
      title: "Custom Torznab Indexer",
    })
    .up()
    .ele("limits", { max: 100, default: 50 })
    .up()
    .ele("searching")
    .ele("search", { available: "yes" })
    .up()
    .up()
    .ele("categories")
    .ele("category", { id: 2000, name: "Movies" })
    .up()
    .up()
    .end({ prettyPrint: true });

  res.type("application/xml").send(xml);
}

/**
 * Renders and sends a Torznab RSS response for the provided scenes.
 * @param res - Express response object.
 * @param scenes - Scenes to include in the feed.
 * @param trackers - Trackers instance used to resolve torrent metadata.
 */
async function sendResults(res: Response, scenes: Scene[], trackers: Trackers) {
  const root = create({ version: "1.0" })
    .ele("rss", {
      version: "2.0",
      "xmlns:torznab": "http://torznab.com/schemas/2015/feed"
    })
    .ele("channel")
    .ele("title").txt("Custom Torznab Indexer").up()
    .ele("description").txt("Torznab scenes mapped to torrents").up()
    .ele("link").txt(`${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}`).up();

  for (const scene of scenes) {
    const torrent = await trackers.getTorrentFromScene(scene);
    if (!torrent) continue;

    const item = root.ele("item");

    item.ele("title").txt(torrent.title);
    item.ele("guid").txt(torrent.guid);
    item.ele("link").txt(torrent.link);

    item.ele("pubDate").txt(torrent.pubDate);

    item.ele("enclosure", {
      url: torrent.downloadLink,
      length: `${torrent.size}`,
      type: "application/x-bittorrent"
    });

    [
      { name: "category", value: torrent.category },
      { name: "seeders", value: `${torrent.seeders}` },
      { name: "peers", value: `${torrent.peers}` },
      { name: "size", value: `${torrent.size}` },
      { name: "studio", value: torrent.studio },
      { name: "performers", value: torrent.performers },
  ].forEach(attr => {
    item.ele("torznab:attr", attr);
  });
    for (const tag of torrent.tags) {
      item.ele("torznab:attr", {
        name: "tag",
        value: tag
      });
    }

  }

  return res.type("application/xml").send(root.end({ prettyPrint: true }));
}


async function main() {
  config(); // Load environment variables from .env file

  const app = express();

  const trackers = Trackers.fromConfigFile();

  const stashExtractor = new StashExtractor();

  /**
   * Preloads torrent metadata cache for all currently filterable scenes.
   */
  async function cacheTorrents() {
    let removedStash = 0;
    let removedTracker = 0;

    try {
      const scenes = await stashExtractor.fetchScenes();
      const filtered = trackers.filterScenesByTrackers(scenes);
      console.log(`Caching torrents for ${filtered.length} scenes...`);
      for (const [index, scene] of filtered.entries()) {
        const torrent = await trackers.getTorrentFromScene(scene);
        if (!torrent) {
          console.warn(`No torrent found for scene "${scene.title}" (${scene.id})`);
          continue;
        }
        const progress = ((index + 1) / filtered.length) * 100;
        console.log(`[${(index + 1)}/${filtered.length} (${progress.toFixed(0)}%)]: Cached torrrent - "${torrent.title}" (${torrent.guid})`);
      }
    } finally {
      // Keep SQLite cache growth bounded by removing expired rows after each refresh cycle.
      removedStash = stashExtractor.pruneCache();
      removedTracker = trackers.pruneCache();
      console.log(
        `Cache prune complete: removed ${removedStash + removedTracker} expired entries (stash=${removedStash}, tracker=${removedTracker}).`
      );
    }
  }

  /**
   * Runs SQLite checkpoint + VACUUM maintenance for cache databases.
   */
  async function maintainCacheDatabase() {
    const databases = SqliteCacheDatabase.runMaintenanceAll();
    if (databases.length === 0) {
      console.log("Cache database maintenance skipped: no opened cache database.");
      return;
    }

    for (const database of databases) {
      console.log(
        `Cache DB maintenance complete (${database.databasePath}): checkpoint busy=${database.checkpointBusy}, log=${database.checkpointLogFrames}, checkpointed=${database.checkpointCheckpointedFrames}, page_count=${database.pageCount}, freelist_count=${database.freelistCount}.`
      );
    }
  }

  const torrentCacheScheduler = new Scheduler({
    name: "torrent cache refresh",
    cronExpression: process.env.CACHE_CRON as string,
    task: cacheTorrents
  });
  torrentCacheScheduler.start();

  const cacheMaintenanceScheduler = new Scheduler({
    name: "cache database maintenance",
    cronExpression: process.env.CACHE_MAINTENANCE_CRON ?? "0 3 * * *", // default to daily at 03:00
    task: maintainCacheDatabase
  });
  cacheMaintenanceScheduler.start();

  app.get("/api", async (req, res, next) => {
    try {
      const type = req.query.t;

      if (type === "caps") {
        return sendCaps(res);
      }

      if (type === "search") {
        const scenes = await stashExtractor.fetchScenes({ title: (req.query.q as string) ?? "" });
        const filtered = trackers.filterScenesByTrackers(scenes);
        return await sendResults(res, filtered, trackers);
      }

      res.status(400).send("unsupported");
    } catch (err) {
      next(err);
    }
  });

  app.get("/download/:tracker/:id", async (req, res, next) => {
    const tracker = req.params.tracker;
    const id = req.params.id;

    let torrentUrl: string;
    try {
      torrentUrl = trackers.resolveTrackerDownload(tracker, id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("Unknown tracker")) {
        res.status(400).send(message);
      } else {
        res.status(503).send(message);
      }
      return;
    }

    try {
      const response = await fetch(torrentUrl);

      if (!response.ok) {
        res.status(response.status).send("tracker download failed");
        return;
      }

      res.setHeader("Content-Type", "application/x-bittorrent");
      res.setHeader("Content-Disposition", `attachment; filename="torrent-${id}.torrent"`);
      res.setHeader("Cache-Control", "no-cache");
      const buffer = Buffer.from(await response.arrayBuffer());
      return res.send(buffer);
    } catch (err) {
      next(err);
    }
  });

  app.get("/list", async (req, res, next) => {
    try {
      const scenes = await stashExtractor.fetchScenes();

      res.json(
        scenes.map((scene, index) => ({
          tvdbId: 9000000 + index,
          title: scene.title,
          sortTitle: scene.title,
          overview: scene.details,
          studio: scene.studio.name ?? "Unknown",
          released: normalizeDate(scene.release_date),
          foreignId: scene.id,
          images: scene.images.map(image => ({
            coverType: "poster",
            url: image.url
          })),
          performers: scene.performers.map(p => ({
            name: p.performer.name,
            gender: p.performer.gender
          })),
          tags: scene.tags.map(tag => tag.name),
          monitored: true
        }))
      );
    } catch (err) {
      next(err);
    }
  });

  /** Returns cache statistics for all internal cache namespaces. */
  app.get("/maintenance/cache/stats", (_req, res) => {
    return res.json({
      stashScenes: stashExtractor.getCacheStats(),
      trackerTorrents: trackers.getCacheStats(),
    });
  });

  /** Prunes expired cache entries and returns updated cache stats. */
  app.post("/maintenance/cache/prune", (_req, res) => {
    const removedStash = stashExtractor.pruneCache();
    const removedTracker = trackers.pruneCache();
    const removed = removedStash + removedTracker;

    return res.json({
      removed,
      stashScenes: stashExtractor.getCacheStats(),
      trackerTorrents: trackers.getCacheStats(),
    });
  });

  /** Runs SQLite cache database checkpoint + VACUUM maintenance. */
  app.post("/maintenance/cache/optimize", (_req, res) => {
    const databases = SqliteCacheDatabase.runMaintenanceAll();
    return res.json({ databases });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    return res.status(500).send("Internal server error");
  });

  const port = +(process.env.PORT ?? 3000);
  const server = app.listen(port, () => console.log(`Server started on port ${port}`));

  const shutdown = () => {
    console.log("Shutting down...");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch(console.error);