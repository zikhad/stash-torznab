import Parser from "rss-parser";
import type { Item } from "rss-parser";

/**
 * Fetches all paginated posts from an RSS feed until a 404 boundary is reached.
 * @param feedURL - Base RSS feed URL.
 */

export async function fetchAllPosts(feedURL = "https://k9lady.com/feed/"): Promise<Item[]> {
  const parser = new Parser();
  const posts: Item[] = [];
  let page = 1;

  while (true) {
    const url = `${feedURL}?paged=${page}`;
    console.log("fetching", url);

    try {
      const feed = await parser.parseURL(url);
      posts.push(...feed.items);
      console.log(`page ${page}: ${feed.items.length}`);
      page++;
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) {
        console.log("reached end of pages");
        break;
      }
      throw err;
    }
  }

  return posts;
}
