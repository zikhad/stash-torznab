import { create } from "xmlbuilder2";

import { Trackers } from "@components/trackers";

/**
 * Handles building Torznab-compliant XML responses.
 */
export class Torznab {
  private readonly trackers: Trackers;

  /**
   * @param trackers - Trackers instance used to resolve torrent metadata for scenes.
   */
  constructor(trackers: Trackers) {
    this.trackers = trackers;
  }

  /**
   * Returns a Torznab caps XML response describing the capabilities of this indexer.
   * @returns XML string of the Torznab caps response.
   * */
  public createCaps() {
    return create({ version: "1.0" })
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
  }

  /**
   * Returns a Torznab RSS response for the provided scenes.
   * @param scenes - Scenes to include in the feed.
   * @returns XML string of the Torznab RSS feed.
   */
  public async createXML(scenes: Scene[]) {
    const root = create({ version: "1.0" })
      .ele("rss", {
        version: "2.0",
        "xmlns:torznab": "http://torznab.com/schemas/2015/feed",
      })
      .ele("channel")
      .ele("title").txt("Custom Torznab Indexer").up()
      .ele("description").txt("Torznab scenes mapped to torrents").up()
      .ele("link").txt(`${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}`).up();

    for (const scene of scenes) {
      const torrent = await this.trackers.getTorrentFromScene(scene);
      if (!torrent) continue;

      const item = root.ele("item");

      item.ele("title").txt(torrent.title);
      item.ele("guid").txt(torrent.guid);
      item.ele("link").txt(torrent.link);
      item.ele("pubDate").txt(torrent.pubDate);

      item.ele("enclosure", {
        url: torrent.downloadLink,
        length: `${torrent.size}`,
        type: "application/x-bittorrent",
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
        item.ele("torznab:attr", { name: "tag", value: tag });
      }
    }
    return root.end({ prettyPrint: true });
  }
}
