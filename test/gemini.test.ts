import { describe, expect, it } from 'vitest';
import { extractText, extractVideo, parseFileId } from '../src/providers/gemini.js';

describe('gemini response parsing', () => {
  it('finds a uri video in model_output steps', () => {
    const res = {
      id: 'v1_x',
      status: 'completed',
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: 'a cat' }] },
        { type: 'thought', content: [] },
        { type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123' }] },
      ],
    };
    expect(extractVideo(res)).toEqual({ data: undefined, uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123' });
  });
  it('finds inline data and ignores user input', () => {
    const res = { steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }, { type: 'video', data: 'AAAA' }] }] };
    expect(extractVideo(res)?.data).toBe('AAAA');
  });
  it('returns null and surfaces text when the model refused', () => {
    const res = { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I cannot generate that.' }] }] };
    expect(extractVideo(res)).toBeNull();
    expect(extractText(res)).toContain('cannot');
  });
  it('parses file ids', () => {
    expect(parseFileId('https://x/v1beta/files/abc-1:download?alt=media')).toBe('abc-1');
    expect(parseFileId('files/zzz')).toBe('zzz');
    expect(parseFileId('https://example.com/video.mp4')).toBeNull();
  });
});
