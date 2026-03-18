import fs from "node:fs";
import path from "node:path";
import * as bencoding from "bencoding";

import { Cache } from "@components/cache";

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

type ParsedTrackerSource = {
    tracker: TrackerConfig;
    id: string;
};

type TorrentInfoFile = {
    length?: number | bigint;
};

type BDictLike = {
    length: number;
    kget(index: number): unknown;
    vget(index: number): unknown;
};

type DecodedTorrent = {
    info?: {
        length?: number | bigint;
        files?: TorrentInfoFile[];
    };
};

export type SelectedTorrent = {
    sourceUrl: string;
    proxyUrl: string;
    size: number;
};

type TorrentCandidate = {
    sourceUrl: string;
    proxyUrl: string;
    tracker: TrackerConfig;
    id: string;
    priority: number;
};

/** Normalizes tracker hostnames so `www.` aliases compare as the same host. */
function normalizeHostname(hostname: string): string {
    return hostname.replace(/^www\./, "");
}

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
    private readonly torrentSizeCache = new Cache<number>();

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
     * Returns the smallest torrent available from a scene's valid tracker URLs.
     * When sizes are equal, tracker declaration order is used as the tie-breaker.
        * If all size lookups fail, falls back to the first valid candidate by tracker priority.
     * @param urls - The scene's URL list.
     * @returns The selected torrent metadata, or `undefined` if none could be resolved.
     */
    public async findSmallestTorrent(urls: URLs[]): Promise<SelectedTorrent | undefined> {
        const candidates = this.getTorrentCandidates(urls);
        if (candidates.length === 0) {
            return;
        }

        const selections = await Promise.all(
            candidates.map(async (candidate) => {
                try {
                    const size = await this.getTorrentSize(candidate.tracker, candidate.id);
                    return {
                        sourceUrl: candidate.sourceUrl,
                        proxyUrl: candidate.proxyUrl,
                        size,
                        priority: candidate.priority,
                    };
                } catch (error) {
                    console.warn(`Failed to inspect torrent ${candidate.tracker.name}:${candidate.id}`, error);
                    return undefined;
                }
            })
        );

        const validSelections = selections.filter(
            (selection): selection is SelectedTorrent & { priority: number } => selection !== undefined
        );

        if (validSelections.length === 0) {
            const fallback = candidates[0];
            if (!fallback) {
                return;
            }

            console.warn(
                `Falling back to first valid torrent candidate for scene URLs: ${fallback.tracker.name}:${fallback.id}`
            );

            return {
                sourceUrl: fallback.sourceUrl,
                proxyUrl: fallback.proxyUrl,
                size: 0,
            };
        }

        validSelections.sort((left, right) => left.size - right.size || left.priority - right.priority);
        const best = validSelections[0];
        if (!best) {
            return;
        }

        return {
            sourceUrl: best.sourceUrl,
            proxyUrl: best.proxyUrl,
            size: best.size,
        };
    }

    /**
     * Converts a scene's tracker URL into a local proxy download URL
     * of the form `/download/:tracker/:id`.
     * @param sourceURL - A valid tracker detail page URL from the scene.
     * @returns The proxy URL, or `undefined` if the tracker is unrecognised or has no `id` param.
     */
    public createProxyDownloadURL(sourceURL: string): string | undefined {
        const parsedSource = this.parseTrackerSourceURL(sourceURL);
        if (!parsedSource) return;

        return `${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}/download/${parsedSource.tracker.name}/${parsedSource.id}`;
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
        try {
            const parsedURL = new URL(url);
            return normalizeHostname(parsedURL.hostname) === normalizeHostname(tracker.host)
                && parsedURL.pathname.includes(tracker.path);
        } catch {
            return false;
        }
    }

    /**
     * Builds the direct tracker download URL from the configured template.
     * @param tracker - Tracker configuration containing the template.
     * @param id - Torrent identifier used by the tracker.
     * @param passkey - Tracker passkey to inject into the template.
     */
    private buildDownloadURL(tracker: TrackerConfig, id: string, passkey: string): string {
        return tracker.downloadUrlTemplate
            .replaceAll("{id}", encodeURIComponent(id))
            .replaceAll("{passkey}", encodeURIComponent(passkey));
    }

    /**
     * Converts raw scene URLs into unique, fetchable torrent candidates in tracker priority order.
     * @param urls - Raw scene URLs returned by Stash.
     */
    private getTorrentCandidates(urls: URLs[]): TorrentCandidate[] {
        const activeTrackers = this.activeTrackers;
        const seen = new Set<string>();
        const candidates: TorrentCandidate[] = [];

        for (const [priority, tracker] of activeTrackers.entries()) {
            for (const { url } of urls) {
                if (!this.isValidTorrentURL(url, tracker)) {
                    continue;
                }

                const parsedSource = this.parseTrackerSourceURL(url);
                const proxyUrl = this.createProxyDownloadURL(url);
                if (!parsedSource || !proxyUrl) {
                    continue;
                }

                const key = `${parsedSource.tracker.name}:${parsedSource.id}`;
                if (seen.has(key)) {
                    continue;
                }

                seen.add(key);
                candidates.push({
                    sourceUrl: url,
                    proxyUrl,
                    tracker: parsedSource.tracker,
                    id: parsedSource.id,
                    priority,
                });
            }
        }

        return candidates;
    }

    /**
     * Extracts the tracker and torrent id from a tracker detail page URL.
     * @param sourceURL - Tracker detail page URL from a scene.
     */
    private parseTrackerSourceURL(sourceURL: string): ParsedTrackerSource | undefined {
        const parsedURL = new URL(sourceURL);
        const id = parsedURL.searchParams.get("id");
        if (!id) return;

        const sourceHost = normalizeHostname(parsedURL.hostname);
        const tracker = this.trackers.find((candidate) => normalizeHostname(candidate.host) === sourceHost);
        if (!tracker) return;

        return { tracker, id };
    }

    /**
     * Downloads a torrent file and returns its payload size, caching the result by tracker and id.
     * @param tracker - Tracker configuration used to build the download URL.
     * @param id - Torrent identifier on the tracker.
     */
    private async getTorrentSize(tracker: TrackerConfig, id: string): Promise<number> {
        const cacheKey = `${tracker.name}:${id}`;
        return this.torrentSizeCache.getOrSet(cacheKey, async () => {
            const downloadURL = this.buildDownloadURL(tracker, id, tracker.passkey);
            const response = await fetch(downloadURL);

            if (!response.ok) {
                throw new Error(`Tracker download failed with status ${response.status}`);
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            const torrent = bencoding.decode(buffer);
            return this.extractTorrentSize(torrent);
        });
    }

    /**
     * Reads total payload size from decoded torrent metadata.
     * @param torrentData - Decoded bencoded torrent structure.
     */
    private extractTorrentSize(torrentData: unknown): number {
        const torrent = this.normalizeBencodedValue(torrentData) as DecodedTorrent;
        const info = torrent.info;
        if (!info) {
            throw new Error("Torrent metadata is missing the info dictionary");
        }

        if (info.length !== undefined) {
            return this.toSafeNumber(info.length);
        }

        if (Array.isArray(info.files) && info.files.length > 0) {
            return info.files.reduce((total, file) => total + this.toSafeNumber(file.length), 0);
        }

        throw new Error("Torrent metadata does not contain file lengths");
    }

    /**
     * Converts supported numeric torrent length values into a safe JavaScript number.
     * @param value - Parsed torrent length value.
     */
    private toSafeNumber(value: number | bigint | undefined): number {
        if (typeof value === "number") {
            return value;
        }

        if (typeof value === "bigint") {
            if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new Error("Torrent size exceeds Number.MAX_SAFE_INTEGER");
            }
            return Number(value);
        }

        throw new Error("Missing torrent file length");
    }

    /**
     * Recursively converts bencoded values into plain JavaScript values.
     * @param value - Decoded value returned by the bencoding library.
     */
    private normalizeBencodedValue(value: unknown): unknown {
        if (Buffer.isBuffer(value)) {
            return value.toString("utf8");
        }

        if (Array.isArray(value)) {
            return value.map((entry) => this.normalizeBencodedValue(entry));
        }

        if (this.isBDictLike(value)) {
            const result: Record<string, unknown> = {};

            for (let index = 0; index < value.length; index += 1) {
                const key = this.normalizeBencodedKey(value.kget(index));
                result[key] = this.normalizeBencodedValue(value.vget(index));
            }

            return result;
        }

        return value;
    }

    /**
     * Converts a decoded bencoded dictionary key into a string.
     * @param value - Raw key value from the decoder.
     */
    private normalizeBencodedKey(value: unknown): string {
        if (Buffer.isBuffer(value)) {
            return value.toString("utf8");
        }

        if (typeof value === "string") {
            return value;
        }

        throw new Error("Torrent metadata contains a non-string dictionary key");
    }

    /**
     * Returns `true` when the decoded value exposes the bencoding library's dictionary interface.
     * @param value - Decoded value to inspect.
     */
    private isBDictLike(value: unknown): value is BDictLike {
        return typeof value === "object"
            && value !== null
            && "length" in value
            && typeof value.length === "number"
            && "kget" in value
            && typeof value.kget === "function"
            && "vget" in value
            && typeof value.vget === "function";
    }
}
