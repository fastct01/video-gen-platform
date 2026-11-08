import { Agent, fetch } from 'undici';
import { isRetryableStatus, readErrorBody } from '../lib/http.js';
import { sleep } from '../lib/util.js';
import {
  ProviderError,
  type GenerateRequest,
  type GenerateResult,
  type VideoOutput,
  type VideoProvider,
} from './types.js';

/**
 * Google Gemini API, video generation through the Interactions API (gemini-omni-*).
 *
 *   POST {base}/v1beta/interactions   (x-goog-api-key)
 *   -> { id, status, steps: [{ type: 'model_output', content: [{ type: 'video', mime_type, data | uri }] }] }
 *
 * The call is synchronous: it returns once the clip is rendered, which can take minutes.
 * With delivery "uri" the clip is a Files API resource we wait on (state ACTIVE) and download.
 *
 * Long videos are built by chaining: segment N+1 gets segment N's last frame as an image input.
 * Native extension (previous_interaction_id) is capped at 30 s total, so it isn't used here.
 */
export interface GeminiOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  tokensPerSecond: number;
  requestTimeoutMs: number;
}

export const GEMINI_CAPABILITIES = {
  // Plain text-to-video allows 3-15 s, but image input (used for chaining) is limited to 3-10 s.
  minSeconds: 3,
  maxSeconds: 10,
  aspectRatios: ['16:9', '9:16'] as ('16:9' | '9:16')[],
  resolutions: ['360p', '720p', '1080p', '4k'],
  defaultResolution: '720p',
  imageToVideo: true,
};

export class GeminiProvider implements VideoProvider {
  readonly id = 'gemini';
  readonly defaultModel: string;
  readonly tokensPerSecond: number;
  readonly capabilities = GEMINI_CAPABILITIES;

  // Node's default fetch aborts if response headers take > 5 min; generation can take longer.
  private readonly dispatcher: Agent;

  constructor(private readonly opts: GeminiOptions) {
    this.defaultModel = opts.model;
    this.tokensPerSecond = opts.tokensPerSecond;
    this.dispatcher = new Agent({
      headersTimeout: opts.requestTimeoutMs,
      bodyTimeout: opts.requestTimeoutMs,
      connectTimeout: 30_000,
    });
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const input = req.firstFrame
      ? [
          { type: 'image', data: req.firstFrame.data.toString('base64'), mime_type: req.firstFrame.mimeType },
          { type: 'text', text: req.prompt },
        ]
      : req.prompt;

    const body = {
      model: req.model ?? this.opts.model,
      input,
      response_format: {
        type: 'video',
        duration: `${req.durationSeconds}s`,
        aspect_ratio: req.aspectRatio,
        resolution: req.resolution,
        delivery: 'uri',
      },
      // Required by the API: video delivery "uri" is rejected with store=false
      // ("store=true is required when response format has video delivery set to URI").
      store: true,
    };

    let res;
    try {
      res = await fetch(`${this.opts.baseUrl}/v1beta/interactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
        body: JSON.stringify(body),
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs),
      });
    } catch (err) {
      throw new ProviderError(`gemini request failed: ${(err as Error).message}`, true);
    }

    if (!res.ok) {
      const msg = await readErrorBody(res);
      const fatal = res.status === 401 || res.status === 403 || res.status === 404;
      throw new ProviderError(`gemini HTTP ${res.status}: ${msg}`, isRetryableStatus(res.status), fatal, res.status);
    }

    const json = (await res.json()) as unknown;
    const video = extractVideo(json);
    if (!video) {
      const status = (json as { status?: string })?.status;
      const text = extractText(json);
      throw new ProviderError(
        `gemini returned no video (status=${status ?? 'unknown'})${text ? `: ${text.slice(0, 300)}` : ''}`,
        false,
      );
    }

    if (video.data) return { state: 'completed', output: { kind: 'buffer', data: Buffer.from(video.data, 'base64') } };
    return { state: 'completed', output: await this.fileOutput(video.uri!) };
  }

  /** Waits for a Files API resource to become ACTIVE and returns an authenticated download URL. */
  private async fileOutput(uri: string): Promise<VideoOutput> {
    const fileId = parseFileId(uri);
    const headers = { 'x-goog-api-key': this.opts.apiKey };
    if (!fileId) return { kind: 'url', url: uri, headers };

    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      const r = await fetch(`${this.opts.baseUrl}/v1beta/files/${fileId}`, { headers, signal: AbortSignal.timeout(30_000) }).catch(
        (err: Error) => {
          throw new ProviderError(`gemini file status failed: ${err.message}`, true);
        },
      );
      if (!r.ok) {
        throw new ProviderError(`gemini file status HTTP ${r.status}: ${await readErrorBody(r)}`, isRetryableStatus(r.status));
      }
      const file = (await r.json()) as { state?: string; error?: { message?: string } };
      if (file.state === 'ACTIVE' || file.state === undefined) break;
      if (file.state === 'FAILED') throw new ProviderError(`gemini file processing failed: ${file.error?.message ?? ''}`, false);
      if (Date.now() > deadline) throw new ProviderError('gemini file never became ACTIVE', true);
      await sleep(2000);
    }
    return { kind: 'url', url: `${this.opts.baseUrl}/v1beta/files/${fileId}:download?alt=media`, headers };
  }
}

interface ContentPart {
  type?: string;
  data?: string;
  uri?: string;
  text?: string;
  mime_type?: string;
}

function allContent(json: unknown): ContentPart[] {
  const j = json as { steps?: { type?: string; content?: ContentPart[] }[]; outputs?: ContentPart[] };
  const parts: ContentPart[] = [];
  for (const step of j?.steps ?? []) if (step.type !== 'user_input') parts.push(...(step.content ?? []));
  parts.push(...(j?.outputs ?? []));
  return parts;
}

/** Finds the generated video in an interaction response. Exported for tests. */
export function extractVideo(json: unknown): { data?: string; uri?: string } | null {
  const v = allContent(json)
    .reverse()
    .find((p) => p.type === 'video' && (p.data || p.uri));
  return v ? { data: v.data, uri: v.uri } : null;
}

export function extractText(json: unknown): string {
  return allContent(json)
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join(' ');
}

/** ".../v1beta/files/abc123:download?alt=media" -> "abc123" */
export function parseFileId(uri: string): string | null {
  const m = /files\/([^/:?#]+)/.exec(uri);
  return m ? m[1]! : null;
}
