type URLs = {
  url: string;
}

declare module "bencoding" {
  const bencoding: {
    decode(input: Uint8Array | Buffer): unknown;
  };

  export = bencoding;
}

type Scene = {
  id: string;
  title: string;
  details: string;
  urls: URLs[];
  release_date: string;
  images: URLs[];
  studio: {
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