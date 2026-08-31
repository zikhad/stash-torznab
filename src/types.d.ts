type SceneUrl = {
  url: string;
}

type Scene = {
  id: string;
  title: string;
  details: string;
  urls: SceneUrl[];
  release_date: string;
  images: {
    url: string;
  }[];
  studio?: {
    id: string;
    name: string;
  };
  performers: {
    performer: {
      id: string;
      name: string;
      gender: string;
    }
  }[];
  tags: {
    id: string;
    name: string;
  }[];
}

declare module "bencoding" {
  const bencoding: {
    decode(input: Uint8Array | Buffer): unknown;
  };

  export = bencoding;
}