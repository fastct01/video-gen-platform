import { createHmac, timingSafeEqual } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Storage } from './types.js';

/** Stores objects on disk. URLs are HMAC-signed and served by the API at /files/<key>. */
export class LocalStorage implements Storage {
  readonly root: string;

  constructor(root: string, private readonly publicBaseUrl: string, private readonly secret: string) {
    this.root = path.resolve(root);
  }

  resolve(key: string): string {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error('invalid storage key');
    return p;
  }

  async putFile(key: string, localPath: string): Promise<void> {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(localPath, dest);
  }

  async getToFile(key: string, localPath: string): Promise<void> {
    await mkdir(path.dirname(localPath), { recursive: true });
    await copyFile(this.resolve(key), localPath);
  }

  readBuffer(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async getUrl(key: string, ttlSeconds = 3600): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = this.sign(key, exp);
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return `${this.publicBaseUrl}/files/${encoded}?exp=${exp}&sig=${sig}`;
  }

  verify(key: string, exp: number, sig: string): boolean {
    if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
    const expected = Buffer.from(this.sign(key, exp));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private sign(key: string, exp: number): string {
    return createHmac('sha256', this.secret).update(`${key}\n${exp}`).digest('base64url');
  }
}
