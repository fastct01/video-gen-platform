import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../media/ffmpeg.js';
import { sleep } from '../lib/util.js';
import { ProviderError, type GenerateRequest, type GenerateResult, type VideoProvider } from './types.js';

/**
 * Local fake provider: renders clips with ffmpeg so the whole pipeline (billing, chaining,
 * last-frame extraction, stitching, refunds) can be exercised without paying for an API.
 * Segment 1 is a test pattern; later segments animate the frame they were given, so continuity
 * across seams is visible in the final video.
 */
export class MockProvider implements VideoProvider {
  readonly id = 'mock';
  readonly defaultModel = 'mock-ffmpeg';
  readonly capabilities = {
    minSeconds: 1,
    maxSeconds: 15,
    aspectRatios: ['16:9', '9:16', '1:1'] as ('16:9' | '9:16' | '1:1')[],
    resolutions: ['360p', '720p'],
    defaultResolution: '360p',
    imageToVideo: true,
  };

  constructor(
    readonly tokensPerSecond: number,
    private readonly opts: { delayMs: number; failureRate: number; workDir: string },
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    await sleep(this.opts.delayMs);
    if (Math.random() < this.opts.failureRate) throw new ProviderError('mock: simulated safety rejection', false);
    if (/\bFAIL\b/.test(req.prompt)) throw new ProviderError('mock: prompt contains FAIL', false);

    const h = req.resolution === '720p' ? 720 : 360;
    // The short side is the resolution ("360p" -> 360), like real providers.
    const long = Math.round((h * 16) / 9 / 2) * 2;
    const [width, height] = req.aspectRatio === '9:16' ? [h, long] : req.aspectRatio === '1:1' ? [h, h] : [long, h];

    const dir = path.join(this.opts.workDir, 'mock', req.requestId);
    await mkdir(dir, { recursive: true });
    const out = path.join(dir, 'clip.mp4');
    const freq = 220 + (hash(req.requestId) % 12) * 40;
    const d = String(req.durationSeconds);

    const args = ['-y', '-v', 'error'];
    if (req.firstFrame) {
      const img = path.join(dir, 'first.jpg');
      await writeFile(img, req.firstFrame.data);
      args.push('-loop', '1', '-framerate', '24', '-t', d, '-i', img);
      args.push('-f', 'lavfi', '-t', d, '-i', `sine=frequency=${freq}:sample_rate=48000`);
      // Slowly rotate hue and zoom so each segment visibly evolves from the previous last frame.
      args.push('-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},hue=h=t*25,` +
        `scale=iw*(1+0.02*t):-2:eval=frame,crop=${width}:${height},format=yuv420p`);
    } else {
      args.push('-f', 'lavfi', '-t', d, '-i', `testsrc2=size=${width}x${height}:rate=24`);
      args.push('-f', 'lavfi', '-t', d, '-i', `sine=frequency=${freq}:sample_rate=48000`);
      args.push('-vf', 'format=yuv420p');
    }
    args.push('-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', out);
    try {
      await run('ffmpeg', args, 120_000);
      return { state: 'completed', output: { kind: 'buffer', data: await readFile(out) } };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
