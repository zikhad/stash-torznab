import { Cache } from "./cache";

type CountResponse = {
    data: { queryScenes: { count: number } };
    errors?: unknown[];
};

type ScenesResponse = {
    data: { queryScenes: { scenes: Scene[] } };
    errors?: unknown[];
};

type FetchScenesInput = {
    title?: string;
};

type QueryVariables = {
    input: {
        title?: string;
        per_page?: number;
    };
};

/**
 * Client for querying the Stash GraphQL API with cached scene lookups.
 */
export class StashExtractor {
    private readonly cache = new Cache<Scene[]>();

    private readonly countQuery = `
        query getCount($input: SceneQueryInput!) {
            queryScenes(input: $input) {
                count
            }
        }
    `;

    private readonly scenesQuery = `
        query queryScenes($input: SceneQueryInput!) {
            queryScenes(input: $input) {
                scenes {
                    id
                    title
                    details
                    release_date
                    images {
                        url
                    }
                    studio {
                        id
                        name
                    }
                    performers {
                        performer {
                            id
                            name
                            gender
                        }
                    }
                    urls {
                        url
                    }
                    tags {
                        id
                        name
                    }
                }
            }
        }
    `;

    /**
     * Fetches scenes from Stash, caching results by title query.
     * @param input - Optional scene query filters.
     */
    public async fetchScenes(input: FetchScenesInput = {}): Promise<Scene[]> {
        const cacheKey = input.title ?? "__all__";
        return this.cache.getOrSet(cacheKey, async () => {
            const baseInput = { title: input.title };

            const { data: { queryScenes: { count } } } = await this.graphql<CountResponse>(
                this.countQuery,
                { input: baseInput }
            );

            const { data: { queryScenes: { scenes } } } = await this.graphql<ScenesResponse>(
                this.scenesQuery,
                { input: { ...baseInput, per_page: count } }
            );

            return scenes;
        });
    }

    /** Retrieves the Stash API key from environment variables. */
    private getApiKey(): string {
        const key = process.env.STASH_API_KEY;
        if (!key) throw new Error("Missing STASH_API_KEY in .env");
        return key;
    }

    /**
     * Executes a GraphQL request against Stash.
     * @param query - GraphQL query string.
     * @param variables - Query variables payload.
     */
    private async graphql<T>(query: string, variables: QueryVariables): Promise<T> {
        const res = await fetch(`${process.env.STASH_BASE_URL}/graphql`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ApiKey: this.getApiKey(),
            },
            body: JSON.stringify({ query, variables }),
        });
        const json = (await res.json()) as T & { errors?: unknown[] };
        if (json.errors) {
            console.error(json.errors);
            throw new Error("GraphQL error");
        }
        return json;
    }
}
