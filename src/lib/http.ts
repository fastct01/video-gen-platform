import { createWriteStream } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { VideoOutput } from '../providers/types.js';
import { ProviderError } from '../providers/types.js';

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/** Writes a provider output (bytes, URL or local file) to dest. */
export async function saveVideoOutput(output: VideoOutput, dest: string): Promise<void> {
  switch (output.kind) {
    case 'buffer':
      await writeFile(dest, output.data);
      return;
    case 'file':
      await copyFile(output.path, dest);
      return;
    case 'url': {
      const res = await fetch(output.url, { headers: output.headers, redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok || !res.body) {
        throw new ProviderError(`download failed: HTTP ${res.status}`, isRetryableStatus(res.status), false, res.status);
      }
      await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(dest));
      return;
    }
  }
}

export async function readErrorBody(res: { text(): Promise<string> }): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text);
    return String(j?.error?.message ?? j?.message ?? text).slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}
