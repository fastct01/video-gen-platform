export interface Storage {
  putFile(key: string, localPath: string, contentType: string): Promise<void>;
  getToFile(key: string, localPath: string): Promise<void>;
  readBuffer(key: string): Promise<Buffer>;
  /** Time-limited URL a browser (or a provider that needs an image URL) can fetch. */
  getUrl(key: string, ttlSeconds?: number): Promise<string>;
}
