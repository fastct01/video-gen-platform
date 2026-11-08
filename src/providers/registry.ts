import { createHash } from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';
import { GEMINI_CAPABILITIES, GeminiProvider } from './gemini.js';
import { MockProvider } from './mock.js';
import type { VideoProvider } from './types.js';

/**
 * Server-wide providers: available to every user and billed in tokens. A provider is available when
 * its key is configured in the environment. Add new providers here, e.g.:
 *   if (config.RUNWAY_API_KEY) providers.set('runway', new RunwayProvider({...}))
 *
 * Users can also bring their own Gemini key (see ./user-keys.ts); that provider is built per user
 * with geminiWithKey() and costs 0 tokens, because Google bills the key's owner directly.
 */
const providers = new Map<string, VideoProvider>();

function gemini(apiKey: string, tokensPerSecond: number): GeminiProvider {
  return new GeminiProvider({
    apiKey,
    model: config.GEMINI_MODEL,
    baseUrl: config.GEMINI_BASE_URL,
    tokensPerSecond,
    requestTimeoutMs: config.GEMINI_REQUEST_TIMEOUT_MS,
  });
}

if (config.GEMINI_API_KEY) providers.set('gemini', gemini(config.GEMINI_API_KEY, config.GEMINI_TOKENS_PER_SECOND));

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

/** Capabilities by provider id, including providers only available through users' own keys. */
export function providerCapabilities(id: string): VideoProvider['capabilities'] | undefined {
  return providers.get(id)?.capabilities ?? (id === 'gemini' ? GEMINI_CAPABILITIES : undefined);
}

// One instance per user key (each holds an HTTP connection pool). Bounded so it can't grow forever.
const ownKeyProviders = new Map<string, GeminiProvider>();

/** Gemini with a user's own key. 0 tokens per second: the key's owner pays Google directly. */
export function geminiWithKey(apiKey: string): VideoProvider {
  const id = createHash('sha256').update(apiKey).digest('hex');
  let p = ownKeyProviders.get(id);
  if (!p) {
    if (ownKeyProviders.size >= 200) ownKeyProviders.delete(ownKeyProviders.keys().next().value!);
    p = gemini(apiKey, 0);
    ownKeyProviders.set(id, p);
  }
  return p;
}
