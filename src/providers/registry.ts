import path from 'node:path';
import { config } from '../config.js';
import { GeminiProvider } from './gemini.js';
import { MockProvider } from './mock.js';
import type { VideoProvider } from './types.js';

/**
 * Provider registry. A provider is available when its key is configured.
 * Add new providers here, e.g.:
 *   if (config.RUNWAY_API_KEY) providers.set('runway', new RunwayProvider({...}))
 */
const providers = new Map<string, VideoProvider>();

let geminiKey: string | undefined;

/**
 * (Re)registers the Gemini provider with this key. Called at startup with GEMINI_API_KEY and again
 * whenever a key saved from the UI (app_settings) changes; see src/providers/settings.ts.
 */
export function setGeminiKey(apiKey: string | undefined): void {
  if (apiKey === geminiKey) return;
  geminiKey = apiKey;
  if (!apiKey) {
    providers.delete('gemini');
    return;
  }
  providers.set(
    'gemini',
    new GeminiProvider({
      apiKey,
      model: config.GEMINI_MODEL,
      baseUrl: config.GEMINI_BASE_URL,
      tokensPerSecond: config.GEMINI_TOKENS_PER_SECOND,
      requestTimeoutMs: config.GEMINI_REQUEST_TIMEOUT_MS,
    }),
  );
}

setGeminiKey(config.GEMINI_API_KEY);

if (config.MOCK_PROVIDER_ENABLED) {
  providers.set(
    'mock',
    new MockProvider(config.MOCK_TOKENS_PER_SECOND, {
      delayMs: config.MOCK_DELAY_MS,
      failureRate: config.MOCK_FAILURE_RATE,
      workDir: path.resolve(config.TMP_DIR),
    }),
  );
}

export function getProvider(id: string): VideoProvider | undefined {
  return providers.get(id);
}

export function listProviders(): VideoProvider[] {
  return [...providers.values()];
}

export function defaultProviderId(): string | undefined {
  if (providers.has(config.DEFAULT_PROVIDER)) return config.DEFAULT_PROVIDER;
  return providers.keys().next().value;
}
