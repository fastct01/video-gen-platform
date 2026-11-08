import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { decryptSecret, deriveLoginKey, encryptSecret } from '../src/lib/crypto.js';
import { geminiWithKey } from '../src/providers/registry.js';
import { ApiError, planVideo } from '../src/services/videos.js';

describe('secret encryption', () => {
  it('round-trips and never repeats ciphertext', () => {
    const a = encryptSecret('AIza-secret-key');
    const b = encryptSecret('AIza-secret-key');
    expect(a).not.toBe(b);
    expect(a).not.toContain('AIza');
    expect(decryptSecret(a)).toBe('AIza-secret-key');
  });
  it('rejects tampered or foreign values', () => {
    const a = encryptSecret('AIza-secret-key');
    const raw = Buffer.from(a.slice(3), 'base64');
    raw[raw.length - 1]! ^= 1;
    expect(decryptSecret(`v1:${raw.toString('base64')}`)).toBeNull();
    expect(decryptSecret('plaintext')).toBeNull();
  });
});

describe('deriveLoginKey', () => {
  it('is stable per provider key and different across keys', () => {
    expect(deriveLoginKey('AIza-one')).toBe(deriveLoginKey('AIza-one'));
    expect(deriveLoginKey('AIza-one')).not.toBe(deriveLoginKey('AIza-two'));
    expect(deriveLoginKey('AIza-one')).toMatch(/^vk_[\w-]{40,}$/);
  });
});

describe('planVideo with the user\'s own Gemini key', () => {
  const own = { ownGemini: geminiWithKey('AIza-test-key') };
  const input = { prompt: 'x', aspectRatio: '16:9' as const, mode: 'duration' as const, targetSeconds: 20, requireFullBalance: false };

  it('defaults to Gemini on the own key and costs 0 tokens', () => {
    const plan = planVideo(input, 0, own);
    expect(plan.provider.id).toBe('gemini');
    expect(plan.ownKey).toBe(true);
    expect(plan.tokensPerSecond).toBe(0);
    expect(plan.estimatedTokens).toBe(0);
    expect(plan.firstSegmentTokens).toBe(0);
  });

  it('until_balance with an own key is bounded by maxSegments, not the (zero) balance', () => {
    const plan = planVideo({ ...input, mode: 'until_balance', targetSeconds: undefined, maxSegments: 3 }, 0, own);
    expect(plan.maxSegments).toBe(3);
    expect(plan.segmentDurations).toHaveLength(3);
  });

  it.skipIf(!config.MOCK_PROVIDER_ENABLED)('an explicitly chosen server provider is billed in tokens as usual', () => {
    const plan = planVideo({ ...input, provider: 'mock' }, 100, own);
    expect(plan.ownKey).toBe(false);
    expect(plan.tokensPerSecond).toBe(config.MOCK_TOKENS_PER_SECOND);
  });

  it.skipIf(!!config.GEMINI_API_KEY)('asks for a key when Gemini is requested without one', () => {
    expect(() => planVideo({ ...input, provider: 'gemini' }, 100)).toThrow(ApiError);
    expect(() => planVideo({ ...input, provider: 'gemini' }, 100)).toThrow(/connect your Gemini API key/);
  });
});
