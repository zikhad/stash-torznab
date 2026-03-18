import * as bencoding from "bencoding";

type BDictLike = {
    length: number;
    kget(index: number): unknown;
    vget(index: number): unknown;
};

type TorrentInfo = {
    /** Total size in bytes for single-file torrents. */
    length?: number;
    /** File list for multi-file torrents. */
    files?: { length?: number }[];
};

type DecodedTorrent = {
    info?: TorrentInfo;
};

/**
 * Thin wrapper around the `bencoding` library that decodes `.torrent` file buffers
 * and normalises the raw output into plain JavaScript values.
 */
export class TorrentDecoder {
    /**
     * Decodes a raw `.torrent` buffer and normalises the result into a plain object.
     * @param buffer - Raw bytes of a `.torrent` file.
     */
    public decode(buffer: Buffer): DecodedTorrent {
        const raw = bencoding.decode(buffer);
        return this.normalizeValue(raw) as DecodedTorrent;
    }

    /**
     * Extracts the total payload size in bytes from a decoded torrent.
     * @param torrent - Decoded torrent returned by `decode`.
     * @throws {Error} If the info dictionary is missing or contains no length data.
     */
    public extractSize(torrent: DecodedTorrent): number {
        const info = torrent.info;
        if (!info) {
            // throw new Error("Torrent metadata is missing the info dictionary");
            console.error("Torrent metadata is missing the info dictionary");
            return 0;
        }
        
        if (typeof info.length === "number") {
            return info.length;
        }

        if (Array.isArray(info.files) && info.files.length > 0) {
            return info.files.reduce((total, file) => {
                if (typeof file.length !== "number") {
                    console.error("Torrent file entry is missing a length field");
                    return total;
                }
                return total + file.length;
            }, 0);
        }

        console.error("Torrent metadata does not contain file lengths");
        return 0;
    }

    /** Recursively converts all bencoded values into plain JavaScript values. */
    private normalizeValue(value: unknown): unknown {
        if (Buffer.isBuffer(value)) {
            return value.toString("utf8");
        }

        if (Array.isArray(value)) {
            return value.map((entry) => this.normalizeValue(entry));
        }

        if (this.isBDictLike(value)) {
            const result: Record<string, unknown> = {};
            for (let i = 0; i < value.length; i++) {
                const rawKey = value.kget(i);
                const key = Buffer.isBuffer(rawKey) ? rawKey.toString("utf8") : String(rawKey);
                result[key] = this.normalizeValue(value.vget(i));
            }
            return result;
        }

        return value;
    }

    /**
     * Returns `true` when a decoded value matches the bencoding dictionary interface.
     * @param value - Decoded value candidate.
     */
    private isBDictLike(value: unknown): value is BDictLike {
        return (
            typeof value === "object" &&
            value !== null &&
            "length" in value &&
            typeof (value as BDictLike).length === "number" &&
            typeof (value as BDictLike).kget === "function" &&
            typeof (value as BDictLike).vget === "function"
        );
    }
}
