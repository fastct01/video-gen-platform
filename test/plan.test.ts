import { describe, expect, it } from 'vitest';
import { plannedSegmentSeconds, promptForSegment } from '../src/db/repo.js';

describe('plannedSegmentSeconds', () => {
  const v = { mode: 'duration' as const, segment_seconds: 8, target_seconds: 30, max_segments: 100 };
  it('fills full segments then a shorter tail', () => {
    expect([0, 1, 2, 3, 4].map((i) => plannedSegmentSeconds(v, i, 3))).toEqual([8, 8, 8, 6, null]);
  });
  it('respects the provider minimum on the tail', () => {
    expect(plannedSegmentSeconds({ ...v, target_seconds: 17 }, 2, 3)).toBe(3);
  });
  it('until_balance runs to max_segments', () => {
    const u = { mode: 'until_balance' as const, segment_seconds: 8, target_seconds: null, max_segments: 2 };
    expect([0, 1, 2].map((i) => plannedSegmentSeconds(u, i, 3))).toEqual([8, 8, null]);
  });
});

describe('promptForSegment', () => {
  it('cycles the storyboard', () => {
    const v = { prompt: 'base', segment_prompts: ['a', 'b'] };
    expect([0, 1, 2].map((i) => promptForSegment(v, i))).toEqual(['a', 'b', 'a']);
    expect(promptForSegment({ prompt: 'base', segment_prompts: null }, 5)).toBe('base');
  });
});
