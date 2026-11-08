/**
 * Provider contract. To add a new video API (Runway, Luma, Kling, a self-hosted Wan/LTX server...):
 *   1. implement VideoProvider in src/providers/<name>.ts
 *   2. register it in src/providers/registry.ts behind its env key
 * Nothing else in the pipeline needs to change.
 *
 * Providers may be synchronous (generate() returns the finished clip, e.g. Gemini Omni) or
 * asynchronous (generate() returns a job id and the worker calls poll() until it finishes).
 */

export type AspectRatio = '16:9' | '9:16' | '1:1';

export interface ProviderCapabilities {
  minSeconds: number;
  maxSeconds: number;
  aspectRatios: AspectRatio[];
  resolutions: string[];
  defaultResolution: string;
  /** Can take an image as the first frame. Required for continuous chaining beyond segment 1. */
  imageToVideo: boolean;
}

export interface GenerateRequest {
  prompt: string;
  durationSeconds: number;
  aspectRatio: AspectRatio;
  resolution: string;
  model?: string;
  /** Last frame of the previous segment; absent for the first segment. */
  firstFrame?: { data: Buffer; mimeType: string };
  /** Stable id for logs and for providers that accept an idempotency key. */
  requestId: string;
}

export type VideoOutput =
  | { kind: 'buffer'; data: Buffer }
  | { kind: 'url'; url: string; headers?: Record<string, string> }
  | { kind: 'file'; path: string };

export type GenerateResult = { state: 'completed'; output: VideoOutput } | { state: 'pending'; jobId: string };

export type PollResult =
  | { state: 'pending' }
  | { state: 'completed'; output: VideoOutput }
  | { state: 'failed'; reason: string; retryable: boolean };

export interface VideoProvider {
  readonly id: string;
  readonly defaultModel: string;
  /** Internal SaaS tokens charged per second of generated video. */
  readonly tokensPerSecond: number;
  readonly capabilities: ProviderCapabilities;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  poll?(jobId: string): Promise<PollResult>;
}

/**
 * Thrown by providers.
 *  retryable=true  -> transient (network, 429, 5xx): the job is retried with backoff.
 *  retryable=false -> the provider rejected this request (safety filter, bad input):
 *                     the segment is re-attempted a few times, then refunded.
 *  fatal=true      -> retrying can never help (invalid API key, unknown model): stop immediately.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly fatal = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
