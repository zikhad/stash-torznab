import express, { Response } from "express";
import cron from "node-cron";
import { create } from "xmlbuilder2";
import { config } from "dotenv";

import { StashExtractor } from "@components/stash-extractor";
import { normalizeDate } from "@components/utils";
import { Trackers } from "@components/trackers";

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

async function sendResults(res: Response, scenes: Scene[]) {
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


config(); // Load environment variables from .env file

const app = express();

const trackers = Trackers.fromConfigFile();

const stashExtractor = new StashExtractor();

async function cacheTorrents() {
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
}

let isCaching = false;

async function runCacheTorrents(trigger: "startup" | "cron") {
  if (isCaching) {
    console.log(`Skipping ${trigger} cache run — previous run still in progress.`);
    return;
  }
  isCaching = true;
  try {
    await cacheTorrents();
    console.log(`Torrent caching complete (${trigger}).`);
  } catch (err) {
    console.error(`Error during torrent caching (${trigger}):`, err);
  } finally {
    isCaching = false;
  }
}

runCacheTorrents("startup");

const DEFAULT_CACHE_CRON = "0 */6 * * *";
const cacheCronExpression = process.env.CACHE_CRON ?? DEFAULT_CACHE_CRON;

if (!cron.validate(cacheCronExpression)) {
  console.warn(`Invalid CACHE_CRON value "${cacheCronExpression}", falling back to "${DEFAULT_CACHE_CRON}".`);
  cron.schedule(DEFAULT_CACHE_CRON, () => { void runCacheTorrents("cron"); });
} else {
  cron.schedule(cacheCronExpression, () => { void runCacheTorrents("cron"); });
}

const activeCron = cron.validate(cacheCronExpression) ? cacheCronExpression : DEFAULT_CACHE_CRON;
console.log(`Scheduled torrent cache refresh with cron: "${activeCron}".`);

app.get("/api", async (req, res) => {
  const type = req.query.t;

  if (type === "caps") {
    return sendCaps(res);
  }

  if (type === "search") {
    const scenes = await stashExtractor.fetchScenes({ title: (req.query.q as string) ?? "" });
    const filtered = trackers.filterScenesByTrackers(scenes);
    return await sendResults(res, filtered);
  }

  res.status(400).send("unsupported");
});

app.get("/download/:tracker/:id", async (req, res) => {
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

  const response = await fetch(torrentUrl);

  if (!response.ok) {
    res.status(response.status).send("tracker download failed");
    return;
  }

  res.setHeader(
    "Content-Type",
    "application/x-bittorrent"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="torrent-${id}.torrent"`
  );
  res.setHeader("Cache-Control", "no-cache");
  const buffer = Buffer.from(await response.arrayBuffer());
  return res.send(buffer);
});

app.get("/list", async (req, res) => {
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
      performers: scene.performers.map( p => ({
        name: p.performer.name,
        gender: p.performer.gender
      })),
      tags: scene.tags.map(tag => tag.name),
      monitored: true
    }))
  );
});

app.listen(3000, () => console.log("Server started on port 3000"));