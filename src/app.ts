import express, { NextFunction, Request, Response } from "express";
import { config } from "dotenv";

import { SqliteCacheDatabase } from "@components/database";
import { Scheduler } from "@components/scheduler";
import { StashExtractor } from "@components/stash-extractor";
import { normalizeDate } from "@components/utils";
import { Trackers } from "@components/trackers";
import { Torznab } from "@components/torznab";

async function main() {
  config(); // Load environment variables from .env file

  const app = express();

  const trackers = Trackers.fromConfigFile();
  const torznab = new Torznab(trackers);

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

  const cacheMaintenanceScheduler = new Scheduler({
    name: "cache database maintenance",
    cronExpression: process.env.CACHE_MAINTENANCE_CRON ?? "0 3 * * *", // default to daily at 03:00
    task: maintainCacheDatabase
  });

  app.get("/api", async (req, res, next) => {
    try {
      const type = req.query.t;

      if (type === "caps") {
        const xml = torznab.createCaps();
        return res.type("application/xml").send(xml);
      }

      if (type === "search") {
        const scenes = await stashExtractor.fetchScenes({ title: (req.query.q as string) ?? "" });
        const filtered = trackers.filterScenesByTrackers(scenes);
        const xml = await torznab.createXML(filtered);
        return res.type("application/xml").send(xml);
      }

      return res.status(400).send("unsupported");
    } catch (err) {
      return next(err);
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

      return res.json(
        scenes.map((scene, index) => ({
          tvdbId: 9000000 + index,
          title: scene.title,
          sortTitle: scene.title,
          overview: scene.details,
          studio: scene.studio?.name ?? "Unknown",
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
      return next(err);
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
  const server = app.listen(port, () => {
    console.log(`Server started on port ${port}`);
    torrentCacheScheduler.start();
    cacheMaintenanceScheduler.start();
  });

  const shutdown = () => {
    console.log("Shutting down...");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch(console.error);