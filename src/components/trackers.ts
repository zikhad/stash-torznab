import fs from "node:fs";
import path from "node:path";

import { Cache } from "@components/cache";

import { TorrentDecoder } from "@components/torrent-decoder";
import { normalizeDate } from "./utils";

const torrentDecoder = new TorrentDecoder();

/** Configuration for a single torrent tracker. */
export type TrackerConfig = {
    /** Unique identifier used in proxy routes (e.g. "tracker"). */
    name: string;
    /** Hostname of the tracker, without protocol (e.g. "tracker.vip"). */
    host: string;
    /** URL path segment that identifies a valid torrent detail page (e.g. "torrents-details.php"). */
    path: string;
    /** Passkey for this tracker. */
    passkey: string;
    /**
     * Template for direct tracker downloads.
     * Supported tokens: `{id}` and `{passkey}`.
     */
    downloadUrlTemplate: string;
};

function normalizeHostname(hostname: string): string {
    return hostname.replace(/^www\./, "");
}

type Torrent = {
    title: string;
    guid: string;
    link: string;
    downloadLink: string;
    pubDate: string;
    size: number;
    category: string;
    seeders: number;
    peers: number;
    studio: string;
    performers: string;
    tags: string[];
};

/**
 * Manages tracker configurations and provides methods for filtering scenes,
 * selecting torrent URLs, and resolving download targets.
 *
 * Trackers are evaluated in declaration order — the first tracker in the list
 * has the highest priority when multiple matches exist for a scene.
 */
export class Trackers {
    private readonly trackers: TrackerConfig[];
    private readonly trackersByName: Map<string, TrackerConfig>;

    private readonly cache = new Cache<Torrent>();

    /**
     * @param trackers - Ordered list of tracker configurations (highest priority first).
     *                   Defaults to the built-in tracker configs.
     */
    constructor(trackers: TrackerConfig[]) {
        this.trackers = trackers;
        this.trackersByName = new Map(trackers.map((tracker) => [tracker.name, tracker]));
    }

    /**
     * Loads tracker configuration from a JSON file.
     * @param configPath - Absolute or relative path to a trackers JSON file.
     */
    public static fromConfigFile(configPath = process.env.TRACKERS_CONFIG_PATH): Trackers {
        if (!configPath) {
            throw new Error("Missing required environment variable: TRACKERS_CONFIG_PATH");
        }

        const resolvedPath = path.isAbsolute(configPath)
            ? configPath
            : path.resolve(process.cwd(), configPath);

        const raw = fs.readFileSync(resolvedPath, "utf8");
        const parsed = JSON.parse(raw) as TrackerConfig[];

        if (!Array.isArray(parsed) || parsed.length === 0) {
            throw new Error(`Invalid tracker config at ${resolvedPath}: expected a non-empty array`);
        }

        return new Trackers(parsed);
    }

    /** Returns only the trackers with a configured passkey. */
    private get activeTrackers(): TrackerConfig[] {
        return this.trackers.filter((tracker) => !!tracker.passkey);
    }

    /**
     * Filters scenes to those that have at least one valid torrent URL
     * from an active tracker.
     * @param scenes - Full list of scenes to filter.
     */
    public filterScenesByTrackers(scenes: Scene[]): Scene[] {
        const activeTrackers = this.activeTrackers;
        return scenes.filter((scene) =>
            activeTrackers.some((tracker) =>
                scene.urls.some(({ url }) => this.isValidTorrentURL(url, tracker))
            )
        );
    }


    /**
     * Returns the highest-priority valid torrent URL from a scene's URL list.
     * Priority is determined by the order of active trackers.
     * @param urls - The scene's URL list.
     * @returns The best matching torrent URL, or `undefined` if none found.
     */
    public findBestTorrentURL(urls: SceneUrl[]): string | undefined {
        const activeTrackers = this.activeTrackers;
        for (const tracker of activeTrackers) {
            const match = urls.find(({ url }) => this.isValidTorrentURL(url, tracker));
            if (match) return match.url;
        }
    }


    public filterTorrentURLs(urls: SceneUrl[]): string[] {
        const orderedURLs: string[] = [];

        for (const tracker of this.activeTrackers) {
            for (const { url } of urls) {
                if (this.isValidTorrentURL(url, tracker)) {
                    orderedURLs.push(url);
                }
            }
        }

        return orderedURLs;

    }

    /**
     * Converts a scene's tracker URL into a local proxy download URL
     * of the form `/download/:tracker/:id`.
     * @param sourceURL - A valid tracker detail page URL from the scene.
     * @returns The proxy URL, or `empty` if the tracker is unrecognised or has no `id` param.
     */
    public createProxyDownloadURL(sourceURL: string) {
        const parsedURL = new URL(sourceURL);
        const id = parsedURL.searchParams.get("id");
        if (!id) return "";

        const sourceHost = normalizeHostname(parsedURL.hostname);
        const tracker = this.trackers.find((t) => normalizeHostname(t.host) === sourceHost);
        if (!tracker) return "";

        return `${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}/download/${tracker.name}/${id}`;
    }

    /**
     * Resolves the direct tracker download URL for a given tracker name and torrent ID.
     * @param trackerName - The tracker's `name` value (e.g. "tracker").
     * @param id - The torrent ID extracted from the URL.
     * @throws {Error} If the tracker name is not recognised.
     * @throws {Error} If the tracker's passkey is not configured.
     */
    public resolveTrackerDownload(trackerName: string, id: string): string {
        const tracker = this.trackersByName.get(trackerName);
        if (!tracker) {
            throw new Error(`Unknown tracker: ${trackerName}`);
        }

        if (!tracker.passkey) {
            throw new Error(`Passkey not configured for tracker: ${trackerName}`);
        }

        return this.buildDownloadURL(tracker, id, tracker.passkey);
    }

    /**
     * Returns `true` if the URL belongs to the tracker's host and points to a valid torrent path.
     */
    private isValidTorrentURL(url: string, tracker: TrackerConfig): boolean {
        return url.includes(tracker.host) && url.includes(tracker.path);
    }

    private buildDownloadURL(tracker: TrackerConfig, id: string, passkey: string): string {
        return tracker.downloadUrlTemplate
            .replaceAll("{id}", encodeURIComponent(id))
            .replaceAll("{passkey}", encodeURIComponent(passkey));
    }


    public async getTorrentFromScene(scene: Scene) {
        const torrentURLs = this.filterTorrentURLs(scene.urls);
        if (torrentURLs.length === 0) {
            return null;
        }

        const [url] = torrentURLs;
        const link = this.createProxyDownloadURL(url);

        return this.cache.getOrSet(scene.id, async () => {
            console.log(`Cache miss for scene "${scene.title}" (${scene.id}), fetching torrent size...`);
            return {
                title: scene.title,
                guid: scene.id,
                link: `${process.env.STASH_BASE_URL}/scenes/${scene.id}`,
                downloadLink: link,
                pubDate: normalizeDate(scene.release_date),
                size: await this.extractTorrentSize(link),
                category: "6000",
                seeders: 0,
                peers: 0,
                studio: scene.studio.name,
                performers: scene.performers.map(p => p.performer.name).join(", "),
                tags: scene.tags.map(t => t.name),
            };
        });
    }

    /**
     * Downloads a torrent via the proxy and returns its total payload size in bytes.
     * @param url - The proxied URL for a torrent.
     * @returns Total size of the torrent payload in bytes.
     * @returns `0` If the URL is unrecognised, the download fails, or the metadata is malformed.
     */
    public async extractTorrentSize(url: string): Promise<number> {
        const response = await fetch(url);
        if (!response.ok) {
            // throw new Error(`Failed to fetch torrent for size caching: ${response.status} ${response.statusText}`);
            console.error(`Failed to fetch torrent for size caching: ${response.status} ${response.statusText}`);
            return 0;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const torrent = torrentDecoder.decode(buffer);
        const size = torrentDecoder.extractSize(torrent);
        return size;
    }
}
