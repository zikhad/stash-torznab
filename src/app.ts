import { config } from "dotenv";
import express, { Response } from "express";
import { create } from "xmlbuilder2";

import { StashExtractor } from "@components/stash-extractor";
import { normalizeDate } from "@components/utils";
import { Trackers } from "@components/trackers";

/** Sends the Torznab capabilities document. */
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
 * Builds and sends the Torznab RSS response for the provided scenes.
 * @param res - Express response object.
 * @param scenes - Scenes to render into the RSS feed.
 */
async function sendResults(res: Response, scenes: Scene[]) {
  const sceneSelections = await Promise.all(
    scenes.map(async (scene) => ({
      scene,
      selectedTorrent: await trackers.findSmallestTorrent(scene.urls),
    }))
  );

  const root = create({ version: "1.0" })
    .ele("rss", {
      version: "2.0",
      "xmlns:torznab": "http://torznab.com/schemas/2015/feed"
    })
    .ele("channel")
    .ele("title").txt("Custom Torznab Indexer").up()
    .ele("description").txt("Torznab scenes mapped to torrents").up()
    .ele("link").txt(`${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}`).up();

  for (const { scene, selectedTorrent } of sceneSelections) {
    if (!selectedTorrent) continue;

    const item = root.ele("item");

    item.ele("title").txt(scene.title);
    item.ele("guid").txt(scene.id);
    item.ele("link").txt(`${process.env.STASH_BASE_URL}/scenes/${scene.id}`);

    item.ele("pubDate").txt(normalizeDate(scene.release_date));

    item.ele("enclosure", {
      url: selectedTorrent.proxyUrl,
      length: selectedTorrent.size,
      type: "application/x-bittorrent"
    });

    [
      { name: "category", value: "6000" },
      { name: "seeders", value: "1" },
      { name: "peers", value: "1" },
      { name: "size", value: `${selectedTorrent.size}` },
      { name: "studio", value: scene.studio.name },
      { name: "performers", value: scene.performers.map(p => p.performer.name).join(", ") },
  ].forEach(attr => {
    item.ele("torznab:attr", attr);
  });
    for (const tag of scene.tags) {
      item.ele("torznab:attr", {
        name: "tag",
        value: tag.name
      });
    }

  }

  return res.type("application/xml").send(root.end({ prettyPrint: true }));
}

config(); // Load .env variables

const app = express();

const stashExtractor = new StashExtractor();
const trackers = Trackers.fromConfigFile();


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