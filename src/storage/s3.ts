import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Storage } from './types.js';

export class S3Storage implements Storage {
  private readonly client: S3Client;

  constructor(private readonly bucket: string, opts: { region: string; endpoint?: string; forcePathStyle: boolean }) {
    this.client = new S3Client({ region: opts.region, endpoint: opts.endpoint, forcePathStyle: opts.forcePathStyle });
  }

  async putFile(key: string, localPath: string, contentType: string): Promise<void> {
    // Multipart upload: handles multi-GB final videos without buffering them in memory.
    await new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: createReadStream(localPath), ContentType: contentType },
    }).done();
  }

  async getToFile(key: string, localPath: string): Promise<void> {
    await mkdir(path.dirname(localPath), { recursive: true });
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    await pipeline(res.Body as Readable, createWriteStream(localPath));
  }

  async readBuffer(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  getUrl(key: string, ttlSeconds = 3600): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSeconds });
  }
}
