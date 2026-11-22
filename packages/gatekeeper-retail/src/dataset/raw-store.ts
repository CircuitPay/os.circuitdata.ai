// Raw record store (research R10). The original CSV files and provider pages are kept so any mapping
// can be rebuilt without re-fetching. The dataset Durable Object indexes every object in
// `raw_objects` and counts its bytes against the dataset's quota; this module only moves bytes.

/** Default raw-storage quota per dataset (`RETAIL_RAW_QUOTA_BYTES` overrides it). */
export const DEFAULT_RAW_QUOTA_BYTES = 20 * 1024 ** 3;

/** Objects deleted per erase step; one R2 list page. */
export const ERASE_BATCH_SIZE = 1_000;

/** The R2 prefix holding everything of one dataset. */
export function datasetPrefix(datasetId: string): string {
  return `ds/${datasetId}/`;
}

/** The key of one raw object: `ds/<datasetId>/src/<sourceId>/run/<runId>/<seq>`. */
export function rawObjectKey(datasetId: string, sourceId: number, runId: number, seq: number): string {
  return `${datasetPrefix(datasetId)}src/${sourceId}/run/${runId}/${seq}`;
}

/** What storing one object produced. */
export type StoredRawObject = { bytes: number; sha256: string };

/** Byte storage for raw records. The R2 implementation is the default; research R10 names the fallback. */
export interface RawStore {
  /** Stores exactly `size` bytes under `key`, returning their SHA-256. Fails if the stream is shorter or longer. */
  put(key: string, body: ReadableStream<Uint8Array>, size: number): Promise<StoredRawObject>;
  /** Reads an object, or the byte range of it, or null when it is gone. */
  get(key: string, range?: { offset: number; length: number }): Promise<ReadableStream<Uint8Array> | null>;
  /** Deletes up to `limit` objects under `prefix`; `done` once nothing is left. */
  deletePrefix(prefix: string, limit: number): Promise<{ deleted: number; done: boolean }>;
}

/** `RawStore` over the `RETAIL_RAW` R2 bucket. */
export class R2RawStore implements RawStore {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  async put(key: string, body: ReadableStream<Uint8Array>, size: number): Promise<StoredRawObject> {
    const [forHash, forBucket] = body.tee();
    const digest = new crypto.DigestStream("SHA-256");
    const length = new FixedLengthStream(size);
    const [hash] = await Promise.all([
      forHash.pipeTo(digest).then(() => digest.digest),
      forBucket.pipeTo(length.writable),
      this.#bucket.put(key, length.readable),
    ]);
    const sha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    return { bytes: size, sha256 };
  }

  async get(key: string, range?: { offset: number; length: number }): Promise<ReadableStream<Uint8Array> | null> {
    const object = await this.#bucket.get(key, range ? { range } : undefined);
    return object?.body ?? null;
  }

  async deletePrefix(prefix: string, limit: number): Promise<{ deleted: number; done: boolean }> {
    const listed = await this.#bucket.list({ prefix, limit });
    if (listed.objects.length > 0) await this.#bucket.delete(listed.objects.map(object => object.key));
    return { deleted: listed.objects.length, done: !listed.truncated };
  }
}
